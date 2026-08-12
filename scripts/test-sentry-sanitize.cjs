const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function runSuite(modulePath) {
  const { sanitizeValue } = await import(pathToFileURL(modulePath).href);

  const boxedString = new String('electron.browser-window-created');
  Object.freeze(boxedString);
  assert.equal(sanitizeValue(boxedString), 'electron.browser-window-created');

  const source = Object.freeze({
    message: 'saved C:\\Users\\tester\\recording.wav',
    attributes: Object.freeze({ token: 'do-not-send', phase: 'recording' }),
  });
  assert.deepEqual(sanitizeValue(source), {
    message: 'saved [LocalPath]',
    attributes: { token: '[Filtered]', phase: 'recording' },
  });
  assert.equal(source.message, 'saved C:\\Users\\tester\\recording.wav');

  const circular = {};
  circular.self = circular;
  assert.deepEqual(sanitizeValue(circular), { self: '[Circular]' });
}

async function main() {
  const root = path.join(__dirname, '..');
  await runSuite(path.join(root, 'dist-electron', 'sentry-sanitize.js'));
  await runSuite(path.join(root, 'src', 'sentry-sanitize.ts'));
  console.log('Sentry sanitization tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
