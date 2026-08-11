const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');

function loadPreloadWithElectronMock() {
  const exposed = new Map();
  const ipcRenderer = new EventEmitter();
  const sent = [];
  ipcRenderer.send = (channel, ...args) => sent.push({ channel, args });
  ipcRenderer.invoke = () => Promise.resolve(undefined);
  const electron = {
    contextBridge: {
      exposeInMainWorld: (name, api) => exposed.set(name, api),
    },
    ipcRenderer,
  };
  const preloadPath = path.join(__dirname, '..', 'dist-electron', 'preload.js');
  delete require.cache[require.resolve(preloadPath)];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }
  return { api: exposed.get('recorder'), ipcRenderer, sent };
}

function main() {
  const { api, ipcRenderer, sent } = loadPreloadWithElectronMock();
  assert.ok(api, 'preload exposes the recorder bridge');

  const firstMeter = { event: 'meter', payload: { captured_samples: 1 } };
  ipcRenderer.emit('engine:meter', {}, 1, firstMeter);
  assert.deepEqual(
    sent,
    [{ channel: 'engine:meter-ack', args: [1] }],
    'preload ACKs during the React mount gap so the main lane cannot wedge',
  );

  const order = [];
  const originalSend = ipcRenderer.send;
  ipcRenderer.send = (channel, ...args) => {
    order.push(`send:${channel}:${args[0]}`);
    originalSend.call(ipcRenderer, channel, ...args);
  };
  const observed = [];
  const unsubscribe = api.onEngineEvent((message) => {
    observed.push(message);
    order.push(`listener:${message.payload.captured_samples ?? message.event}`);
  });

  const immediate = { event: 'engine_recovery_failed', payload: { error: 'offline' } };
  ipcRenderer.emit('engine:event', {}, immediate);
  assert.equal(observed.at(-1), immediate, 'fault/error events keep the immediate event bridge');
  assert.equal(sent.length, 1, 'immediate events require no healthy-meter ACK');

  const latestMeter = { event: 'meter', payload: { captured_samples: 300 } };
  ipcRenderer.emit('engine:meter', {}, 2, latestMeter);
  assert.equal(observed.at(-1), latestMeter);
  assert.deepEqual(
    order.slice(-2),
    ['listener:300', 'send:engine:meter-ack:2'],
    'ACK is emitted only after renderer listeners have consumed the meter',
  );

  unsubscribe();
  ipcRenderer.emit('engine:meter', {}, 3, {
    event: 'meter',
    payload: { captured_samples: 400 },
  });
  assert.equal(observed.at(-1), latestMeter, 'unsubscribe stops renderer delivery');
  assert.equal(sent.at(-1).args[0], 3, 'the preload-owned receiver still ACKs without listeners');

  const throwingUnsubscribe = api.onEngineEvent(() => {
    throw new Error('renderer listener failed');
  });
  assert.throws(
    () => ipcRenderer.emit('engine:meter', {}, 4, latestMeter),
    /renderer listener failed/,
  );
  assert.equal(sent.at(-1).args[0], 4, 'listener failure cannot strand the main-process lane');
  throwingUnsubscribe();

  const sentBeforeInvalid = sent.length;
  ipcRenderer.emit('engine:meter', {}, 'bad-id', latestMeter);
  assert.equal(sent.length, sentBeforeInvalid, 'malformed delivery IDs are never acknowledged');

  console.log('engine event preload bridge tests passed');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
