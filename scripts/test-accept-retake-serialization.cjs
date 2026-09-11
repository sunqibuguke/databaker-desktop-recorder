'use strict';

// Delay real mock responses to exercise confirmation's cross-operation window.
// The fixture contains only newly recorded synthetic speech and no operator data.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');

async function main() {
  const port = 5198;
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABAKER_SENTRY_PLUGIN_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Vite startup timed out')), 20_000);
      server.stdout.on('data', (data) => {
        if (data.toString().includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); }
      });
      server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Vite exited: ${code}`)); });
    });
    browser = await chromium.launch({ headless: true, channel: process.env.DATABAKER_TEST_BROWSER_CHANNEL || 'chrome' });
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('databaker:automation-rules:workstation', JSON.stringify({
        autoStartNext: true, enforceHeadTailSilence: true, discardEmpty: true, envCheck: false,
      }));
    });
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByTestId('new-recording').click();
    await page.getByTestId('script-file').setInputFiles({
      name: 'confirmation.csv', mimeType: 'text/csv',
      buffer: Buffer.from('id,text,label\n001,hi celia,normal\n002,hello celia,normal\n003,hey celia,normal'),
    });
    await page.getByTestId('delivery-bit-depth').selectOption('16');
    await page.getByLabel('人声幅值检查', { exact: true }).check();
    await page.getByLabel('短句自动结束', { exact: true }).check();
    await page.getByLabel('人声峰值下限（samp）', { exact: true }).fill('15000');
    await page.getByTestId('start-session').click();
    await page.getByTestId('input-audition-skip').click();
    await expect(page.getByTestId('input-audition-dialog')).toHaveCount(0);
    await page.evaluate(() => {
      const request = window.recorder.request;
      window.__serialization = { commands: [], refreshMode: 'normal', delayStart: false, waiting: '', release: null };
      window.__rawState = () => request('get_state');
      let refreshAfterAccept = false;
      window.recorder.request = async (command, payload) => {
        const fixture = window.__serialization;
        fixture.commands.push({ command, payload: structuredClone(payload) });
        const result = await request(command, payload);
        if (command === 'accept_attempt') refreshAfterAccept = true;
        if (command === 'get_state' && refreshAfterAccept) {
          refreshAfterAccept = false;
          const mode = fixture.refreshMode;
          fixture.refreshMode = 'normal';
          if (mode === 'fail') throw new Error('模拟确认已保存，但状态刷新失败');
          if (mode === 'delay') {
            fixture.waiting = 'refresh';
            await new Promise((resolve) => { fixture.release = resolve; });
            fixture.waiting = '';
          }
        }
        if (command === 'start_attempt' && fixture.delayStart) {
          fixture.delayStart = false;
          fixture.waiting = 'start';
          await new Promise((resolve) => { fixture.release = resolve; });
          fixture.waiting = '';
        }
        return result;
      };
    });
    const state = () => page.evaluate(() => window.__rawState());
    const count = (command) => page.evaluate((name) => window.__serialization.commands.filter((entry) => entry.command === name).length, command);
    const review = async () => {
      await expect(page.getByTestId('main-transport')).toContainText('确认保留', { timeout: 12_000 });
      await expect(page.getByTestId('main-transport')).toBeEnabled();
    };
    const release = () => page.evaluate(() => window.__serialization.release());
    const blockedInputs = async (index, expectedStarts, expectedAccepts) => {
      await expect(page.getByTestId('main-transport')).toBeDisabled();
      await expect(page.getByTitle('重录 R', { exact: true })).toBeDisabled();
      await expect(page.getByTitle('下一句', { exact: true })).toBeDisabled();
      for (const item of await page.locator('.professional-item').all()) await expect(item).toBeDisabled();
      await page.evaluate(() => {
        // Covers queued handlers as well as ordinary disabled button clicks.
        document.querySelector('[title="重录 R"]').click();
        document.querySelector('[title="下一句"]').click();
        document.querySelectorAll('.professional-item')[2].click();
        for (const [key, code] of [['r', 'KeyR'], [' ', 'Space'], ['s', 'KeyS'], ['ArrowRight', 'ArrowRight']]) {
          window.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true }));
        }
      });
      await expect(page.locator('.editor-nav')).toContainText(`${index} / 3`);
      assert.equal(await count('start_attempt'), expectedStarts);
      assert.equal(await count('accept_attempt'), expectedAccepts);
      assert.equal(await count('skip_item'), 0);
    };

    await page.getByTestId('main-transport').click();
    await review();
    await page.evaluate(() => {
      window.__serialization.refreshMode = 'delay';
      window.__serialization.delayStart = true;
      // A second event can arrive before React commits the busy render.
      document.querySelector('[data-testid="main-transport"]').click();
      document.querySelector('[title="重录 R"]').click();
      document.querySelector('[title="下一句"]').click();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
    });
    await page.waitForFunction(() => window.__serialization.waiting === 'refresh');
    await blockedInputs(1, 1, 1);
    assert.equal((await state()).active_attempt, null);
    await release();
    await page.waitForFunction(() => window.__serialization.waiting === 'start');
    await blockedInputs(2, 2, 1);
    assert.equal((await state()).active_attempt.item_id, '002', 'confirmation must permit its own automatic next take');
    await release();
    await review();

    // A refresh failure occurs after successful persistence. The lock must be
    // released and the same confirmation can be retried without stranding UI.
    await page.evaluate(() => { window.__serialization.refreshMode = 'fail'; });
    await page.getByTestId('main-transport').click();
    await expect(page.getByTestId('main-transport')).toBeEnabled();
    await expect(page.getByTitle('重录 R', { exact: true })).toBeEnabled();
    await expect(page.locator('.editor-nav')).toContainText('2 / 3');
    assert.equal((await state()).snapshot.items[1].selected_attempt_id, '002-a1');
    await page.getByTestId('main-transport').click();
    await expect(page.locator('.editor-nav')).toContainText('3 / 3');
    await review();
    assert.equal(await count('start_attempt'), 3);
    assert.equal(await count('accept_attempt'), 3);

    // Retake acceptance still advances exactly one physical sentence, without
    // opening another take even though normal confirmation auto-starts.
    await page.getByTitle('上一句', { exact: true }).click();
    await page.getByTitle('重录 R', { exact: true }).click();
    await review();
    await page.evaluate(() => { window.__serialization.refreshMode = 'delay'; });
    await page.getByTestId('main-transport').click();
    await page.waitForFunction(() => window.__serialization.waiting === 'refresh');
    await blockedInputs(2, 4, 4);
    await release();
    await expect(page.locator('.editor-nav')).toContainText('3 / 3');
    await expect(page.getByTitle('重录 R', { exact: true })).toBeEnabled();
    const final = await state();
    assert.equal(final.active_attempt, null);
    assert.equal(final.snapshot.items[1].selected_attempt_id, '002-a2');
    assert.equal(final.snapshot.items[2].attempts.length, 1);
    assert.equal(await count('start_attempt'), 4);
    assert.deepEqual(errors, [], 'refresh failure must be handled instead of becoming an unhandled rejection');
    console.log('Confirmation serialization: buttons/shortcuts/navigation blocked through refresh and next-start; refresh failure retry and retake single-step navigation passed');
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
