const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

(async () => {
  const p = await import(pathToFileURL(path.resolve('src/recording-policy.ts')));
  const { setLocale, APP_LOCALES } = await import(pathToFileURL(path.resolve('shared/i18n/index.ts')));
  const base = p.DEFAULT_RECORDING_POLICY;
  assert.deepEqual(base.peak_samp, { min: 3000, max: 20000, unit: 'samp' });
  assert.equal(p.recordingPolicyForTask().peak_samp, undefined);
  assert.equal(p.recordingPolicyForTask(p.LEGACY_RECORDING_POLICY).peak_samp, undefined);
  assert.equal(p.validRecordingPolicy({ ...base, amplitude_enabled: true }, 24), false);
  assert.equal(p.validRecordingPolicy({ ...base, amplitude_enabled: true }, 16), true);
  for (const peak of [
    { min: 0, max: 20000, unit: 'samp' }, { min: 3000, max: 32767, unit: 'samp' },
    { min: 3000, max: 3000, unit: 'samp' }, { min: 1.5, max: 20000, unit: 'samp' },
    { min: 1, max: 20000, unit: 'unknown' },
  ]) assert.equal(p.validRecordingPolicy({ ...base, peak_samp: peak }), false);
  for (const n of [1, 2999, 3000, 5000, 20000, 25000, 32766]) assert.equal(p.dbfsToSamp(p.sampToDbfs(n)), n);
  const quality = {
    policy: { ...base, amplitude_enabled: true }, speech_samples: 1, rms_dbfs: -50,
    peak_dbfs: p.sampToDbfs(2999), peak_samp: 2999, warnings: ['speech_low'],
    live_warnings: [], retained_by_operator_at: null,
  };
  for (const locale of APP_LOCALES) {
    setLocale(locale);
    const detail = p.speechQualityWarningDetail(quality);
    assert.ok(detail.includes('2999') && detail.includes('3000') && !detail.includes('RMS'));
    assert.ok(!detail.includes('{'));
    assert.equal(p.speechQualityWarning(quality, true), '');
    assert.ok(p.speechQualityMetrics(quality).includes('2999 samp'));
  }
  console.log('PCM16 sample policy, legacy preservation, units and warning presentation passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
