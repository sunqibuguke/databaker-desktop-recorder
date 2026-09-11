// Browser controls + simulated time only. Rust system tests cover the real PCM.
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');

async function main() {
  const port = 5200;
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATABAKER_SENTRY_PLUGIN_DISABLED: '1' },
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
    const openTask = async (rules) => {
      const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      // Install before the app creates timers; pause after task setup finishes.
      await page.clock.install();
      await page.addInitScript((value) => {
        localStorage.setItem('databaker:automation-rules:workstation', JSON.stringify({ envCheck: false, ...value }));
      }, rules);
      await page.goto(`http://127.0.0.1:${port}`);
      await page.getByTestId('new-recording').click();
      await page.getByTestId('script-file').setInputFiles({
        name: 'early-stop.csv', mimeType: 'text/csv', buffer: Buffer.from('id,text,label\n001,hi celia,normal\n002,hello celia,normal'),
      });
      await page.getByTestId('start-session').click();
      await page.getByTestId('input-audition-skip').click();
      await expect(page.getByTestId('input-audition-dialog')).toHaveCount(0);
      await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 1_000)));
      const state = () => page.evaluate(() => window.recorder.request('get_state'));
      // Paused RAF cannot satisfy Playwright's animation-stability wait. These
      // remain real UI clicks, with explicit visibility/enabled checks first.
      const click = async (locator) => {
        await expect(locator).toBeVisible();
        await expect(locator).toBeEnabled();
        await locator.click({ force: true });
      };
      const mainButton = page.getByTestId('main-transport');
      const start = async () => {
        await click(mainButton);
        assert.ok((await state()).active_attempt, 'the UI starts a real mock attempt');
      };
      const stop = async () => { await click(mainButton); return state(); };
      const review = async () => { await expect(mainButton).toHaveClass(/accept/); await expect(mainButton).toBeEnabled(); };
      const close = async () => { assert.deepEqual(errors, []); await context.close(); };
      return { page, state, click, mainButton, start, stop, review, close };
    };

    const voiced = await openTask({ autoStartNext: false, enforceHeadTailSilence: false, discardEmpty: true });
    await voiced.start();
    let current = await voiced.state();
    assert.equal(current.snapshot.silence_duration_ms, 1_000);
    assert.equal(current.active_attempt.required_head_silence_samples, 52_800);
    await voiced.page.clock.runFor(700);
    current = await voiced.state();
    assert.ok(current.active_attempt.content_started_sample > 0);
    assert.equal(current.active_attempt.head_silence_passed_sample, 0);
    current = await voiced.stop();
    await voiced.review();
    const first = current.snapshot.items[0].attempts[0];
    assert.equal(first.head_silence_passed_sample, 0);
    assert.ok(first.content_started_sample > 0);
    assert.ok(first.end_sample - first.recording_started_sample < first.required_head_silence_samples);
    await voiced.click(voiced.mainButton);
    await expect(voiced.page.locator('.editor-nav')).toContainText('2 / 2');
    await voiced.click(voiced.page.getByTitle('上一句', { exact: true }));
    await voiced.click(voiced.page.getByTitle('重录 R', { exact: true }));
    await voiced.page.clock.runFor(700);
    current = await voiced.stop();
    await voiced.review();
    assert.equal(current.snapshot.items[0].attempts.length, 2);
    assert.equal(current.snapshot.items[0].selected_attempt_id, first.attempt_id);
    const secondId = current.snapshot.items[0].attempts[1].attempt_id;
    await voiced.click(voiced.mainButton);
    current = await voiced.state();
    assert.equal(current.snapshot.items[0].selected_attempt_id, secondId);
    assert.equal(current.snapshot.items[0].attempts[0].status, 'rejected_by_operator');
    await voiced.close();
    console.log('Early voiced UI stop: passed=0 take and subsequent retake can both be confirmed');

    const pending = await openTask({ autoStartNext: false, enforceHeadTailSilence: true, discardEmpty: false });
    await pending.start();
    await pending.page.clock.runFor(500);
    current = await pending.stop();
    assert.equal(current.active_attempt, null);
    assert.deepEqual(current.snapshot.items[0].attempts, [], 'pending cancellation never stores an empty candidate');
    await expect(pending.mainButton).toHaveClass(/start/);
    await pending.start();
    assert.ok((await pending.state()).active_attempt, 'another recording can start immediately after cancellation');
    await pending.close();
    console.log('Pending UI cancellation: discardEmpty=false keeps no candidate and permits another start');

    const canceledRetake = await openTask({ autoStartNext: true, enforceHeadTailSilence: false, discardEmpty: true });
    await canceledRetake.start();
    await canceledRetake.page.clock.runFor(700);
    await canceledRetake.stop();
    await canceledRetake.review();
    await canceledRetake.click(canceledRetake.page.getByTitle('重录 R', { exact: true }));
    await canceledRetake.page.clock.runFor(200);
    current = await canceledRetake.stop();
    assert.equal(current.active_attempt, null);
    assert.equal(current.snapshot.items[0].attempts.length, 1, 'cancelling an empty retake keeps the original review candidate');
    await canceledRetake.review();
    await canceledRetake.click(canceledRetake.mainButton);
    current = await canceledRetake.state();
    assert.equal(current.snapshot.items[0].selected_attempt_id, '001-a1');
    assert.equal(current.active_attempt?.item_id, '002', 'cancelling a pending retake must preserve autoStartNext when confirming the original first take');
    await canceledRetake.close();
    console.log('Canceled pending retake: original first-take confirmation preserves automatic continuation');

    const preservedCandidate = await openTask({ autoStartNext: true, enforceHeadTailSilence: false, discardEmpty: true });
    await preservedCandidate.start();
    await preservedCandidate.page.clock.runFor(700);
    await preservedCandidate.stop();
    await preservedCandidate.review();
    await preservedCandidate.click(preservedCandidate.mainButton);
    current = await preservedCandidate.state();
    assert.equal(current.active_attempt?.item_id, '002');
    // Return from the automatically started next sentence without recording it.
    await preservedCandidate.page.clock.runFor(100);
    await preservedCandidate.stop();
    await preservedCandidate.click(preservedCandidate.page.getByTitle('上一句', { exact: true }));
    await preservedCandidate.click(preservedCandidate.page.getByTitle('重录 R', { exact: true }));
    await preservedCandidate.page.clock.runFor(700);
    current = await preservedCandidate.stop();
    await preservedCandidate.review();
    assert.equal(current.snapshot.items[0].selected_attempt_id, '001-a1');
    assert.equal(current.snapshot.items[0].attempts[1].attempt_id, '001-a2');
    await preservedCandidate.click(preservedCandidate.page.getByTitle('重录 R', { exact: true }));
    assert.equal((await preservedCandidate.state()).active_attempt.attempt_id, '001-a3');
    await preservedCandidate.page.clock.runFor(200);
    current = await preservedCandidate.stop();
    assert.equal(current.active_attempt, null);
    assert.equal(current.snapshot.items[0].attempts.length, 2);
    assert.equal(current.snapshot.items[0].selected_attempt_id, '001-a1');
    await preservedCandidate.review();
    await expect(preservedCandidate.mainButton).toHaveAttribute('data-retake-action', 'use');
    await preservedCandidate.click(preservedCandidate.mainButton);
    current = await preservedCandidate.state();
    assert.equal(current.snapshot.items[0].selected_attempt_id, '001-a2');
    assert.equal(current.snapshot.items[0].attempts[0].status, 'rejected_by_operator');
    assert.equal(current.active_attempt, null, 'a genuine retained retake candidate keeps the retake continuation rule after cancellation');
    assert.deepEqual(current.snapshot.items[1].attempts, []);
    await expect(preservedCandidate.page.locator('.editor-nav')).toContainText('2 / 2');
    await preservedCandidate.close();
    console.log('Canceled third take: existing a2 retake stays selectable and advances without automatically recording the next sentence');
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
