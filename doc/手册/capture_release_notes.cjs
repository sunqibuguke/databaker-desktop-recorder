// Capture the current UI with the development mock and synthetic script only.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const { chromium, expect } = require(path.join(root, 'node_modules/@playwright/test'));
async function main() {
  const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5183', '--strictPort'], { cwd: root, env: { ...process.env, DATABAKER_SENTRY_PLUGIN_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Vite startup timed out')), 20000);
      server.stdout.on('data', (value) => { if (value.toString().includes('127.0.0.1:5183')) { clearTimeout(timer); resolve(); } });
      server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Vite exited: ${code}`)); });
    });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1.5 });
    await context.addInitScript(() => {
      const defineProperty = Object.defineProperty;
      Object.defineProperty = (target, key, descriptor) => {
        if (target === window && key === 'recorder' && descriptor.value) {
          descriptor.value.onLicenseChanged = (listener) => { window.__manualLicenseListener = listener; return () => { window.__manualLicenseListener = null; }; };
        }
        return defineProperty(target, key, descriptor);
      };
    });
    const page = await context.newPage();
    const out = path.join(__dirname, 'captures');
    await fs.mkdir(out, { recursive: true });
    await page.goto('http://127.0.0.1:5183');
    await page.evaluate(() => localStorage.setItem('databaker:automation-rules:workstation', JSON.stringify({ autoStartNext: true, enforceHeadTailSilence: true, discardEmpty: true, envCheck: false })));
    await page.reload();
    await page.getByTestId('new-recording').click();
    await page.getByTestId('script-file').setInputFiles({ name: '唤醒词示例.csv', mimeType: 'text/csv', buffer: Buffer.from('序号,正文,标签\n001,你好小贝,自然音量\n002,小贝小贝,自然音量\n003,你好小贝,自然音量') });
    await page.getByTestId('delivery-bit-depth').selectOption('16');
    await page.getByLabel('人声幅值检查', { exact: true }).check();
    await page.getByLabel('短句自动结束', { exact: true }).check();
    await page.getByTestId('recording-policy-fields').screenshot({ path: path.join(out, '14-new-recording-policy.png') });
    // Lower the upper limit solely to exercise the warning with synthetic PCM.
    await page.getByLabel('人声峰值上限（samp）', { exact: true }).fill('8000');
    await page.getByTestId('start-session').click();
    await page.getByRole('button', { name: '跳过试听', exact: true }).click();
    await page.getByTestId('main-transport').click();
    await expect(page.getByTestId('main-transport')).toContainText('确认保留并录下一句', { timeout: 12000 });
    await page.locator('.editor-document').screenshot({ path: path.join(out, '15-speech-warning-review.png') });
    await page.locator('.transport-panel').screenshot({ path: path.join(out, '18-warning-confirmation.png') });
    const prompt = await context.newPage();
    await prompt.setViewportSize({ width: 720, height: 500 });
    await prompt.goto('http://127.0.0.1:5183/?view=prompter');
    await expect(prompt.locator('.prompter-quality-warning')).toHaveText('声音过大');
    await prompt.screenshot({ path: path.join(out, '16-prompter-speech-warning.png') });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByLabel('人声峰值上限（samp）', { exact: true }).fill('20000');
    await page.getByRole('button', { name: '保存录制设置', exact: true }).click();
    await page.getByTestId('recording-policy-fields').screenshot({ path: path.join(out, '17-task-recording-policy.png') });
    await page.getByTestId('main-transport').click();
    await expect(page.getByTestId('main-transport')).toContainText('确认并录下一句', { timeout: 12000 });
    const detailRegions = await Promise.all(['.signal-monitor', '.transport-panel'].map((selector) => page.locator(selector).boundingBox()));
    const dx = Math.min(...detailRegions.map((r) => r.x));
    const dy = Math.min(...detailRegions.map((r) => r.y));
    await page.screenshot({ path: path.join(out, '19-auto-end-review.png'), clip: { x: dx, y: dy, width: Math.max(...detailRegions.map((r) => r.x + r.width)) - dx, height: Math.max(...detailRegions.map((r) => r.y + r.height)) - dy } });
    // Exercise the current license transition component with an explicit test event.
    await page.evaluate(() => window.__manualLicenseListener({ state: 'invalid', reason: 'expired', transitionRevision: 20, captureStopPending: true }));
    await expect(page.locator('.license-transition')).toBeVisible();
    await page.locator('.license-transition > div').screenshot({ path: path.join(out, '20-license-safe-seal.png') });
    console.log('Saved release-note screenshots; mock audio and simulated license transition.');
  } finally { if (browser) await browser.close(); server.kill(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
