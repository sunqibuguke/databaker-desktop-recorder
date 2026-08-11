const assert = require('node:assert/strict');

const {
  EngineClient,
  EngineSafeStopTimeoutError,
  EngineUnsafeStopError,
} = require('../dist-electron/engine-client.js');

const mockEngineSource = String.raw`
const readline = require('node:readline');
const mode = process.argv[1];
const lines = readline.createInterface({ input: process.stdin });
function send(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}
send({ protocol_version: 1, event: 'engine_ready', payload: {} });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.command === 'hello') {
    send({ protocol_version: 1, request_id: request.request_id, ok: true, result: {} });
    return;
  }
  if (request.command !== 'shutdown') return;
  if (mode === 'hang') {
    setInterval(() => {}, 1_000);
    return;
  }
  if (mode === 'response-error') {
    send({
      protocol_version: 1,
      request_id: request.request_id,
      ok: false,
      error: { code: 'SHUTDOWN_REJECTED', message: 'mock shutdown rejected' },
    });
    setTimeout(() => process.exit(0), 5);
    return;
  }
  const delay = mode === 'delayed' ? 180 : 5;
  setTimeout(() => {
    send({
      protocol_version: 1,
      request_id: request.request_id,
      ok: true,
      result: { shutting_down: true },
    });
    setTimeout(() => {
      if (mode === 'nonzero') {
        process.exit(7);
      } else if (mode === 'signal') {
        process.kill(process.pid, 'SIGTERM');
      } else {
        process.exit(0);
      }
    }, 5);
  }, delay);
});
`;

function client(mode, gracefulStopTimeoutMs) {
  return new EngineClient(process.execPath, {
    args: ['-e', mockEngineSource, mode],
    gracefulStopTimeoutMs,
    shutdownRequestTimeoutMs: Math.max(10, gracefulStopTimeoutMs - 20),
    forcedExitWaitMs: 2_000,
  });
}

async function waitForEvent(target, event, timeoutMs = 2_000) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.removeListener(event, onEvent);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    const onEvent = (...args) => {
      clearTimeout(timer);
      resolve(args);
    };
    target.once(event, onEvent);
  });
}

async function main() {
  const graceful = client('graceful', 500);
  await graceful.start();
  const gracefulExit = waitForEvent(graceful, 'stopped');
  await graceful.stop();
  const [gracefulOutcome] = await gracefulExit;
  assert.deepEqual(gracefulOutcome, { safe: true, code: 0, signal: null });
  assert.equal(graceful.running, false, 'normal safe stop exits the engine');

  const responseError = client('response-error', 500);
  await responseError.start();
  const responseErrorExit = waitForEvent(responseError, 'stopped');
  await assert.rejects(
    responseError.stop(),
    (error) => error instanceof EngineUnsafeStopError
      && error.shutdownConfirmed === false
      && error.outcome.code === 0
      && error.outcome.safe === false,
    'shutdown response error plus exit 0 must not be accepted as safe',
  );
  assert.deepEqual((await responseErrorExit)[0], { safe: false, code: 0, signal: null });

  const nonzero = client('nonzero', 500);
  await nonzero.start();
  const nonzeroExit = waitForEvent(nonzero, 'stopped');
  await assert.rejects(
    nonzero.stop(),
    (error) => error instanceof EngineUnsafeStopError
      && error.shutdownConfirmed === true
      && error.outcome.code === 7
      && error.outcome.safe === false,
    'shutdown acknowledgement plus non-zero exit must not be accepted as safe',
  );
  assert.deepEqual((await nonzeroExit)[0], { safe: false, code: 7, signal: null });

  const signaled = client('signal', 500);
  await signaled.start();
  const signaledExit = waitForEvent(signaled, 'stopped');
  await assert.rejects(
    signaled.stop(),
    (error) => error instanceof EngineUnsafeStopError
      && error.shutdownConfirmed === true
      && error.outcome.signal === 'SIGTERM'
      && error.outcome.safe === false,
    'shutdown acknowledgement plus signal exit must not be accepted as safe',
  );
  assert.deepEqual((await signaledExit)[0], { safe: false, code: null, signal: 'SIGTERM' });

  const hung = client('hang', 100);
  await hung.start();
  await assert.rejects(
    hung.stop(),
    (error) => error instanceof EngineSafeStopTimeoutError,
    'safe-stop timeout must be explicit',
  );
  assert.equal(hung.running, true, 'timeout must not automatically kill the audio engine');
  const forcedExit = waitForEvent(hung, 'stopped');
  await hung.forceStop();
  const [forcedOutcome] = await forcedExit;
  assert.equal(forcedOutcome.safe, false, 'a forced exit is never a confirmed safe stop');
  assert.equal(hung.running, false, 'explicit force stop exits the engine');

  const delayed = client('delayed', 80);
  await delayed.start();
  const delayedExit = waitForEvent(delayed, 'stopped');
  await assert.rejects(delayed.stop(), EngineSafeStopTimeoutError);
  assert.equal(delayed.running, true, 'late sealing continues after the UI deadline');
  const [delayedOutcome] = await delayedExit;
  assert.deepEqual(
    delayedOutcome,
    { safe: false, code: 0, signal: null },
    'an acknowledgement received after the protocol timeout cannot be trusted retroactively',
  );
  assert.equal(delayed.running, false, 'the late engine exit is observed without being called safe');

  console.log('engine client safe-stop tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
