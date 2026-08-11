const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const modulePath = path.join(__dirname, '..', 'src', 'latest-frame.ts');
  const { createLatestFrameCommitter } = await import(pathToFileURL(modulePath).href);

  const scheduled = new Map();
  const cancelled = [];
  const committed = [];
  let nextHandle = 0;
  const committer = createLatestFrameCommitter(
    (value) => committed.push(value),
    (callback) => {
      const handle = ++nextHandle;
      scheduled.set(handle, callback);
      return handle;
    },
    (handle) => {
      cancelled.push(handle);
      scheduled.delete(handle);
    },
  );

  committer.enqueue({ captured: 1 });
  const staleCallback = scheduled.get(1);
  committer.enqueue({ captured: 2 });
  committer.enqueue({ captured: 3 });
  assert.equal(scheduled.size, 1, 'a backlog must schedule only one visual frame');
  scheduled.get(1)();
  scheduled.delete(1);
  assert.deepEqual(committed, [{ captured: 3 }], 'only the newest queued meter is committed');

  committer.enqueue({ captured: 4 });
  const invalidatedCallback = scheduled.get(2);
  committer.invalidate();
  assert.deepEqual(cancelled, [2], 'switching engine/session generations cancels the queued frame');
  invalidatedCallback?.();
  assert.equal(committed.length, 1, 'an invalidated frame cannot overwrite a recovery snapshot');

  committer.enqueue({ captured: 5 });
  const cancelledHealthyCallback = scheduled.get(3);
  committer.commitImmediately({ captured: 6, faulted: true });
  assert.deepEqual(cancelled, [2, 3], 'an immediate fault cancels the queued healthy frame');
  assert.deepEqual(committed, [
    { captured: 3 },
    { captured: 6, faulted: true },
  ], 'fault telemetry is committed synchronously and cannot be swallowed');

  staleCallback?.();
  cancelledHealthyCallback?.();
  assert.equal(committed.length, 2, 'a cancelled or stale callback cannot replay old telemetry');

  committer.enqueue({ captured: 7 });
  const disposedCallback = scheduled.get(4);
  committer.dispose();
  assert.deepEqual(cancelled, [2, 3, 4], 'disposing cancels the final pending frame');
  disposedCallback?.();
  assert.equal(committed.length, 2, 'disposed committers ignore late frame callbacks');

  console.log('latest frame committer tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
