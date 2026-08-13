'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const helperPath = path.join(__dirname, '..', 'src', 'discontinuity-toast.ts');
  const i18nPath = path.join(__dirname, '..', 'shared', 'i18n', 'index.ts');
  const {
    DISCONTINUITY_TOAST_MS,
    discontinuityDurationMs,
    shouldShowDiscontinuityToast,
  } = await import(pathToFileURL(helperPath).href);
  const { setLocale, t } = await import(pathToFileURL(i18nPath).href);

  assert.equal(DISCONTINUITY_TOAST_MS, 8_000);
  assert.equal(discontinuityDurationMs(24_192, 48_000), 504);
  assert.equal(shouldShowDiscontinuityToast(0, 0), false);
  assert.equal(shouldShowDiscontinuityToast(0, 1), true);
  assert.equal(shouldShowDiscontinuityToast(163, 164), true);
  assert.equal(shouldShowDiscontinuityToast(164, 164), false);
  assert.equal(shouldShowDiscontinuityToast(164, 100), false);

  setLocale('zh-CN');
  const warning = t('discontinuity.withSilence', { count: 164, ms: discontinuityDurationMs(24_192, 48_000) });
  assert.match(warning, /164/);
  assert.match(warning, /504/);
  assert.match(warning, /确认或重录/);
  assert.doesNotMatch(warning, /不会进入交付/);
  assert.match(t('notice.jitterRetake'), /仍可确认或重录/);
  assert.doesNotMatch(t('notice.jitterRetake'), /不会进入交付/);

  console.log('discontinuity toast tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
