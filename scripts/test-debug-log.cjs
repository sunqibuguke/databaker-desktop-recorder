'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const {
    DEBUG_LOG_FILE_NAME,
    DebugLogStore,
    compactDebugData,
    formatDebugLogText,
    sessionIdentityFromResult,
    shouldLogEngineCommand,
    summarizeForDebugLog,
  } = require('../dist-electron/debug-log.js');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'databaker-debug-log-'));
  const appLogPath = path.join(root, 'runtime-debug.jsonl');
  let now = 1_786_377_600_000;
  let token = 0;
  const store = new DebugLogStore(
    appLogPath,
    5,
    () => now,
    () => `token-${++token}`,
  );

  try {
    await store.loadAppLog();
    assert.equal(store.snapshot().entries.length, 0);

    const first = store.append({
      event: 'app.start',
      message: '应用已启动',
      data: { version: '0.1.0' },
    });
    assert.equal(first.seq, 1);
    assert.equal(first.level, 'info');
    assert.match(first.ts, /^2026-/);

    for (let index = 0; index < 8; index += 1) {
      now += 1_000;
      store.append({
        event: `ui.action.${index}`,
        message: `操作 ${index}`,
        level: index === 7 ? 'error' : 'info',
      });
    }
    await store.flush();
    const overflowed = store.snapshot();
    assert.equal(overflowed.entries.length, 5, '内存队列必须按容量裁剪');
    assert.equal(overflowed.dropped, 4);
    assert.equal(overflowed.entries[0].event, 'ui.action.3');
    assert.equal(overflowed.entries.at(-1).event, 'ui.action.7');

    const reloaded = new DebugLogStore(appLogPath, 5, () => now, () => `reload-${++token}`);
    await reloaded.loadAppLog();
    assert.deepEqual(
      reloaded.snapshot().entries.map((entry) => entry.event),
      overflowed.entries.map((entry) => entry.event),
      '应用日志文件必须能恢复最近队列',
    );

    const sessionDir = path.join(root, '朗读采集-20260813-120000');
    await fs.mkdir(sessionDir, { recursive: true });
    await store.bindSession(sessionDir, '朗读采集-20260813-120000');
    const sessionFile = path.join(sessionDir, DEBUG_LOG_FILE_NAME);
    assert.equal(await fs.access(sessionFile).then(() => true, () => false), true);
    store.append({
      event: 'ui.start_attempt',
      message: '开始录制 SENT-001',
      category: 'capture',
      data: { item_id: 'SENT-001' },
    });
    await store.flush();
    const bound = store.snapshot();
    assert.equal(bound.bound_session_id, '朗读采集-20260813-120000');
    assert.equal(bound.bound_session_dir, path.resolve(sessionDir));
    assert.ok(bound.entries.some((entry) => entry.event === 'ui.start_attempt'));
    assert.ok(bound.entries.some((entry) => entry.event === 'debug_log.bind'));

    const sessionText = await fs.readFile(sessionFile, 'utf8');
    assert.match(sessionText, /ui\.start_attempt/);
    assert.match(sessionText, /SENT-001/);

    await store.unbindSession('return_home');
    assert.equal(store.snapshot().bound_session_id, '');
    store.append({ event: 'ui.home', message: '已返回任务列表' });
    await store.flush();
    const appAfterUnbind = await fs.readFile(appLogPath, 'utf8');
    assert.match(appAfterUnbind, /ui\.home/);
    assert.doesNotMatch(
      await fs.readFile(sessionFile, 'utf8'),
      /ui\.home/,
      '离开任务后的应用日志不得继续写入已解除绑定的任务文件',
    );

    await store.bindSession(sessionDir, '朗读采集-20260813-120000');
    assert.ok(
      store.snapshot().entries.some((entry) => entry.event === 'ui.start_attempt'),
      '再次打开任务必须读回该任务已保存的日志',
    );

    await store.forgetSession(sessionDir);
    assert.equal(store.snapshot().bound_session_id, '');
    await fs.rm(sessionDir, { recursive: true, force: true });
    assert.equal(await fs.access(sessionFile).then(() => true, () => false), false,
      '删除任务目录后调试日志必须一并消失');
    store.append({ event: 'ui.after_delete', message: '删除后不应重建任务目录' });
    await store.flush();
    assert.equal(await fs.access(sessionDir).then(() => true, () => false), false,
      '任务删除后不得为写日志重建任务目录');

    await fs.mkdir(sessionDir, { recursive: true });
    await store.bindSession(sessionDir, '朗读采集-20260813-120000');
    await store.flush();
    await fs.rm(sessionDir, { recursive: true, force: true });
    store.append({ event: 'ui.stale_bind', message: '绑定仍在但目录已删除' });
    await store.flush();
    assert.equal(await fs.access(sessionDir).then(() => true, () => false), false,
      '外部删除任务目录后，残留绑定也不得重建该目录');

    const huge = compactDebugData({
      items: Array.from({ length: 200 }, (_, index) => ({ id: `S${index}`, text: 'x'.repeat(200) })),
      waveform: [[0, 1], [1, 2]],
      device_name: 'Studio USB',
    });
    assert.deepEqual(huge.items, { length: 200 });
    assert.deepEqual(huge.waveform, { length: 2 });
    assert.equal(huge.device_name, 'Studio USB');

    assert.equal(shouldLogEngineCommand('get_state', false), false);
    assert.equal(shouldLogEngineCommand('get_state', true), true);
    assert.equal(shouldLogEngineCommand('dev_feed_pcm', false), false);
    assert.equal(shouldLogEngineCommand('dev_feed_pcm', true), true);
    assert.equal(shouldLogEngineCommand('start_attempt', false), true);

    const identity = sessionIdentityFromResult({
      session_dir: '/tmp/task',
      snapshot: { session_id: 'task-1' },
    });
    assert.deepEqual(identity, { sessionDir: '/tmp/task', sessionId: 'task-1' });

    const exported = formatDebugLogText([first], { bound_session_id: 'task-1' });
    assert.match(exported, /DataBaker Recorder debug log/);
    assert.match(exported, /app\.start/);
    assert.match(exported, /session_id=task-1/);

    assert.deepEqual(summarizeForDebugLog({ items: [1, 2, 3], peak: 0.4 }), {
      items: { length: 3 },
      peak: 0.4,
    });

    store.recordCommand('start_attempt', { item_id: 'A' }, { attempt_id: 't1' }, 12, null);
    store.recordCommand('get_state', {}, {}, 3, null);
    store.recordCommand('stop_attempt', { item_id: 'A' }, null, 40, new Error('写盘失败'));
    await store.flush();
    const commands = store.snapshot().entries.map((entry) => entry.event);
    assert.ok(commands.includes('engine.start_attempt'));
    assert.equal(commands.includes('engine.get_state'), false);
    assert.ok(commands.includes('engine.stop_attempt'));
    assert.equal(store.snapshot().entries.at(-1).level, 'error');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('debug log tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
