// Exercise actual recording transitions at each supported workspace size.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
async function main() {
  const root = path.resolve(__dirname, '..');
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5186', '--strictPort'], { cwd: root, env: { ...process.env, DATABAKER_SENTRY_PLUGIN_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Vite startup timed out')), 20000);
      server.stdout.on('data', data => { if (data.toString().includes('127.0.0.1:5186')) { clearTimeout(timer); resolve(); } });
      server.once('exit', code => { clearTimeout(timer); reject(new Error(`Vite exited: ${code}`)); });
    });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    await fs.mkdir('.playwright-artifacts', { recursive: true });
    for (const viewport of [{ width: 1080, height: 700 }, { width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      await page.goto('http://127.0.0.1:5186');
      await page.evaluate(() => localStorage.setItem('databaker:automation-rules:workstation', JSON.stringify({ autoStartNext: true, enforceHeadTailSilence: true, discardEmpty: true, envCheck: false })));
      await page.reload();
      await page.getByTestId('new-recording').click();
      await page.getByTestId('script-file').setInputFiles({ name: 'layout.csv', mimeType: 'text/csv', buffer: Buffer.from('id,text,label\n001,你好小贝,正常\n002,你好小贝,正常\n003,你好小贝,正常') });
      await page.getByLabel('人声幅值检查', { exact: true }).check();
      await page.getByLabel('短句自动结束', { exact: true }).check();
      await page.getByTestId('start-session').click();
      await page.getByRole('button', { name: '跳过试听', exact: true }).click();
      await page.evaluate(() => {
        window.__layoutSamples = [];
        window.__trackLayout = true;
        const sample = () => {
          if (!window.__trackLayout) return;
          window.__layoutSamples.push(['.script-monitor', '.prompt-surface', '.signal-monitor', '.transport-panel'].flatMap(selector => {
            const r = document.querySelector(selector).getBoundingClientRect();
            return [r.x, r.y, r.width, r.height];
          }));
          requestAnimationFrame(sample);
        };
        sample();
      });
      await page.getByTestId('main-transport').click();
      await expect(page.getByTestId('main-transport')).toContainText('确认并录下一句', { timeout: 12000 });
      const review = page.getByTestId('speech-quality-result');
      await expect(review).toContainText('人声 RMS');
      await expect(review).not.toHaveClass(/has-warning/);
      await expect(review.locator('svg')).toHaveCount(0);
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByLabel('人声 RMS 下限（dBFS）', { exact: true }).fill('-10');
      await page.getByRole('button', { name: '保存录制设置', exact: true }).click();
      await expect(review).not.toHaveClass(/has-warning/); // saved take uses its own policy
      await page.getByTestId('main-transport').click();
      await expect(review).toHaveCount(0);
      await expect(page.locator('.speech-quality-banner')).toContainText('声音偏小', { timeout: 12000 });
      await expect(page.getByTestId('main-transport')).toContainText('确认保留并录下一句', { timeout: 12000 });
      await expect(review).toHaveClass(/has-warning/);
      await expect(review).toContainText('低于本次下限 -10 dBFS');
      await expect(review.locator('svg')).toHaveCount(1);
      await expect(page.locator('.speech-quality-banner')).toHaveCount(0); // no duplicate review warning
      const layout = await page.evaluate(() => { window.__trackLayout = false; return window.__layoutSamples; });
      assert.ok(layout.length > 20);
      for (const frame of layout) frame.forEach((value, i) => assert.ok(Math.abs(value - layout[0][i]) < .5, `${viewport.width}: layout moved at coordinate ${i}: ${layout[0][i]} -> ${value}`));
      const bounds = await review.boundingBox();
      const slot = await page.locator('.workspace-status-slot').boundingBox();
      assert.ok(bounds.y >= slot.y && bounds.y + bounds.height <= slot.y + slot.height + .5);
      await page.screenshot({ path: `.playwright-artifacts/speech-review-stable-${viewport.width}.png` });
      await context.close();
      console.log(`${viewport.width}x${viewport.height}: idle, recording, normal result, live warning and review kept identical layout (${layout.length} frames)`);
    }
  } finally { if (browser) await browser.close(); server.kill(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
