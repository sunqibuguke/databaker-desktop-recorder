'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const helperPath = path.join(__dirname, '..', 'src', 'discontinuity-toast.ts');
  const i18nPath = path.join(__dirname, '..', 'shared', 'i18n', 'index.ts');
  const {
    DISCONTINUITY_TOAST_MS,
    DISCONTINUITY_TOAST_MIN_GAP_MS,
    discontinuityDurationMs,
    initialDiscontinuityToastState,
    shouldShowDiscontinuityToast,
  } = await import(pathToFileURL(helperPath).href);
  const { setLocale, t } = await import(pathToFileURL(i18nPath).href);

  assert.equal(DISCONTINUITY_TOAST_MS, 8_000);
  assert.equal(DISCONTINUITY_TOAST_MIN_GAP_MS, 10);
  assert.equal(discontinuityDurationMs(24_192, 48_000), 504);

  const observe = (state, next) => shouldShowDiscontinuityToast(state, {
    sampleRate: 48_000,
    ...next,
  });

  let seen = observe(initialDiscontinuityToastState(), {
    count: 164,
    silenceSamples: 24_192,
    nowMs: 0,
  });
  assert.equal(seen.show, false);

  seen = observe(seen.state, { count: 164, silenceSamples: 24_192, nowMs: 20 });
  assert.equal(seen.show, false);

  seen = observe(seen.state, { count: 165, silenceSamples: 24_192, nowMs: 40 });
  assert.equal(seen.show, false);

  seen = observe(initialDiscontinuityToastState(), { count: 0, silenceSamples: 0, nowMs: 0 });
  seen = observe(seen.state, { count: 1, silenceSamples: 0, nowMs: 1_000 });
  assert.equal(seen.show, false);

  seen = observe(seen.state, { count: 2, silenceSamples: 240, nowMs: 2_000 });
  assert.equal(seen.show, false);

  seen = observe(seen.state, { count: 3, silenceSamples: 480, nowMs: 3_000 });
  assert.equal(seen.show, false);

  seen = observe(initialDiscontinuityToastState(), { count: 0, silenceSamples: 0, nowMs: 0 });
  seen = observe(seen.state, { count: 1, silenceSamples: 480, nowMs: 1_000 });
  assert.equal(seen.show, true);

  seen = observe(initialDiscontinuityToastState(), { count: 0, silenceSamples: 0, nowMs: 0 });
  seen = observe(seen.state, { count: 1, silenceSamples: 240, nowMs: 1_000 });
  assert.equal(seen.show, false);
  seen = observe(seen.state, { count: 2, silenceSamples: 480, nowMs: 1_030 });
  assert.equal(seen.show, true);

  seen = observe(seen.state, { count: 100, silenceSamples: 200, nowMs: 2_000 });
  assert.equal(seen.show, false);

  setLocale('zh-CN');
  const warning = t('discontinuity.withSilence', { count: 164, ms: discontinuityDurationMs(24_192, 48_000) });
  assert.match(warning, /164/);
  assert.match(warning, /504/);
  assert.match(warning, /需重录且不可交付/);
  assert.doesNotMatch(warning, /确认或试听/);
  assert.match(t('notice.jitterRetake'), /不可确认或试听.*重新录制/);

  console.log('discontinuity toast tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
