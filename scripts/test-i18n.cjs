'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const i18nPath = path.join(__dirname, '..', 'shared', 'i18n', 'index.ts');
  const {
    APP_LOCALES,
    DEFAULT_LOCALE,
    catalogs,
    flattenKeys,
    getLocale,
    normalizeLocale,
    setLocale,
    t,
  } = await import(pathToFileURL(i18nPath).href);

  setLocale(DEFAULT_LOCALE);
  assert.equal(getLocale(), 'zh-CN');
  assert.equal(normalizeLocale(undefined), 'zh-CN');
  assert.equal(normalizeLocale(''), 'zh-CN');
  assert.equal(normalizeLocale('nope'), 'zh-CN');
  assert.equal(normalizeLocale('pt-BR'), 'zh-CN');
  assert.equal(normalizeLocale('zh'), 'zh-CN');
  assert.deepEqual([...APP_LOCALES], ['zh-CN', 'en', 'th', 'ja', 'ko', 'es', 'pt']);
  for (const locale of APP_LOCALES) {
    assert.equal(normalizeLocale(locale), locale);
  }

  assert.equal(t('settings.title'), '应用设置');
  assert.equal(t('home.newRecording'), '新建录制');
  assert.equal(t('home.emptyTitle'), '开始第一条录制任务');
  assert.equal(t('notice.importedItems', { count: 12 }), '已导入 12 条文本');
  assert.equal(t('recorder.headTail'), '首 / 尾');
  assert.equal(t('recorder.showPostTakeReview'), '停句后显示首尾检查');
  assert.equal(t('recorder.showPostTakeReviewHint'), '首是点击到开口，尾是最后有声到停止。等待朗读是定时器，不是首静音。关闭只藏账单，空格照旧。');
  assert.equal(t('setup.exclusive'), '独占');
  assert.equal(t('setup.shared'), '系统混音');
  assert.equal(t('setup.exclusiveRecommended'), '独占（推荐）');
  assert.equal(t('silence.headDash'), '首 —');
  assert.equal(t('silence.tailEnough', { ms: '1000 ms' }), '尾已够 · 1000 ms');
  assert.equal(t('quality.bannerTitle'), '输入质量强提醒');
  assert.equal(t('issues.discontinuityTitle'), '声卡链路告警 · 未停录');

  const chineseKeys = new Set(flattenKeys(catalogs['zh-CN']));
  for (const locale of APP_LOCALES) {
    if (locale === 'zh-CN') continue;
    const keys = new Set(flattenKeys(catalogs[locale]));
    for (const key of chineseKeys) {
      assert.ok(keys.has(key), `${locale} is missing ${key}`);
    }
  }

  setLocale('en');
  const englishTitle = t('settings.title');
  assert.ok(englishTitle.length > 0);
  assert.notEqual(englishTitle, '应用设置');
  assert.equal(t('home.newRecording'), 'New recording');
  assert.equal(t('notice.importedItems', { count: 12 }), 'Imported 12 lines of text');
  setLocale('missing-key-fallback-test');
  assert.equal(t('settings.title'), '应用设置');

  setLocale('en');
  assert.equal(t('this.key.does.not.exist'), 'this.key.does.not.exist');

  setLocale(DEFAULT_LOCALE);

  const { AppLocaleRepository } = require('../dist-electron/app-locale.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'databaker-app-locale-'));
  const file = path.join(root, 'app-locale.json');
  try {
    const repository = new AppLocaleRepository(file);
    assert.equal(await repository.load(), 'zh-CN');
    assert.equal(await repository.save('en'), 'en');
    assert.equal(await repository.load(), 'en');
    await fs.writeFile(file, JSON.stringify({ locale: 'nope' }), 'utf8');
    assert.equal(await repository.load(), 'zh-CN');
    await fs.writeFile(file, '{broken', 'utf8');
    assert.equal(await repository.load(), 'zh-CN');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log('i18n catalog and locale preference tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
