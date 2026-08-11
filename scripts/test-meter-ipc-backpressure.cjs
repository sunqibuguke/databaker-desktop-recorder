const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const modulePath = path.join(__dirname, '..', 'electron', 'meter-backpressure.ts');
  const {
    ENGINE_METER_CHANNEL,
    isMeterEngineEvent,
    LatestOnlyMeterBackpressure,
  } = await import(pathToFileURL(modulePath).href);

  const target = {};
  const sent = [];
  const errors = [];
  let failNextSend = false;
  const lane = new LatestOnlyMeterBackpressure(
    (receiver, deliveryId, value) => {
      assert.equal(receiver, target);
      if (failNextSend) {
        failNextSend = false;
        throw new Error('renderer disappeared');
      }
      sent.push({ channel: ENGINE_METER_CHANNEL, deliveryId, value });
    },
    (error, receiver) => errors.push({ error, receiver }),
  );

  lane.enqueue(target, { captured: 1 });
  lane.enqueue(target, { captured: 2 });
  lane.enqueue(target, { captured: 3 });
  assert.equal(sent.length, 1, 'only one healthy meter may be in flight');
  assert.deepEqual(sent[0].value, { captured: 1 });

  lane.acknowledge(target, sent[0].deliveryId + 99);
  assert.equal(sent.length, 1, 'a stale or forged ACK cannot release the lane');
  lane.acknowledge(target, sent[0].deliveryId);
  assert.equal(sent.length, 2, 'the newest pending meter is sent immediately after ACK');
  assert.deepEqual(sent[1].value, { captured: 3 }, 'intermediate meters are overwritten');

  lane.enqueue(target, { captured: 4 });
  lane.enqueue(target, { captured: 5 });
  lane.clearPending(target);
  lane.acknowledge(target, sent[1].deliveryId);
  assert.equal(sent.length, 2, 'fault/error invalidation clears unsent healthy telemetry');

  lane.enqueue(target, { captured: 6 });
  const beforeReset = sent.at(-1);
  lane.enqueue(target, { captured: 7 });
  lane.reset(target);
  lane.acknowledge(target, beforeReset.deliveryId);
  assert.equal(sent.length, 3, 'an ACK from a replaced renderer cannot release old pending data');
  lane.enqueue(target, { captured: 8 });
  assert.deepEqual(sent.at(-1).value, { captured: 8 });

  lane.acknowledge(target, sent.at(-1).deliveryId);
  failNextSend = true;
  lane.enqueue(target, { captured: 9 });
  assert.equal(errors.length, 1, 'delivery failures are reported without throwing');
  lane.enqueue(target, { captured: 10 });
  assert.deepEqual(sent.at(-1).value, { captured: 10 }, 'a failed send cannot wedge the lane');

  // Regression: at the engine's 80 ms telemetry cadence, a 5.04 s renderer
  // stall produces 63 meters. Electron must retain one in-flight packet and
  // only the 63rd/latest pending packet, never replay all 63 at 4–5x speed.
  const burstTarget = {};
  const burstSent = [];
  const burstLane = new LatestOnlyMeterBackpressure((_receiver, deliveryId, value) => {
    burstSent.push({ deliveryId, value });
  });
  for (let sequence = 1; sequence <= 63; sequence += 1) {
    burstLane.enqueue(burstTarget, { sequence, elapsed_ms: sequence * 80 });
  }
  assert.equal(burstSent.length, 1, '63 stalled meters still produce one in-flight IPC packet');
  assert.equal(burstSent[0].value.sequence, 1);
  burstLane.acknowledge(burstTarget, burstSent[0].deliveryId);
  assert.equal(burstSent.length, 2, 'one ACK releases exactly one latest pending packet');
  assert.deepEqual(
    burstSent[1].value,
    { sequence: 63, elapsed_ms: 5_040 },
    'the post-stall packet must be the 63rd/latest meter, not an old replay frame',
  );

  const healthy = {
    event: 'meter',
    payload: { faulted: false, overflow_samples: 0, storage_status: 'healthy' },
  };
  for (const periodic of [
    healthy,
    { event: 'meter', payload: { ...healthy.payload, storage_status: 'warning' } },
    { event: 'meter', payload: { ...healthy.payload, faulted: true } },
    { event: 'meter', payload: { ...healthy.payload, overflow_samples: 1 } },
    { event: 'meter', payload: { ...healthy.payload, storage_status: 'critical' } },
    { event: 'meter', payload: {} },
  ]) {
    assert.equal(
      isMeterEngineEvent(periodic),
      true,
      'every periodic meter, including a latched fault, must stay on the bounded lane',
    );
  }
  for (const immediate of [
    { event: 'engine_recovery_failed', payload: {} },
    null,
  ]) {
    assert.equal(
      isMeterEngineEvent(immediate),
      false,
      'non-meter lifecycle and error state stays on the immediate channel',
    );
  }

  const faultTarget = {};
  const faultSent = [];
  const faultLane = new LatestOnlyMeterBackpressure((_receiver, deliveryId, value) => {
    faultSent.push({ deliveryId, value });
  });
  for (let sequence = 1; sequence <= 63; sequence += 1) {
    faultLane.enqueue(faultTarget, {
      event: 'meter',
      payload: { ...healthy.payload, faulted: true, sequence },
    });
  }
  assert.equal(faultSent.length, 1, 'latched fault telemetry cannot flood renderer IPC');
  faultLane.acknowledge(faultTarget, faultSent[0].deliveryId);
  assert.equal(faultSent.length, 2);
  assert.equal(faultSent[1].value.payload.sequence, 63);

  console.log('meter IPC backpressure tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
