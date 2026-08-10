const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');

const workspace = path.resolve(__dirname, '..');
const executable = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(
      workspace,
      'engine',
      'target',
      'debug',
      process.platform === 'win32' ? 'recorder-engine.exe' : 'recorder-engine',
    );

const child = spawn(executable, [], {
  cwd: workspace,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let ready = false;
let hello = false;
let shutdown = false;
let stderr = '';

const timeout = setTimeout(() => {
  child.kill();
  fail(`engine protocol smoke timed out (ready=${ready}, hello=${hello}, shutdown=${shutdown})`);
}, 15_000);

function fail(message) {
  clearTimeout(timeout);
  process.stderr.write(`${message}${stderr ? `\nengine stderr:\n${stderr}` : ''}\n`);
  process.exitCode = 1;
}

function send(requestId, command) {
  child.stdin.write(`${JSON.stringify({
    protocol_version: 1,
    request_id: requestId,
    command,
    payload: {},
  })}\n`);
}

child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

createInterface({ input: child.stdout }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    fail(`engine emitted invalid JSON: ${error.message}`);
    child.kill();
    return;
  }

  if (message.event === 'engine_ready') {
    ready = message.protocol_version === 1;
    if (!ready) {
      fail('engine_ready used an unsupported protocol version');
      child.kill();
      return;
    }
    send('smoke-hello', 'hello');
    return;
  }

  if (message.request_id === 'smoke-hello') {
    if (message.ok !== true || message.result?.protocol_version !== 1) {
      fail(`hello failed: ${line}`);
      child.kill();
      return;
    }
    hello = true;
    send('smoke-shutdown', 'shutdown');
    return;
  }

  if (message.request_id === 'smoke-shutdown') {
    if (message.ok !== true) {
      fail(`shutdown failed: ${line}`);
      child.kill();
      return;
    }
    shutdown = true;
    child.stdin.end();
  }
});

child.once('error', (error) => {
  fail(`cannot start recorder engine ${executable}: ${error.message}`);
});

child.once('exit', (code, signal) => {
  clearTimeout(timeout);
  if (!ready || !hello || !shutdown || code !== 0) {
    fail(
      `engine protocol smoke failed (ready=${ready}, hello=${hello}, shutdown=${shutdown}, code=${code}, signal=${signal})`,
    );
    return;
  }
  process.stdout.write(`engine protocol smoke passed: ${executable}\n`);
});
