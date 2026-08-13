'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const helperPath = path.join(__dirname, '..', 'src', 'preview-player.ts');
  const {
    formatPlaybackClock,
    playbackProgress,
    seekTimeFromClientX,
  } = await import(pathToFileURL(helperPath).href);

  assert.equal(formatPlaybackClock(0), '00:00.0');
  assert.equal(formatPlaybackClock(2.4), '00:02.4');
  assert.equal(formatPlaybackClock(61.05), '01:01.0');
  assert.equal(formatPlaybackClock(3601.2), '1:00:01.2');
  assert.equal(formatPlaybackClock(Number.NaN), '00:00.0');
  assert.equal(formatPlaybackClock(-3), '00:00.0');

  assert.equal(playbackProgress(0, 10), 0);
  assert.equal(playbackProgress(2.5, 10), 0.25);
  assert.equal(playbackProgress(20, 10), 1);
  assert.equal(playbackProgress(1, 0), 0);
  assert.equal(playbackProgress(Number.NaN, 10), 0);

  assert.equal(seekTimeFromClientX(50, 0, 100, 10), 5);
  assert.equal(seekTimeFromClientX(-10, 0, 100, 10), 0);
  assert.equal(seekTimeFromClientX(200, 0, 100, 10), 10);
  assert.equal(seekTimeFromClientX(50, 0, 0, 10), 0);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
