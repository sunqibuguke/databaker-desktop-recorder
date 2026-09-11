// Browser regression using a newly created simulated task, never operator data.
// Rust tests exercise real PCM boundaries; this test exercises review and controls.
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');

async function main() {
  const port = 5197;
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
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('databaker:automation-rules:workstation', JSON.stringify({
        autoStartNext: false, enforceHeadTailSilence: true, discardEmpty: true, envCheck: false,
      }));
      window.__silenceRegression = { commands: [], meters: [], stopped: [] };
      // Deliberately synthesize a 970 ms measurement against a 1000 ms recorded
      // requirement, including the very first take. Every snapshot keeps all
      // earlier takes, reproducing the item-wide validation failure.
      function fixtureAttempt(attempt) {
        if (!attempt || !Number.isFinite(attempt.end_sample)) return attempt;
        const measured = 46_560; // 970 ms at 48 kHz.
        const required = 48_000;
        const lastSpeech = attempt.end_sample - attempt.tail_silence_samples;
        return {
          ...attempt,
          head_silence_passed_sample: attempt.head_silence_armed_sample + measured,
          start_sample: attempt.content_started_sample - measured,
          end_sample: lastSpeech + measured,
          required_head_silence_samples: required,
          tail_silence_samples: measured,
          required_tail_silence_samples: required,
          speech_quality: attempt.speech_quality ? {
            ...attempt.speech_quality,
            warnings: ['speech_low'], live_warnings: ['speech_low'],
          } : null,
        };
      }
      function fixtureResult(value) {
        const result = structuredClone(value);
        if (result?.snapshot) {
          for (const item of result.snapshot.items) item.attempts = item.attempts.map(fixtureAttempt);
        }
        if (result?.attempt) result.attempt = fixtureAttempt(result.attempt);
        if (result?.result?.attempt) result.result.attempt = fixtureAttempt(result.result.attempt);
        return result;
      }
      const defineProperty = Object.defineProperty;
      Object.defineProperty = (target, key, descriptor) => {
        if (target === window && key === 'recorder' && descriptor.value) {
          const api = descriptor.value;
          const request = api.request;
          window.__rawRecorderState = () => request('get_state');
          api.request = async (command, payload) => {
            window.__silenceRegression.commands.push({ command, payload: structuredClone(payload) });
            const result = await request(command, payload);
            // Leave enough time for a second click to exercise the UI action lock.
            if (command === 'accept_attempt') await new Promise((resolve) => setTimeout(resolve, 200));
            return fixtureResult(result);
          };
          const onEngineEvent = api.onEngineEvent;
          api.onEngineEvent = (listener) => onEngineEvent((event) => {
            if (event.event === 'meter') window.__silenceRegression.meters.push(structuredClone(event.payload));
            if (event.event === 'attempt_auto_stopped') {
              window.__silenceRegression.stopped.push(structuredClone(event.payload.result.attempt));
            }
            listener({ ...event, payload: fixtureResult(event.payload) });
          });
        }
        return defineProperty(target, key, descriptor);
      };
    });
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByTestId('new-recording').click();
    await page.getByTestId('script-file').setInputFiles({
      name: 'retake-silence.csv', mimeType: 'text/csv',
      buffer: Buffer.from('id,text,label\n001,hi celia,normal speed normal volume\n002,hello celia,normal speed normal volume'),
    });
    await page.getByTestId('delivery-bit-depth').selectOption('16');
    await page.getByLabel('人声幅值检查', { exact: true }).check();
    await page.getByLabel('短句自动结束', { exact: true }).check();
    await page.getByLabel('人声峰值下限（samp）', { exact: true }).fill('15000');
    await page.getByTestId('start-session').click();
    await page.getByTestId('input-audition-skip').click();
    await expect(page.getByTestId('input-audition-dialog')).toHaveCount(0);

    const state = () => page.evaluate(() => window.recorder.request('get_state'));
    const rawState = () => page.evaluate(() => window.__rawRecorderState());
    const review = async (number, selectedId = null) => {
      await expect(page.getByTestId('main-transport')).toContainText('确认保留', { timeout: 12_000 });
      await expect(page.getByTestId('main-transport')).toBeEnabled();
      await expect(page.getByTestId('speech-quality-result')).toContainText('声音偏小');
      await expect(page.getByTestId('speech-quality-result')).toContainText('低于本次下限 15000 samp');
      const current = await state();
      assert.equal(current.active_attempt, null);
      assert.equal(current.snapshot.items[0].attempts.length, number);
      assert.equal(current.snapshot.items[0].selected_attempt_id, selectedId);
      for (const attempt of current.snapshot.items[0].attempts) {
        assert.equal(attempt.head_silence_passed_sample - attempt.head_silence_armed_sample, 46_560);
        assert.equal(attempt.content_started_sample - attempt.start_sample, 46_560);
        assert.equal(attempt.tail_silence_samples, 46_560);
      }
      return current;
    };
    const retake = async () => {
      await page.getByTitle('重录 R', { exact: true }).click();
      await expect(page.getByTestId('main-transport')).not.toHaveClass(/accept/);
    };
    const confirmTwice = async (selectedId, expectedCommandCount) => {
      await page.getByTestId('main-transport').evaluate((button) => { button.click(); button.click(); });
      await expect(page.locator('.editor-nav')).toContainText('2 / 2');
      const current = await state();
      assert.equal(current.snapshot.items[0].selected_attempt_id, selectedId);
      assert.equal(current.active_attempt, null, 'retake confirmation must not unexpectedly start another take');
      assert.equal(current.snapshot.items[1].attempts.length, 0, 'duplicate confirmation cannot affect the next sentence');
      assert.equal(await page.evaluate(() => window.__silenceRegression.commands.filter((entry) => entry.command === 'accept_attempt').length), expectedCommandCount);
      await page.getByTitle('上一句', { exact: true }).click();
      await expect(page.locator('.editor-nav')).toContainText('1 / 2');
    };

    await page.getByTestId('main-transport').click();
    const starting = await rawState();
    assert.equal(starting.snapshot.silence_duration_ms, 1_000, 'the operator setting stays at 1000 ms');
    assert.equal(starting.active_attempt.required_head_silence_samples, 52_800, 'new captures reserve 1100 ms');
    await review(1);
    await retake();
    await review(2);
    await retake();
    await review(3);
    await confirmTwice('001-a3', 1);
    let current = await state();
    assert.ok(current.snapshot.items[0].attempts[2].speech_quality.retained_by_operator_at);

    // A selected take exists; a new candidate must remain confirmable even when
    // previous takes also carry the same small timing discrepancy.
    await retake();
    await review(4, '001-a3');
    await expect(page.getByTestId('preview-retake')).toBeEnabled();
    await expect(page.getByTestId('discard-retake')).toBeEnabled();
    await confirmTwice('001-a4', 2);
    await retake();
    await review(5, '001-a4');
    await page.getByTestId('discard-retake').click();
    await expect(page.locator('.editor-nav')).toContainText('2 / 2');
    current = await state();
    assert.equal(current.snapshot.items[0].selected_attempt_id, '001-a4');
    assert.equal(current.snapshot.items[0].attempts.length, 5, 'all takes remain present');
    assert.equal(current.snapshot.items[0].attempts[4].status, 'rejected_by_operator');

    const telemetry = await page.evaluate(() => window.__silenceRegression);
    assert.equal(telemetry.stopped.length, 5);
    for (const attempt of telemetry.stopped) {
      assert.equal(attempt.required_head_silence_samples, 52_800);
      assert.equal(attempt.required_tail_silence_samples, 52_800);
      assert.ok(attempt.head_silence_passed_sample - attempt.head_silence_armed_sample >= 52_800);
      assert.equal(attempt.content_started_sample - attempt.start_sample, 52_800);
      assert.equal(attempt.tail_silence_samples, 52_800);
    }
    const activeMeters = telemetry.meters.filter((meter) => meter.required_head_silence_samples > 0);
    assert.ok(activeMeters.length > 0);
    assert.ok(activeMeters.every((meter) => meter.silence_duration_ms === 1_000 && meter.silence_target_ms === 1_100));
    assert.ok(activeMeters.some((meter) => meter.head_silence_phase === 'waiting_for_head_silence'));
    assert.ok(activeMeters.every((meter) => meter.head_silence_phase === 'waiting_for_head_silence'
      || meter.head_silence_passed_sample - meter.head_silence_armed_sample >= 52_800),
    'the 100 ms margin must be collected, not treated as early completion');

    // Manual takes freeze their original quiet interval too. Changing settings
    // while recording must neither rearm the head nor shorten the pending tail.
    const changedSettings = await page.evaluate(async () => {
      const before = await window.__rawRecorderState();
      await window.recorder.request('set_recording_policy', { ...before.snapshot.recording_policy, auto_end: false });
      const started = await window.recorder.request('start_attempt', { item_id: '002', enforce_silence: true });
      const change = await window.recorder.request('set_silence_settings', {
        threshold_dbfs: -38, silence_duration_ms: 1_500, enforce_silence: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 180));
      const active = (await window.__rawRecorderState()).active_attempt;
      const meter = window.__silenceRegression.meters.at(-1);
      let detectorChangeRejected = false;
      try {
        await window.recorder.request('set_silence_settings', {
          threshold_dbfs: -38, silence_duration_ms: 1_500, silence_detector: 'energy',
        });
      } catch (error) {
        detectorChangeRejected = error.message.includes('不能切换静音检测器');
      }
      await window.recorder.request('stop_attempt', { attempt_id: started.attempt_id, force: true, discard_empty: true });
      const next = await window.recorder.request('start_attempt', { item_id: '002', enforce_silence: true });
      await window.recorder.request('stop_attempt', { attempt_id: next.attempt_id, force: true, discard_empty: true });
      return { started, change, active, next, meter, detectorChangeRejected };
    });
    assert.equal(changedSettings.change.reset_kind, 'next_attempt');
    assert.equal(changedSettings.active.head_silence_armed_sample, changedSettings.started.head_silence_armed_sample);
    assert.equal(changedSettings.active.required_head_silence_samples, 52_800);
    assert.equal(changedSettings.change.snapshot.silence_duration_ms, 1_500);
    assert.equal(changedSettings.meter.silence_duration_ms, 1_000);
    assert.equal(changedSettings.meter.silence_threshold_dbfs, -42);
    assert.equal(changedSettings.meter.silence_target_ms, 1_100);
    assert.equal(changedSettings.next.required_head_silence_samples, 76_800);
    assert.equal(changedSettings.next.silence_threshold_dbfs, -38);
    assert.equal(changedSettings.detectorChangeRejected, true);
    assert.deepEqual(errors, []);
    console.log('Retake silence regression: 1100 ms capture target; 970/1000 ms review tolerance; repeated retakes, low-volume retention, navigation and duplicate confirmation passed');
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
