// Browser integration test with the explicitly simulated recorder. Real PCM
// boundaries and persistence are covered by the Rust system-test fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');

async function main() {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5178', '--strictPort'], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATABAKER_SENTRY_PLUGIN_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Vite startup timed out')), 20_000);
      server.stdout.on('data', (data) => { if (data.toString().includes('127.0.0.1:5178')) { clearTimeout(timer); resolve(); } });
      server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Vite exited: ${code}`)); });
    });
    browser = await chromium.launch({ headless: true, channel: process.env.DATABAKER_TEST_BROWSER_CHANNEL || 'chrome' });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const defineProperty = Object.defineProperty;
      Object.defineProperty = (target, key, descriptor) => {
        if (target === window && key === 'recorder' && descriptor.value) {
          descriptor.value.onLicenseChanged = (listener) => { window.__licenseListener = listener; return () => { if (window.__licenseListener === listener) window.__licenseListener = null; }; };
        }
        return defineProperty(target, key, descriptor);
      };
    });
    await page.goto('http://127.0.0.1:5178');
    await page.evaluate(() => localStorage.setItem('databaker:automation-rules:workstation', JSON.stringify({ autoStartNext: true, enforceHeadTailSilence: true, discardEmpty: true, envCheck: false })));
    await page.reload();
    await page.getByTestId('new-recording').click();
    await page.getByTestId('script-file').setInputFiles({ name: 'wake.csv', mimeType: 'text/csv', buffer: Buffer.from('id,text,label\n001,你好小贝,正常\n002,你好小贝,正常') });
    await expect(page.getByLabel('人声幅值检查', { exact: true })).not.toBeChecked();
    await expect(page.getByLabel('短句自动结束', { exact: true })).not.toBeChecked();
    await page.getByLabel('人声幅值检查', { exact: true }).check();
    await page.getByLabel('短句自动结束', { exact: true }).check();
    await page.getByLabel('人声 RMS 下限（dBFS）', { exact: true }).fill('-10');
    await fs.mkdir('.playwright-artifacts', { recursive: true });
    await page.screenshot({ path: '.playwright-artifacts/speech-setup.png', fullPage: true });
    await page.getByTestId('start-session').click();
    await page.getByRole('button', { name: '跳过试听', exact: true }).click();
    await page.evaluate(() => {
      const send = window.recorder.sendPrompterState;
      window.recorder.sendPrompterState = (state) => { window.__speechPrompter = state; return send(state); };
    });
    if (process.env.DATABAKER_TEST_DELAY_START_REPLY === '1') {
      await page.evaluate(() => {
        const request = window.recorder.request;
        let delayed = false;
        window.recorder.request = async (command, payload) => {
          const result = await request(command, payload);
          if (command === 'start_attempt' && !delayed) {
            delayed = true;
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('No automatic completion before delayed start reply')), 10_000);
              const unsubscribe = window.recorder.onEngineEvent((event) => {
                if (event.event !== 'attempt_auto_stopped') return;
                clearTimeout(timer);
                unsubscribe();
                window.__autoBeforeStartReply = true;
                resolve();
              });
            });
          }
          return result;
        };
      });
    }
    const geometry = () => page.evaluate(() => Object.fromEntries(['.script-monitor', '.prompt-surface', '.signal-monitor', '.transport-panel'].map((selector) => {
      const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
      return [selector, { x, y, width, height }];
    })));
    const beforeRecording = await geometry();
    await page.getByTestId('main-transport').click();
    await expect(page.locator('.speech-quality-banner, .speech-review.has-warning')).toContainText('声音偏小', { timeout: 10_000 });
    assert.equal(await page.evaluate(() => window.__speechPrompter.qualityWarning), '声音偏小');
    await expect(page.getByTestId('main-transport')).toContainText('确认保留并录下一句', { timeout: 10_000 });
    const state = () => page.evaluate(() => window.recorder.request('get_state'));
    const first = await state();
    assert.deepEqual(await geometry(), beforeRecording, 'ending a take must not move or resize the script, waveform or controls');
    await expect(page.getByTestId('speech-quality-result')).toContainText('声音偏小');
    await expect(page.getByTestId('speech-quality-result')).toContainText('低于本次下限 -10 dBFS');
    await expect(page.locator('.speech-quality-banner')).toHaveCount(0);
    assert.equal(await page.locator('.editor-canvas > .speech-review').count(), 0, 'results cannot create an implicit grid row');
    if (process.env.DATABAKER_TEST_DELAY_START_REPLY === '1') {
      assert.equal(await page.evaluate(() => window.__autoBeforeStartReply), true);
    }
    assert.equal(first.active_attempt, null);
    assert.equal(first.snapshot.items[1].attempts.length, 0);
    assert.equal(first.snapshot.items[0].attempts[0].end_reason, 'auto_silence');
    const boundary = first.snapshot.items[0].attempts[0].end_sample;
    await page.screenshot({ path: '.playwright-artifacts/speech-review.png', fullPage: true });
    for (const viewport of [{ width: 1080, height: 700 }, { width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
      await page.setViewportSize(viewport);
      const overlap = await page.evaluate(() => {
        const warning = document.querySelector('.speech-review').getBoundingClientRect();
        return [...document.querySelectorAll('button, input')].filter((element) => {
          const r = element.getBoundingClientRect();
          return r.width && r.height && r.x < warning.right && r.right > warning.x && r.y < warning.bottom && r.bottom > warning.y;
        }).map((element) => element.textContent);
      });
      assert.deepEqual(overlap, [], 'amplitude reminder cannot cover any control');
      await page.getByRole('button', { name: '减小正文字号', exact: true }).click();
      await page.screenshot({ path: `.playwright-artifacts/fixed-warning-${viewport.width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByLabel('短句自动结束', { exact: true })).toBeChecked();
    await page.getByTestId('main-transport').click();
    const second = await state();
    await expect(page.getByTestId('speech-quality-result')).toHaveCount(0);
    assert.equal(second.active_attempt.item_id, '002');
    assert.ok(second.snapshot.items[0].attempts[0].speech_quality.retained_by_operator_at);
    assert.equal(second.snapshot.items[0].attempts[0].end_sample, boundary);
    await page.getByLabel('短句自动结束', { exact: true }).uncheck();
    await page.getByLabel('人声 RMS 下限（dBFS）', { exact: true }).fill('-30');
    await page.getByRole('button', { name: '保存录制设置', exact: true }).click();
    await expect(page.getByTestId('speech-quality-result')).toBeVisible({ timeout: 10_000 });
    const finished = await state();
    await expect(page.getByTestId('speech-quality-result')).toContainText('低于本次下限 -10 dBFS');
    await expect(page.getByTestId('speech-quality-result')).not.toContainText('本次下限 -30');
    assert.equal(finished.snapshot.recording_policy.auto_end, false);
    assert.equal(finished.snapshot.items[1].attempts[0].recording_policy.auto_end, true);
    assert.equal(finished.snapshot.items[1].attempts[0].speech_quality.policy.rms_min_dbfs, -10);
    assert.equal(finished.snapshot.items[0].attempts[0].speech_quality.policy.rms_min_dbfs, -10);
    await expect(page.getByTestId('restore-task-recording-settings')).toBeEnabled();
    await page.getByTestId('restore-task-recording-settings').click();
    await expect(page.getByLabel('短句自动结束', { exact: true })).toBeChecked();
    await expect(page.getByLabel('人声 RMS 下限（dBFS）', { exact: true })).toHaveValue('-10');
    const restored = await state();
    assert.deepEqual(restored.snapshot.recording_policy, first.snapshot.recording_policy);
    assert.deepEqual(restored.snapshot.items, finished.snapshot.items, 'restoring settings cannot rejudge historical recordings');
    await expect(page.getByTestId('restore-task-recording-settings')).toBeDisabled();
    await page.getByLabel('短句自动结束', { exact: true }).uncheck();
    await expect(page.getByTestId('restore-task-recording-settings')).toBeEnabled();
    await page.getByTestId('restore-task-recording-settings').click();
    await expect(page.getByLabel('短句自动结束', { exact: true })).toBeChecked();

    const prompt = await page.context().newPage();
    await prompt.setViewportSize({ width: 520, height: 360 });
    await prompt.goto('http://127.0.0.1:5178/?view=prompter');
    await prompt.getByTestId('prompter-shell').waitFor();
    const promptState = { sequence: 1, total: 2, id: '001', text: '这是一句用于检查长文本与提示区域是否重叠的录制内容。'.repeat(20), label: '正常', cue: 'recording', readerCueLabel: '请朗读', silenceProgress: 0, qualityWarning: '' };
    await page.evaluate((value) => window.recorder.sendPrompterState(value), promptState);
    await expect(prompt.locator('.prompter-content p')).toHaveText(promptState.text);
    const before = await prompt.locator('.prompter-content p').boundingBox();
    await page.evaluate((value) => window.recorder.sendPrompterState({ ...value, qualityWarning: '声音偏小 · 声音过大' }), promptState);
    await expect(prompt.locator('.prompter-quality-warning')).toBeVisible();
    const warning = await prompt.locator('.prompter-quality-warning').boundingBox();
    const after = await prompt.locator('.prompter-content p').boundingBox();
    assert.deepEqual(after, before, 'warning appearance cannot move or resize the reading area');
    assert.ok(after.y >= warning.y + warning.height, 'long copy must begin below warning');
    await prompt.screenshot({ path: '.playwright-artifacts/fixed-prompter-520.png' });
    await page.evaluate((value) => window.recorder.sendPrompterState({ ...value, cue: 'recording', licenseInvalid: true }), promptState);
    await expect(prompt.getByTestId('prompter-cue')).toHaveText('立即停止朗读');
    await expect(prompt.getByTestId('prompter-shell')).toHaveAttribute('data-cue', 'fault');
    await prompt.close();

    await page.evaluate(() => {
      window.__originalTransport = document.querySelector('[data-testid="main-transport"]');
      window.__licenseListener({ state: 'invalid', reason: 'expired', transitionRevision: 20, captureStopPending: true, captureStopError: '测试：等待写盘重试' });
    });
    await expect(page.locator('.license-transition')).toBeVisible();
    assert.equal(await page.evaluate(() => window.__originalTransport === document.querySelector('[data-testid="main-transport"]')), true, 'pending seal must preserve the mounted recorder');
    await page.evaluate(() => window.__licenseListener({ state: 'invalid', reason: 'expired', transitionRevision: 19, captureStopPending: false }));
    await expect(page.locator('.license-transition')).toBeVisible();
    await page.screenshot({ path: '.playwright-artifacts/license-seal-pending.png' });
    await page.evaluate(() => window.__licenseListener({ state: 'invalid', reason: 'expired', transitionRevision: 21, captureStopPending: false }));
    await expect(page.locator('.license-transition')).toHaveCount(0);
    await expect(page.getByTestId('main-transport')).toHaveCount(0);
    await expect(page.locator('.license-gate')).toBeVisible();
    assert.deepEqual(errors, []);
    console.log('Speech recording UI: defaults, automatic review, prompter warning, retention, and next-take settings passed');
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
