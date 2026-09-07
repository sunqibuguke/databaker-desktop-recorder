const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
async function main() {
  const { speechQualityWarning, speechQualityWarningDetail, DEFAULT_RECORDING_POLICY } = await import(pathToFileURL(path.resolve('src/recording-policy.ts')));
  const { APP_LOCALES, setLocale } = await import(pathToFileURL(path.resolve('shared/i18n/index.ts')));
  const result = (rms, peak, warnings = [], live = []) => ({ policy: { ...DEFAULT_RECORDING_POLICY, amplitude_enabled: true }, speech_samples: 48000, rms_dbfs: rms, peak_dbfs: peak, warnings, live_warnings: live, retained_by_operator_at: null });
  setLocale('zh-CN');
  // The supplied task: the first take has no warning, the next two are below
  // the captured -30 dBFS minimum. Metric visibility alone is not a warning.
  assert.equal(speechQualityWarning(result(-26.96302, -11.153023)), '');
  assert.equal(speechQualityWarningDetail(result(-26.96302, -11.153023)), '');
  for (const rms of [-31.418783, -34.746426]) {
    const q = result(rms, -20.549273, ['speech_low'], ['speech_low']);
    assert.equal(speechQualityWarning(q), '声音偏小');
    assert.match(speechQualityWarningDetail(q), /低于本次下限 -30 dBFS/);
    assert.doesNotMatch(speechQualityWarningDetail(q), /PEAK/);
  }
  const liveOnly = result(-20, -8, [], ['speech_low']);
  assert.equal(speechQualityWarning(liveOnly), '声音偏小');
  assert.match(speechQualityWarningDetail(liveOnly), /录制中曾/);
  assert.doesNotMatch(speechQualityWarningDetail(liveOnly), /RMS -20.*低于/);
  const unmeasured = { ...result(null, null, [], ['speech_low', 'speech_high']), speech_samples: 0 };
  assert.match(speechQualityWarningDetail(unmeasured), /录制中曾/);
  assert.doesNotMatch(speechQualityWarningDetail(unmeasured), /整句|未低于|未超过/);
  const high = result(-20, -1, ['speech_high']);
  assert.match(speechQualityWarningDetail(high), /PEAK -1 dBFS 超过本次上限 -3/);
  const both = result(-40, -1, ['speech_low', 'speech_high'], ['speech_low']);
  assert.equal(speechQualityWarning(both), '声音偏小 · 声音过大');
  const historical = result(-20, -8, ['speech_low']);
  historical.policy.rms_min_dbfs = -10;
  assert.match(speechQualityWarningDetail(historical), /本次下限 -10/);
  assert.equal(speechQualityWarningDetail(null), '');
  for (const locale of APP_LOCALES) {
    setLocale(locale);
    for (const q of [both, liveOnly, result(-20, -8, [], ['speech_high'])]) {
      const detail = speechQualityWarningDetail(q);
      assert.ok(detail && !detail.includes('speech.') && !detail.includes('{'), `${locale}: untranslated detail`);
    }
  }
  console.log('Speech warning presentation: saved limits, normal/low/high/live-only and all locales passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
