'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const ENGINE_EVENT_CHANNEL = 'engine:event';
const ENGINE_METER_CHANNEL = 'engine:meter';
const ENGINE_METER_ACK_CHANNEL = 'engine:meter-ack';

class FakeRequestError extends Error {}
class FakeRequestTimeoutError extends Error {}
class FakeSafeStopTimeoutError extends Error {}
class FakeUnsafeStopError extends Error {}

class FakeEngineClient extends EventEmitter {
  constructor() {
    super();
    this.runningValue = false;
    globalThis.meterIntegrationEngine = this;
  }

  get running() { return this.runningValue; }

  async start() { this.runningValue = true; }

  async stop() {
    this.runningValue = false;
    this.emit('stopped', { safe: true, code: 0, signal: null });
  }

  async forceStop() { this.runningValue = false; }

  async request(command) {
    if (command === 'get_state_optional') return { active: false };
    if (command === 'hello') return { protocol_version: 1 };
    return {};
  }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.loading = false;
    this.messages = [];
  }

  isDestroyed() { return this.destroyed; }
  isLoading() { return this.loading; }

  send(channel, ...args) {
    if (this.destroyed) throw new Error('renderer is destroyed');
    this.messages.push({ channel, args });
  }
}

class FakeBrowserWindow extends EventEmitter {
  static instances = [];

  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.renderer = new FakeWebContents();
    FakeBrowserWindow.instances.push(this);
  }

  get webContents() {
    if (this.destroyed) throw new TypeError('Object has been destroyed');
    return this.renderer;
  }

  isDestroyed() { return this.destroyed; }
  isFocused() { return true; }
  isMinimized() { return false; }
  removeMenu() {}
  async loadFile() {}
  async loadURL() {}
  show() {}
  focus() {}
  restore() {}
  hide() {}
  setTitle() {}
  setProgressBar() {}
  flashFrame() {}

  close() { this.destroy(); }

  destroy() {
    if (this.destroyed) return;
    this.renderer.destroyed = true;
    this.destroyed = true;
    this.emit('closed');
  }
}

class FakeTray extends EventEmitter {
  setToolTip() {}
  setContextMenu() {}
  destroy() {}
}

function meter(sequence, patch = {}) {
  return {
    protocol_version: 1,
    event: 'meter',
    payload: {
      sequence,
      faulted: false,
      overflow_samples: 0,
      storage_status: 'healthy',
      ...patch,
    },
  };
}

function messagesOn(webContents, channel) {
  return webContents.messages.filter((message) => message.channel === channel);
}

function deliveredMeter(message) {
  return message.args[1];
}

async function waitFor(predicate, label, attempts = 1_000) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databaker-meter-main-')));
  process.env.DATABAKER_DEFAULT_OUTPUT = root;
  const ipcHandlers = new Map();
  const ipcListeners = new Map();
  const appListeners = new Map();

  const electronStub = {
    app: {
      isPackaged: false,
      requestSingleInstanceLock: () => true,
      whenReady: () => Promise.resolve(),
      on: (name, listener) => appListeners.set(name, listener),
      quit: () => undefined,
      getPath: () => root,
      getAppPath: () => process.cwd(),
      setBadgeCount: () => undefined,
    },
    systemPreferences: {
      getMediaAccessStatus: () => 'granted',
      askForMediaAccess: async () => true,
    },
    BrowserWindow: FakeBrowserWindow,
    dialog: {
      showMessageBox: async () => ({ response: 0 }),
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    ipcMain: {
      handle: (name, listener) => ipcHandlers.set(name, listener),
      on: (name, listener) => ipcListeners.set(name, listener),
    },
    Menu: { buildFromTemplate: (template) => template },
    nativeImage: { createFromDataURL: () => ({ setTemplateImage: () => undefined }) },
    screen: {
      getPrimaryDisplay: () => ({ id: 1, workArea: { width: 1_920, height: 1_080 } }),
      getAllDisplays: () => [],
    },
    shell: { openPath: async () => '' },
    Tray: FakeTray,
  };

  const originalLoad = Module._load;
  Module._load = function loadWithStubs(request, parent, isMain) {
    if (request === 'electron') return electronStub;
    if (request === './engine-client'
      && parent?.filename.endsWith(`${path.sep}dist-electron${path.sep}main.js`)) {
      return {
        EngineClient: FakeEngineClient,
        EngineRequestError: FakeRequestError,
        EngineRequestTimeoutError: FakeRequestTimeoutError,
        EngineSafeStopTimeoutError: FakeSafeStopTimeoutError,
        EngineUnsafeStopError: FakeUnsafeStopError,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require('../dist-electron/main.js');
  } finally {
    Module._load = originalLoad;
  }

  try {
    await waitFor(
      () => globalThis.meterIntegrationEngine
        && FakeBrowserWindow.instances.length === 1
        && ipcListeners.has(ENGINE_METER_ACK_CHANNEL),
      'main-process meter IPC setup',
    );
    const engine = globalThis.meterIntegrationEngine;
    const firstWindow = FakeBrowserWindow.instances[0];
    const firstRenderer = firstWindow.webContents;
    const acknowledge = ipcListeners.get(ENGINE_METER_ACK_CHANNEL);

    assert.equal(
      firstWindow.options?.webPreferences?.backgroundThrottling,
      false,
      'the live meter and WebGL scope must not be throttled when the recording window loses focus',
    );

    engine.emit('event', meter(1));
    engine.emit('event', meter(2, { faulted: true, fault_kind: 'device_unavailable' }));
    engine.emit('event', meter(3, { overflow_samples: 256 }));
    engine.emit('event', meter(4, { storage_status: 'critical' }));

    let deliveries = messagesOn(firstRenderer, ENGINE_METER_CHANNEL);
    assert.equal(deliveries.length, 1, 'all meter variants share one bounded in-flight lane');
    assert.equal(deliveredMeter(deliveries[0]).payload.sequence, 1);
    assert.equal(
      messagesOn(firstRenderer, ENGINE_EVENT_CHANNEL).length,
      0,
      'fault/overflow/critical meter packets cannot bypass the ACK lane',
    );

    acknowledge({ sender: firstRenderer }, deliveries[0].args[0]);
    deliveries = messagesOn(firstRenderer, ENGINE_METER_CHANNEL);
    assert.equal(deliveries.length, 2, 'ACK releases exactly one latest pending meter');
    assert.equal(deliveredMeter(deliveries[1]).payload.sequence, 4);
    acknowledge({ sender: firstRenderer }, deliveries[1].args[0]);

    engine.emit('event', meter(5));
    engine.emit('event', meter(6));
    const beforeLifecycle = messagesOn(firstRenderer, ENGINE_METER_CHANNEL);
    const lifecycle = { protocol_version: 1, event: 'engine_recovery_failed', payload: {} };
    engine.emit('event', lifecycle);
    assert.equal(messagesOn(firstRenderer, ENGINE_EVENT_CHANNEL).at(-1).args[0], lifecycle);
    acknowledge({ sender: firstRenderer }, beforeLifecycle.at(-1).args[0]);
    assert.equal(
      messagesOn(firstRenderer, ENGINE_METER_CHANNEL).length,
      beforeLifecycle.length,
      'an authoritative lifecycle event discards an older unsent meter',
    );

    engine.emit('event', meter(7));
    engine.emit('event', meter(8));
    deliveries = messagesOn(firstRenderer, ENGINE_METER_CHANNEL);
    const preNavigationDelivery = deliveries.at(-1);
    firstRenderer.loading = true;
    firstRenderer.emit('did-start-loading');
    engine.emit('event', meter(9));
    assert.equal(
      messagesOn(firstRenderer, ENGINE_METER_CHANNEL).length,
      deliveries.length,
      'meters are dropped while navigation has no durable preload receiver',
    );

    firstRenderer.loading = false;
    engine.emit('event', meter(10));
    engine.emit('event', meter(11));
    deliveries = messagesOn(firstRenderer, ENGINE_METER_CHANNEL);
    const postNavigationDelivery = deliveries.at(-1);
    assert.equal(deliveredMeter(postNavigationDelivery).payload.sequence, 10);
    const countBeforeStaleAck = deliveries.length;
    acknowledge({ sender: firstRenderer }, preNavigationDelivery.args[0]);
    assert.equal(
      messagesOn(firstRenderer, ENGINE_METER_CHANNEL).length,
      countBeforeStaleAck,
      'an ACK from the pre-navigation generation cannot release pending data',
    );
    acknowledge({ sender: firstRenderer }, postNavigationDelivery.args[0]);
    deliveries = messagesOn(firstRenderer, ENGINE_METER_CHANNEL);
    assert.equal(deliveredMeter(deliveries.at(-1)).payload.sequence, 11);
    acknowledge({ sender: firstRenderer }, deliveries.at(-1).args[0]);

    engine.emit('event', meter(12));
    engine.emit('event', meter(13));
    deliveries = messagesOn(firstRenderer, ENGINE_METER_CHANNEL);
    const failedRendererDelivery = deliveries.at(-1);
    firstRenderer.emit('render-process-gone', {}, { reason: 'crashed' });
    await waitFor(
      () => FakeBrowserWindow.instances.length === 2 && firstWindow.isDestroyed(),
      'renderer replacement',
    );

    const replacementRenderer = FakeBrowserWindow.instances[1].webContents;
    engine.emit('event', meter(14));
    engine.emit('event', meter(15));
    let replacementDeliveries = messagesOn(replacementRenderer, ENGINE_METER_CHANNEL);
    assert.equal(replacementDeliveries.length, 1);
    assert.equal(deliveredMeter(replacementDeliveries[0]).payload.sequence, 14);

    acknowledge({ sender: firstRenderer }, failedRendererDelivery.args[0]);
    acknowledge({ sender: firstRenderer }, replacementDeliveries[0].args[0]);
    assert.equal(
      messagesOn(replacementRenderer, ENGINE_METER_CHANNEL).length,
      1,
      'an old renderer cannot ACK either its old delivery or the replacement delivery',
    );

    acknowledge({ sender: replacementRenderer }, replacementDeliveries[0].args[0]);
    replacementDeliveries = messagesOn(replacementRenderer, ENGINE_METER_CHANNEL);
    assert.equal(replacementDeliveries.length, 2);
    assert.equal(deliveredMeter(replacementDeliveries[1]).payload.sequence, 15);

    const openPrompter = ipcHandlers.get('prompter:open');
    assert.equal(typeof openPrompter, 'function');
    await openPrompter({ sender: replacementRenderer });
    const prompterWindow = FakeBrowserWindow.instances[2];
    assert.equal(
      prompterWindow.options?.webPreferences?.backgroundThrottling,
      false,
      'prompter cues must not be throttled when the operator focuses the recording window',
    );

    console.log('main process meter IPC integration tests passed');
  } finally {
    delete globalThis.meterIntegrationEngine;
    delete process.env.DATABAKER_DEFAULT_OUTPUT;
    await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
