'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const {
    prompterShowsSilenceRing,
    readerCueHasKeyboardHint,
    readerCueKey,
    readerFacingCue,
    resolveMonitorCue,
  } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'prompter-cues.ts')).href);

  assert.equal(resolveMonitorCue('recording', false), 'recording');
  assert.equal(resolveMonitorCue('recording', true), 'ready');
  assert.equal(resolveMonitorCue('pending', true), 'pending');
  assert.equal(resolveMonitorCue('fault', true), 'fault');
  assert.equal(readerFacingCue('ready'), 'recording');
  assert.equal(readerFacingCue('recording'), 'recording');
  assert.equal(readerFacingCue('fault'), 'fault');

  assert.equal(readerCueKey('idle'), 'wait');
  assert.equal(readerCueKey('review'), 'wait');
  assert.equal(readerCueKey('complete'), 'wait');
  assert.equal(readerCueKey('pending'), 'hush');
  assert.equal(readerCueKey('checking'), 'hush');
  assert.equal(readerCueKey('recording'), 'read');
  assert.equal(readerCueKey('ready'), 'read', 'tail-ready must not tell the reader to stop');
  assert.equal(readerCueKey('fault'), 'halt');
  assert.equal(prompterShowsSilenceRing('pending'), true);
  assert.equal(prompterShowsSilenceRing('checking'), true);
  assert.equal(prompterShowsSilenceRing('recording'), false);
  assert.equal(prompterShowsSilenceRing('ready'), false);

  assert.equal(readerCueHasKeyboardHint('先别出声'), false);
  assert.equal(readerCueHasKeyboardHint('请朗读'), false);
  assert.equal(readerCueHasKeyboardHint('即将开始 · Esc 取消'), true);
  assert.equal(readerCueHasKeyboardHint('Press Space to confirm'), true);

  console.log('prompter cue tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
