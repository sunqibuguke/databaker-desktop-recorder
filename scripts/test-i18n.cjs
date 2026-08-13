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

  assert.equal(t('chrome.productName'), '标贝音频采集');
  assert.equal(t('chrome.windowTitle'), '标贝音频采集');
  assert.equal(t('chrome.prompterWindowTitle'), '标贝音频采集 · 领读');
  assert.equal(t('settings.title'), '应用设置');
  assert.equal(t('home.newRecording'), '新建录制');
  assert.equal(t('home.emptyTitle'), '开始第一条录制任务');
  assert.equal(t('home.viewTask'), '查看');
  assert.equal(t('home.recordTask'), '录制');
  assert.equal(t('home.subtitle'), '查看进度与录音，或进入录制继续作业。');
  assert.equal(t('recorder.previewThis'), '试听本句');
  assert.equal(t('recorder.previewTitle'), '试听');
  assert.equal(t('recorder.previewPause'), '暂停');
  assert.equal(t('recorder.enterCapture'), '进入录制');
  assert.equal(t('recorder.leaveView'), '退出查看');
  assert.equal(t('notice.importedItems', { count: 12 }), '已导入 12 条文本');
  assert.equal(t('recorder.headTail'), '首 / 尾');
  assert.equal(t('recorder.showPostTakeReview'), '停句后显示首尾检查');
  assert.equal(t('recorder.showPostTakeReviewHint'), '首是点击到开口，尾是最后有声到停止。等待朗读是定时器，不是首静音。关闭只藏账单，空格照旧。');
  assert.equal(t('setup.exclusive'), '独占');
  assert.equal(t('setup.shared'), '系统混音');
  assert.equal(t('setup.exclusiveRecommended'), '独占（推荐）');
  assert.equal(t('setup.sharedRecommended'), '系统混音（推荐）');
  assert.equal(t('setup.bit16'), '16-bit PCM（推荐）');
  assert.equal(t('setup.bit24'), '24-bit PCM');
  assert.match(t('setup.devWebCaptureHint'), /Windows/);
  assert.match(t('recorder.devWebCaptureOn'), /系统麦克风/);
  assert.equal(t('recorder.silenceLive', { ms: 320, required: 1_000 }), '静音 320 / 1000 ms');
  assert.equal(t('silence.headDash'), '首 —');
  assert.equal(t('silence.tailEnough', { ms: '1000 ms' }), '尾已够 · 1000 ms');
  assert.equal(t('quality.bannerTitle'), '输入质量强提醒');
  assert.equal(t('issues.discontinuityTitle'), '声卡链路告警 · 未停录');
  assert.equal(t('exportDialog.resultOkTitle'), '导出完成');
  assert.equal(t('exportDialog.resultFailedTitle'), '导出失败');
  assert.equal(t('exportDialog.destination'), '导出到');
  assert.equal(t('exportDialog.chooseFolderTitle'), '选择导出目录');
  assert.equal(t('exportDialog.destMissing'), '所选导出目录不存在，请重新选择');
  assert.equal(t('notice.copyingExport'), '正在复制到所选导出目录…');
  assert.equal(t('alertDialog.dataSafetyTitle'), '数据安全提示');
  assert.equal(t('activationError.exclusiveTitle'), '无法以独占模式打开声卡');
  assert.equal(t('activationError.recreateAndEnter'), '重新创建并进入录制');
  assert.equal(t('prompter.settings'), '显示设置');
  assert.equal(t('prompter.fontSize'), '字号');
  assert.equal(t('prompter.liveColor'), '可朗读颜色');
  assert.equal(t('prompter.fontSizeValue', { size: 36 }), '36 px');

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
  assert.equal(t('chrome.windowTitle'), 'DataBaker Audio Capture');
  assert.equal(t('chrome.prompterWindowTitle'), 'DataBaker Audio Capture · Prompter');
  assert.equal(t('home.newRecording'), 'New recording');
  assert.equal(t('notice.importedItems', { count: 12 }), 'Imported 12 lines of text');
  setLocale('missing-key-fallback-test');
  assert.equal(t('settings.title'), '应用设置');

  setLocale('en');
  assert.equal(t('this.key.does.not.exist'), 'this.key.does.not.exist');

  setLocale(DEFAULT_LOCALE);

  const { AppLocaleRepository, nativeWindowTitle } = require('../dist-electron/app-locale.js');
  assert.equal(nativeWindowTitle('zh-CN', 'app'), '标贝音频采集');
  assert.equal(nativeWindowTitle('zh-CN', 'prompter'), '标贝音频采集 · 领读');
  assert.equal(nativeWindowTitle('en', 'app'), 'DataBaker Audio Capture');
  assert.equal(nativeWindowTitle('en', 'prompter'), 'DataBaker Audio Capture · Prompter');
  assert.equal(nativeWindowTitle('nope', 'app'), '标贝音频采集');
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
