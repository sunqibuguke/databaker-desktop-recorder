const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const modulePath = path.join(__dirname, '..', 'dist-electron', 'exclusive-probe.js');
  const {
    collectExclusiveProbeIssues,
    exclusiveProbeIssueAttributes,
    exclusiveProbeIssueKey,
    exclusiveSupportsRate,
  } = await import(pathToFileURL(modulePath).href);

  assert.deepEqual(collectExclusiveProbeIssues({ devices: [] }), []);
  assert.deepEqual(collectExclusiveProbeIssues(null), []);

  const healthy = {
    name: 'Focusrite USB',
    is_default: true,
    exclusive_available: true,
    exclusive_sample_rates: [44_100, 48_000, 96_000],
    exclusive_input_channels: [1, 2],
    exclusive_formats: ['i24', 'f32'],
    shared_sample_rates: [48_000],
    shared_input_channels: [2],
  };
  assert.equal(exclusiveSupportsRate(healthy, 48_000), true);
  assert.deepEqual(collectExclusiveProbeIssues({ devices: [healthy] }), []);

  const emptyExclusive = {
    name: 'Realtek Microphone',
    is_default: true,
    exclusive_available: false,
    exclusive_sample_rates: [],
    exclusive_input_channels: [],
    exclusive_formats: [],
    shared_sample_rates: [48_000],
    shared_input_channels: [2],
  };
  const emptyIssues = collectExclusiveProbeIssues({ devices: [emptyExclusive] });
  assert.equal(emptyIssues.length, 1);
  assert.equal(emptyIssues[0].kind, 'exclusive_empty');
  assert.equal(emptyIssues[0].supports48000Exclusive, false);
  assert.equal(emptyIssues[0].sharedRates[0], 48_000);

  const probeFailed = {
    name: 'USB Interface',
    exclusive_probe_error: 'Failed to get audio client',
    exclusive_available: false,
    exclusive_sample_rates: [],
    shared_sample_rates: [48_000],
  };
  const errorIssues = collectExclusiveProbeIssues({ devices: [probeFailed] });
  assert.equal(errorIssues[0].kind, 'exclusive_probe_error');
  assert.match(errorIssues[0].probeError, /audio client/);

  const missing48k = {
    name: 'Odd Card',
    exclusive_available: true,
    exclusive_sample_rates: [44_100, 96_000],
    exclusive_input_channels: [2],
    exclusive_formats: ['i24'],
    configurations: [
      { min_sample_rate: 44_100, max_sample_rate: 44_100, channels: 2, sample_format: 'i24', share_mode: 'exclusive' },
      { min_sample_rate: 96_000, max_sample_rate: 96_000, channels: 2, sample_format: 'i24', share_mode: 'exclusive' },
    ],
    shared_sample_rates: [48_000],
  };
  const missingIssues = collectExclusiveProbeIssues({ devices: [missing48k] });
  assert.equal(missingIssues[0].kind, 'exclusive_missing_48k');
  assert.equal(exclusiveSupportsRate(missing48k, 48_000), false);

  const ranged48k = {
    name: 'Ranged exclusive',
    exclusive_available: true,
    exclusive_sample_rates: [44_100, 96_000],
    configurations: [
      { min_sample_rate: 44_100, max_sample_rate: 96_000, channels: 2, sample_format: 'f32', share_mode: 'exclusive' },
    ],
  };
  assert.equal(exclusiveSupportsRate(ranged48k, 48_000), true);
  assert.deepEqual(collectExclusiveProbeIssues({ devices: [ranged48k] }), []);

  const key = exclusiveProbeIssueKey(emptyIssues[0]);
  assert.match(key, /exclusive_empty/);
  assert.match(key, /Realtek Microphone/);
  const attributes = exclusiveProbeIssueAttributes(emptyIssues[0]);
  assert.equal(attributes.kind, 'exclusive_empty');
  assert.equal(attributes.supports_48000_exclusive, false);
  assert.equal(attributes.shared_rates, '48000');

  console.log('exclusive probe inventory tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
