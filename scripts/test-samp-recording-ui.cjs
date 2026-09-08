// Simulated PCM16 peak workflow: unit switching, first take and retake confirmation.
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const root = path.resolve(__dirname, '..');

(async () => {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5187', '--strictPort'], {
    cwd: root, env: { ...process.env, DATABAKER_SENTRY_PLUGIN_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('startup timeout')), 20000);
      server.stdout.on('data', data => {
        if (data.toString().includes('127.0.0.1:5187')) { clearTimeout(timer); resolve(); }
      });
      server.on('error', error => { clearTimeout(timer); reject(error); });
      server.on('exit', code => { clearTimeout(timer); reject(Error('server exit ' + code)); });
    });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    for (const auto of [false, true]) for (const warning of [false, true]) {
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
      const page = await ctx.newPage();
      await page.goto('http://127.0.0.1:5187');
      await page.evaluate(() => localStorage.setItem('databaker:automation-rules:workstation', JSON.stringify({
        autoStartNext: false, enforceHeadTailSilence: true, discardEmpty: true, envCheck: false,
      })));
      await page.reload();
      await page.getByTestId('new-recording').click();
      await page.getByTestId('script-file').setInputFiles({
        name: 'retake.csv', mimeType: 'text/csv', buffer: Buffer.from('id,text,label\n001,你好小贝,正常\n002,你好小贝,正常'),
      });
      await page.getByTestId('delivery-bit-depth').selectOption('16');
      await page.getByLabel('人声幅值检查', { exact: true }).check();
      if (auto) await page.getByLabel('短句自动结束', { exact: true }).check();
      const unit = page.getByLabel('幅值单位', { exact: true });
      const lower = page.getByLabel('人声峰值下限（samp）', { exact: true });
      const upper = page.getByLabel('人声峰值上限（samp）', { exact: true });
      await expect(lower).toHaveValue('3000');
      for (let i = 0; i < 5; i++) { await unit.selectOption('dbfs'); await unit.selectOption('samp'); }
      await expect(lower).toHaveValue('3000');
      await expect(upper).toHaveValue('20000');
      // Editing dBFS converts once to an integer; switching units never changes it.
      await unit.selectOption('dbfs');
      await page.getByLabel('人声峰值下限（dBFS）', { exact: true }).fill('-12');
      await unit.selectOption('samp');
      await expect(lower).toHaveValue(String(Math.round(32768 * 10 ** (-12 / 20))));
      await lower.fill('3000');
      if (warning) { await upper.fill('25000'); await lower.fill('20000'); }
      await page.getByTestId('start-session').click();
      await page.getByRole('button', { name: '跳过试听', exact: true }).click();
      const state = () => page.evaluate(() => window.recorder.request('get_state'));
      async function stop() {
        if (!auto) {
          await expect.poll(async () => (await state()).active_attempt?.content_started_sample ?? 0, { timeout: 12000 }).toBeGreaterThan(0);
          await expect(page.getByTestId('main-transport')).toContainText('完成本句', { timeout: 15000 });
          await expect(page.getByTestId('main-transport')).toBeEnabled();
          await page.getByTestId('main-transport').click();
        }
        await expect(page.getByTestId('speech-quality-result')).toBeVisible({ timeout: 15000 });
        await expect(page.getByTestId('speech-quality-result')).toContainText('11627 samp');
      }
      await page.getByTestId('main-transport').click();
      await stop();
      await expect(page.getByTestId('main-transport')).toBeEnabled();
      await page.getByTestId('main-transport').click();
      await expect.poll(async () => (await state()).snapshot.items[0].status).toBe('accepted');
      const original = (await state()).snapshot.items[0].selected_attempt_id;
      await page.locator('.professional-item').first().click();
      await page.getByRole('button', { name: '重录 R', exact: true }).click();
      await stop();
      const item = (await state()).snapshot.items[0];
      assert.equal(item.selected_attempt_id, original);
      assert.equal(item.status, 'review');
      const latest = item.attempts.at(-1);
      assert.equal(latest.speech_quality.peak_samp, 11627);
      assert.deepEqual(latest.speech_quality.live_warnings, []);
      assert.equal(latest.speech_quality.warnings.includes('speech_low'), warning);
      const candidate = latest.attempt_id;
      await expect(page.locator('[data-testid="main-transport"][data-retake-action="use"]')).toBeEnabled();
      await page.getByTestId('main-transport').click();
      await expect.poll(async () => (await state()).snapshot.items[0].selected_attempt_id).toBe(candidate);
      assert.equal((await state()).snapshot.items[0].status, 'accepted');
      if (warning) assert.ok((await state()).snapshot.items[0].attempts.at(-1).speech_quality.retained_by_operator_at);
      console.log(JSON.stringify({ auto, warning, original, candidate, result: 'retake confirmed' }));
      await ctx.close();
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
