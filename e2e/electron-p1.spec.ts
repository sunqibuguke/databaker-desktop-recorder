import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const workspace = process.cwd();
const engineName = process.platform === 'win32' ? 'recorder-engine.exe' : 'recorder-engine';
const systemTestEngine = path.join(
  workspace,
  'engine',
  'target',
  'system-test',
  'debug',
  engineName,
);

type Harness = {
  app: ElectronApplication;
  page: Page;
  root: string;
  output: string;
  delivery: string;
};

async function launchHarness(existingRoot?: string): Promise<Harness> {
  const root = existingRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), 'databaker-electron-p1-'));
  const output = path.join(root, 'recordings');
  const userData = path.join(root, 'user-data');
  const exportDir = path.join(root, 'delivery');
  await Promise.all([
    fs.mkdir(output, { recursive: true }),
    fs.mkdir(userData, { recursive: true }),
    fs.mkdir(exportDir, { recursive: true }),
  ]);
  const delivery = await fs.realpath(exportDir);
  const args = process.platform === 'linux' ? ['--no-sandbox', workspace] : [workspace];
  const app = await electron.launch({
    args,
    cwd: workspace,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABAKER_E2E: '1',
      DATABAKER_E2E_ENGINE_PATH: systemTestEngine,
      DATABAKER_E2E_USER_DATA: userData,
      DATABAKER_E2E_OUTPUT_DIR: output,
      DATABAKER_E2E_EXPORT_DIR: exportDir,
      DATABAKER_DEFAULT_OUTPUT: output,
      DATABAKER_LICENSE_DISABLED: '1',
      DATABAKER_SKIP_MIC_PREFLIGHT: '1',
      DATABAKER_LOCALE: 'zh-CN',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
  });
  const page = await app.firstWindow();
  await page.getByTestId('recordings-workspace').waitFor();
  await page.evaluate(() => {
    localStorage.setItem('databaker:automation-rules:workstation', JSON.stringify({
      autoStartNext: true,
      pauseOnLabelChange: false,
      headTailSilence: false,
      enforceHeadTailSilence: false,
      discardEmpty: false,
      envCheck: false,
      almostSilent: false,
      peakHigh: false,
    }));
  });
  // Recorder state reads workstation policy during the first React mount. A
  // reload here makes the isolated E2E preference authoritative before any
  // task directory (and its per-task policy copy) is created.
  await page.reload();
  await page.getByTestId('recordings-workspace').waitFor();
  return { app, page, root, output, delivery };
}

async function closeHarness(harness: Harness | null): Promise<void> {
  if (!harness) return;
  await harness.app.close().catch(() => undefined);
  await fs.rm(harness.root, { recursive: true, force: true });
}

async function importScript(
  page: Page,
  source: string,
  fileName = 'p1-flow.csv',
  detector: 'energy' | 'vad' = 'energy',
): Promise<void> {
  await page.getByTestId('new-recording').click();
  await page.getByTestId('setup-workspace').waitFor();
  await page.getByTestId('script-file').setInputFiles({
    name: fileName,
    mimeType: 'text/csv',
    buffer: Buffer.from(source, 'utf8'),
  });
  await expect(page.getByTestId('script-preview-entry')).toBeVisible();
  await expect(page.getByTestId('open-script-preview')).toBeVisible();
  await expect(page.getByTestId('script-import-preview')).toHaveCount(0);
  const detectorOption = page.getByTestId(`detector-${detector}`);
  if (await detectorOption.getAttribute('aria-checked') !== 'true') {
    const advanced = page.getByTestId('setup-detection-advanced');
    if (!await advanced.evaluate((node) => (node as HTMLDetailsElement).open)) {
      await advanced.locator('summary').click();
    }
    await detectorOption.click();
  }
  await expect(detectorOption).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('start-session')).toBeEnabled();
}

async function feedPcm(
  page: Page,
  frames = 48_000,
  pattern: 'silence' | 'speech' = 'speech',
): Promise<void> {
  const response = await page.evaluate(async ({ frameCount, pcmPattern }) => {
    const recorder = (window as unknown as {
      recorder: { e2eFeedPcm?: (payload: {
        frames: number;
        seed: number;
        block_frames: number;
        pattern: 'silence' | 'speech';
      }) => Promise<unknown> };
    }).recorder;
    if (!recorder.e2eFeedPcm) throw new Error('E2E PCM bridge is unavailable');
    return await recorder.e2eFeedPcm({
      frames: frameCount,
      seed: 0x5a17,
      block_frames: 256,
      pattern: pcmPattern,
    });
  }, { frameCount: frames, pcmPattern: pattern });
  expect(response).toMatchObject({ pattern });
}

async function feedPaced(
  page: Page,
  frames: number,
  pattern: 'silence' | 'speech',
): Promise<void> {
  let remaining = frames;
  while (remaining > 0) {
    const chunk = Math.min(12_000, remaining);
    await feedPcm(page, chunk, pattern);
    remaining -= chunk;
    // The production callback is naturally paced by the device. Preserve a
    // telemetry window between synthetic batches so this remains a UI/system
    // test instead of an unrealistic single-turn burst benchmark.
    await page.waitForTimeout(50);
  }
}

async function waitForInputAuditionGate(page: Page): Promise<'prompt' | 'decided'> {
  const dialog = page.getByTestId('input-audition-dialog');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await dialog.isVisible().catch(() => false)) return 'prompt';
    const noiseSkip = page.getByTestId('noise-skip-check');
    if (await noiseSkip.isVisible().catch(() => false)) {
      await noiseSkip.click();
      continue;
    }
    try {
      const audition = (await readEngineState(page)).snapshot.input_audition;
      if ((audition?.status === 'confirmed' || audition?.status === 'skipped')
        && audition.decision_source === 'launch_cache') return 'decided';
    } catch {
      // The engine may still be transitioning from activation to the entry gates.
    }
    await page.waitForTimeout(100);
  }
  throw new Error('input audition gate did not settle within 30 seconds');
}

async function skipInputAuditionIfPrompted(page: Page): Promise<void> {
  const dialog = page.getByTestId('input-audition-dialog');
  if (await waitForInputAuditionGate(page) === 'decided') return;

  await page.getByTestId('input-audition-skip').click();
  const confirmation = page.getByTestId('input-audition-skip-confirm');
  await expect(confirmation).toBeVisible();
  await confirmation.click();
  await expect(dialog).toBeHidden();
}

async function confirmInputAudition(page: Page): Promise<void> {
  const dialog = page.getByTestId('input-audition-dialog');
  expect(await waitForInputAuditionGate(page)).toBe('prompt');
  await expect(dialog).toBeVisible();
  await page.getByTestId('input-audition-start').click();
  await expect(page.getByTestId('input-audition-progress')).toBeVisible();
  await feedPaced(page, 480_000, 'speech');
  const audio = page.getByTestId('input-audition-audio');
  await expect(audio).toBeVisible({ timeout: 15_000 });
  await audio.evaluate((node) => node.dispatchEvent(new Event('ended')));
  await page.getByTestId('input-audition-confirm').click();
  await expect(dialog).toBeHidden();
}

async function enterCreatedRecording(page: Page): Promise<void> {
  await page.getByTestId('start-session').click();
  await page.getByTestId('recording-workspace').waitFor();
  await skipInputAuditionIfPrompted(page);
}

async function enterHistoricalRecording(page: Page): Promise<void> {
  await page.getByTestId('record-recording').first().click();
  await page.getByTestId('recording-workspace').waitFor();
  await skipInputAuditionIfPrompted(page);
}

async function feedActiveTake(page: Page, transport: ReturnType<Page['getByTestId']>): Promise<void> {
  await expect(transport).toContainText(/即将开始|完成本句|结束本句/);
  // Keep a half-second margin around the one-second gate so block boundaries
  // and the independently sampled meter cannot make this a threshold-edge test.
  await feedPaced(page, 72_000, 'silence');
  await feedPaced(page, 48_000, 'speech');
  await feedPaced(page, 72_000, 'silence');
  await expect(transport).toContainText(/完成本句|结束本句/);
}

async function feedTakeWithSilenceWarning(
  page: Page,
  transport: ReturnType<Page['getByTestId']>,
): Promise<void> {
  await expect(transport).toContainText(/即将开始|完成本句|结束本句/);
  // Deliberately start with speech and leave only a short tail. These golden
  // flows exercise warning acknowledgement, so they must not depend on
  // platform-specific callback pacing accidentally producing a warning.
  await feedPaced(page, 48_000, 'speech');
  await feedPaced(page, 12_000, 'silence');
  await expect(transport).toContainText(/完成本句|结束本句/);
}

async function disableMandatoryHeadTailGate(page: Page): Promise<void> {
  await page.locator('.monitor-tabs button').filter({ hasText: /设置/ }).click();
  const toggle = page.getByTestId('rule-enforce-head-tail');
  if (await toggle.isChecked()) await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
}

async function setAutomationRule(page: Page, testId: string, enabled: boolean): Promise<void> {
  await page.locator('.monitor-tabs button').filter({ hasText: /设置/ }).click();
  const toggle = page.getByTestId(testId);
  await expect(toggle).toBeEnabled();
  if (await toggle.isChecked() !== enabled) {
    if (enabled) await toggle.check();
    else await toggle.uncheck();
  }
  if (enabled) await expect(toggle).toBeChecked();
  else await expect(toggle).not.toBeChecked();
}

async function expectCompactRetakeDecision(page: Page): Promise<void> {
  const summary = page.getByTestId('retake-decision-summary');
  const previewRetake = page.getByTestId('preview-retake');
  const useRetake = page.locator('[data-testid="main-transport"][data-retake-action="use"]');
  const discardRetake = page.getByTestId('discard-retake');

  await expect(summary).toBeVisible();
  await expect(summary).not.toContainText('两次录音');
  await expect(previewRetake).toHaveCount(1);
  await expect(previewRetake.locator(':scope > .retake-version')).toHaveText('本次重录');
  await expect(previewRetake.locator('strong')).toContainText('试听本次重录');
  await expect(page.getByTestId('retake-current-duration')).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  await expect(page.getByTestId('retake-candidate-duration')).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  await expect(page.getByTestId('retake-current-silence')).toContainText(/首/);
  await expect(page.getByTestId('retake-current-silence')).toContainText(/尾/);
  await expect(page.getByTestId('retake-candidate-silence')).toContainText(/首/);
  await expect(page.getByTestId('retake-candidate-silence')).toContainText(/尾/);
  await expect(useRetake).toHaveCount(1);
  await expect(useRetake.locator('strong')).toHaveText('使用本次重录');
  await expect(discardRetake).toHaveCount(1);
  await expect(discardRetake.locator('span')).toHaveText('保留原录音');

  await expect(page.getByRole('button', { name: /试听原录音/ })).toHaveCount(0);
  await expect(page.getByTestId('version-workbench')).toHaveCount(0);
  await expect(page.locator('.version-comparison, .version-column, .attempt-history, .attempt-history-row')).toHaveCount(0);
}

async function selectRowAndMeasure(page: Page, index: number): Promise<void> {
  const result = await page.evaluate(async (targetIndex) => {
    const rows = [...document.querySelectorAll<HTMLElement>('.professional-item')];
    const target = rows[targetIndex];
    if (!target) return { elapsed: Number.POSITIVE_INFINITY, active: false, visible: false };
    const started = performance.now();
    target.click();
    let active = false;
    let visible = false;
    do {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const bounds = target.getBoundingClientRect();
      active = target.classList.contains('active');
      visible = bounds.bottom > 0 && bounds.top < window.innerHeight;
    } while ((!active || !visible) && performance.now() - started < 1_000);
    return {
      elapsed: performance.now() - started,
      active,
      visible,
    };
  }, index);
  expect(result.active, `row ${index + 1} should be active`).toBe(true);
  expect(result.visible, `row ${index + 1} should be visible`).toBe(true);
  expect(result.elapsed, `row ${index + 1} selection latency`).toBeLessThanOrEqual(200);
}

type E2eAttempt = {
  attempt_id: string;
  status: string;
};

type E2eEngineState = {
  session_dir: string;
  active_attempt: { item_id: string; attempt_id: string } | null;
  snapshot: {
    session_id: string;
    journal_seq: number;
    input_audition?: {
      status: string;
      check_id?: string;
      decision_source?: string;
    } | null;
    audio_format: {
      sample_rate: number;
    };
    items: Array<{
      id: string;
      status: string;
      selected_attempt_id: string | null;
      attempts: E2eAttempt[];
    }>;
  };
};

async function readEngineState(page: Page): Promise<E2eEngineState> {
  return await page.evaluate(async () => {
    const recorder = (window as unknown as {
      recorder: { request<T>(command: string, payload?: unknown): Promise<T> };
    }).recorder;
    return await recorder.request<E2eEngineState>('get_state');
  });
}

async function sha256File(filePath: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

function expectNoSentenceAttempt(state: E2eEngineState): void {
  expect(state.active_attempt).toBeNull();
  for (const item of state.snapshot.items) {
    expect(item.status).toBe('pending');
    expect(item.selected_attempt_id).toBeNull();
    expect(item.attempts).toHaveLength(0);
  }
}

test('real Electron confirms a ten-second input audition without creating a sentence attempt', async () => {
  let harness: Harness | null = null;
  try {
    harness = await launchHarness();
    const { page } = harness;
    await importScript(page, [
      '序号,正文,标签',
      '001,这句只用于验证输入试听不污染句子,输入试听',
    ].join('\n'), 'p1-input-audition-confirm.csv');

    await page.getByTestId('start-session').click();
    await page.getByTestId('recording-workspace').waitFor();
    const dialog = page.getByTestId('input-audition-dialog');
    await expect(dialog).toBeVisible();
    expectNoSentenceAttempt(await readEngineState(page));

    await page.getByTestId('input-audition-start').click();
    await expect(page.getByTestId('input-audition-progress')).toBeVisible();
    await feedPaced(page, 480_000, 'speech');
    const audio = page.getByTestId('input-audition-audio');
    await expect(audio).toBeVisible({ timeout: 15_000 });
    expectNoSentenceAttempt(await readEngineState(page));

    // CI does not have to expose an audible output endpoint. Dispatching the
    // media completion event exercises the dialog's explicit "listened to the
    // end" gate while the captured WAV itself still comes from the real
    // system-test engine and synthetic PCM bridge.
    await audio.evaluate((node) => node.dispatchEvent(new Event('ended')));
    await page.getByTestId('input-audition-confirm').click();
    await expect(dialog).toBeHidden();

    const confirmed = await readEngineState(page);
    expect(confirmed.snapshot.input_audition?.status).toBe('confirmed');
    expectNoSentenceAttempt(confirmed);
  } finally {
    await closeHarness(harness);
  }
});

test('real Electron retries and explicitly skips input audition without shortcut or attempt bleed', async () => {
  let harness: Harness | null = null;
  try {
    harness = await launchHarness();
    const { page } = harness;
    await importScript(page, [
      '序号,正文,标签',
      '001,这句用于验证重试和明确跳过,输入试听',
    ].join('\n'), 'p1-input-audition-retry-skip.csv');

    await page.getByTestId('start-session').click();
    await page.getByTestId('recording-workspace').waitFor();
    const dialog = page.getByTestId('input-audition-dialog');
    await expect(dialog).toBeVisible();
    await page.getByTestId('input-audition-start').click();
    await feedPaced(page, 480_000, 'speech');
    await expect(page.getByTestId('input-audition-audio')).toBeVisible({ timeout: 15_000 });
    const firstCheckId = (await readEngineState(page)).snapshot.input_audition?.check_id;
    expect(firstCheckId).toBeTruthy();

    await page.getByTestId('input-audition-retry').click();
    await expect(page.getByTestId('input-audition-progress')).toBeVisible();
    const retryState = await readEngineState(page);
    expect(retryState.snapshot.input_audition?.status).toBe('recording');
    expect(retryState.snapshot.input_audition?.check_id).not.toBe(firstCheckId);
    expectNoSentenceAttempt(retryState);

    const transportBefore = (await page.getByTestId('main-transport').textContent()) ?? '';
    // Focus the modal surface itself: Space on a focused button is expected
    // browser activation and is not shortcut bleed from the workspace.
    await dialog.focus();
    await page.keyboard.press('r');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('main-transport')).toHaveText(transportBefore);
    expectNoSentenceAttempt(await readEngineState(page));

    // A recording-phase audition must be cancelled before it can be skipped;
    // reopen the still-blocked gate and then exercise the explicit decision.
    await dialog.getByRole('button', { name: '取消试听' }).click();
    await expect(dialog).toBeHidden();
    await page.getByTestId('main-transport').click();
    await expect(dialog).toBeVisible();
    await page.getByTestId('input-audition-skip').click();
    await page.getByTestId('input-audition-skip-cancel').click();
    await expect(dialog).toBeVisible();
    const returnedToAudition = await readEngineState(page);
    expect(returnedToAudition.snapshot.input_audition ?? null).toBeNull();
    expectNoSentenceAttempt(returnedToAudition);

    await page.getByTestId('input-audition-skip').click();
    await page.getByTestId('input-audition-skip-confirm').click();
    await expect(dialog).toBeHidden();
    const skipped = await readEngineState(page);
    expect(skipped.snapshot.input_audition?.status).toBe('skipped');
    expectNoSentenceAttempt(skipped);
  } finally {
    await closeHarness(harness);
  }
});

test('real Electron scopes audition reuse to one launch and one capture configuration', async () => {
  let harness: Harness | null = null;
  try {
    harness = await launchHarness();
    let { page } = harness;
    const dialog = () => page.getByTestId('input-audition-dialog');
    const explicitlySkip = async () => {
      await page.getByTestId('input-audition-skip').click();
      await expect(page.getByTestId('input-audition-skip-confirm')).toBeVisible();
      await page.getByTestId('input-audition-skip-confirm').click();
      await expect(dialog()).toBeHidden();
    };
    const pauseToHome = async () => {
      await page.getByTestId('finish-session').click();
      await expect(page.getByTestId('pause-confirm')).toBeVisible();
      await page.getByTestId('pause-confirm').click();
      await page.getByTestId('recordings-workspace').waitFor();
    };

    await importScript(page, [
      '序号,正文,标签',
      '001,验证手动重新试听取消后仍然阻断,试听缓存',
    ].join('\n'), 'p1-audition-cache-first.csv');
    await page.getByTestId('start-session').click();
    await page.getByTestId('recording-workspace').waitFor();
    await expect(dialog()).toBeVisible();
    await explicitlySkip();

    await page.locator('.monitor-tabs button').filter({ hasText: /任务/ }).click();
    await page.getByTestId('recheck-input-audition').click();
    await expect(dialog()).toBeVisible();
    await dialog().focus();
    await page.keyboard.press('Escape');
    await expect(dialog()).toBeHidden();
    expectNoSentenceAttempt(await readEngineState(page));

    const transport = page.getByTestId('main-transport');
    await expect(transport).toContainText('输入试听');
    await transport.click();
    await expect(dialog()).toBeVisible();
    expectNoSentenceAttempt(await readEngineState(page));
    await explicitlySkip();
    await pauseToHome();

    await importScript(page, [
      '序号,正文,标签',
      '001,同次启动与同一采集配置应复用决定,试听缓存',
    ].join('\n'), 'p1-audition-cache-second.csv');
    await page.getByTestId('start-session').click();
    await page.getByTestId('recording-workspace').waitFor();
    // The cache lookup may briefly own the modal while IPC is pending, but it
    // must settle without asking the operator for another decision.
    await expect.poll(async () => {
      try {
        return (await readEngineState(page)).snapshot.input_audition?.decision_source ?? 'none';
      } catch {
        return 'starting';
      }
    }, { timeout: 10_000 }).toBe('launch_cache');
    await expect(dialog()).toBeHidden();
    const reused = await readEngineState(page);
    expect(reused.snapshot.input_audition).toMatchObject({
      status: 'skipped',
      decision_source: 'launch_cache',
    });
    expectNoSentenceAttempt(reused);
    const reusedSessionId = reused.snapshot.session_id;
    await pauseToHome();

    await harness.app.close();
    harness = await launchHarness(harness.root);
    page = harness.page;
    const resumedRow = page.locator('.home-recording-row').filter({ hasText: reusedSessionId });
    await resumedRow.getByTestId('record-recording').click();
    await page.getByTestId('recording-workspace').waitFor();
    await expect(dialog()).toBeVisible({ timeout: 10_000 });
    expectNoSentenceAttempt(await readEngineState(page));
    await explicitlySkip();

    // The synthetic CI input exposes one fixed hardware format. Exercise the
    // main-process authority boundary directly: a renderer lookup for a
    // different capture configuration must never receive this task's cached
    // decision, which makes the normal workspace flow show the audition gate.
    const changedConfigurationDecision = await page.evaluate(async () => {
      const recorder = (window as unknown as {
        recorder: {
          request<T>(command: string, payload?: unknown): Promise<T>;
          getInputAuditionDecision(configuration: unknown): Promise<unknown>;
        };
      }).recorder;
      const state = await recorder.request<{
        snapshot: {
          capture_backend?: string;
          device_name: string;
          device_id?: string;
          input_sample_format?: string;
          capture_share_mode?: string;
          requested_capture_buffer_frames?: number;
          capture_buffer_frames?: number;
          audio_format: {
            sample_rate: number;
            bit_depth: number;
            input_channels: number;
            input_channel?: number;
          };
        };
      }>('get_state');
      const snapshot = state.snapshot;
      return await recorder.getInputAuditionDecision({
        backend: snapshot.capture_backend ?? 'unknown',
        deviceName: snapshot.device_name,
        deviceId: snapshot.device_id,
        sampleRate: snapshot.audio_format.sample_rate * 2,
        outputBitDepth: snapshot.audio_format.bit_depth,
        inputSampleFormat: snapshot.input_sample_format ?? `i${snapshot.audio_format.bit_depth}`,
        inputChannels: snapshot.audio_format.input_channels,
        inputChannel: snapshot.audio_format.input_channel ?? 1,
        shareMode: snapshot.capture_share_mode ?? 'exclusive',
        requestedBufferFrames: snapshot.requested_capture_buffer_frames ?? null,
        actualBufferFrames: snapshot.capture_buffer_frames ?? null,
      });
    });
    expect(changedConfigurationDecision).toBeNull();
  } finally {
    await closeHarness(harness);
  }
});

test('real Electron uses default VAD for a complete first-take confirmation flow', async () => {
  let harness: Harness | null = null;
  try {
    harness = await launchHarness();
    const { page } = harness;
    await importScript(page, [
      '序号,正文,标签',
      '001,请保持正常语速和音量,VAD 黄金流程',
    ].join('\n'), 'p1-default-vad.csv', 'vad');
    await enterCreatedRecording(page);
    await disableMandatoryHeadTailGate(page);
    await page.locator('.monitor-tabs button').filter({ hasText: /检测/ }).click();

    const selectedDetector = page.getByTestId('detector-vad');
    await expect(selectedDetector).toHaveAttribute('aria-checked', 'true');
    await expect(selectedDetector).toBeDisabled();
    const currentRow = page.locator('.professional-item.active');
    await expect(currentRow).toHaveCount(1);
    await expect(currentRow.locator('.item-current-flag')).toHaveText('当前句子');

    const transport = page.getByTestId('main-transport');
    await transport.click();
    await expect(page.locator('.professional-item-list.recording .professional-item.active')).toHaveCount(1);
    await feedActiveTake(page, transport);
    await transport.click();
    await expect(transport).toContainText(/确认|采用/);
    await transport.click();
    await expect(transport).toContainText(/全部完成|完成采集/);
    await expect(page.locator('.professional-item').first().locator('.item-state')).toHaveClass(/\baccepted\b/);
  } finally {
    await closeHarness(harness);
  }
});

test('real Electron preserves first-take rhythm across a label boundary', async () => {
  let harness: Harness | null = null;
  try {
    harness = await launchHarness();
    const { page } = harness;
    await importScript(page, [
      '序号,正文,标签',
      '001,请保持正常语速,正常语速',
      '002,请继续保持正常语速,正常语速',
      '003,请使用较慢语速,较慢语速',
    ].join('\n'));
    await enterCreatedRecording(page);
    await disableMandatoryHeadTailGate(page);

    const transport = page.getByTestId('main-transport');
    await transport.click();
    await feedActiveTake(page, transport);
    await transport.click();
    await expect(transport).toContainText(/确认|采用/);
    await transport.click();
    await expect(page.locator('.professional-item.active')).toContainText('002');
    await expect(page.locator('.editor-nav span')).toHaveText('2 / 3');
    await expect(transport).toHaveClass(/\b(?:waiting|stop|accept)\b/);
    await feedActiveTake(page, transport);
    await transport.click();
    await transport.click();
    await expect(page.locator('.professional-item.active')).toContainText('003');
    await expect(page.locator('.editor-nav span')).toHaveText('3 / 3');
    await expect(transport).toHaveClass(/\b(?:waiting|stop|accept)\b/);
    const labelTransition = page.locator('.label-transition-chip');
    await expect(labelTransition).toBeVisible();
    await expect(labelTransition).toHaveText('标签已变化');
    await expect(labelTransition).not.toContainText('正常语速');
    await expect(labelTransition).not.toContainText('较慢语速');
    await expect(labelTransition).not.toContainText('请核对当前标签');
    const labelAnimation = await labelTransition.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        name: style.animationName,
        iterations: style.animationIterationCount,
      };
    });
    expect(labelAnimation.name).toBe('label-change-notice-in');
    expect(labelAnimation.iterations).toBe('1');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(async () => labelTransition.evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
    await feedActiveTake(page, transport);
    await transport.click();
    await transport.click();
    await expect(transport).toContainText(/完成|结束/);
  } finally {
    await closeHarness(harness);
  }
});

test('real Electron keeps the selected take and continues handled retakes with Space without auto-recording', async () => {
  let harness: Harness | null = null;
  try {
    harness = await launchHarness();
    const { page } = harness;
    await importScript(page, [
      '序号,正文,标签',
      '001,这是此前已确认录音,同一标签',
      '002,这是物理下一句,同一标签',
    ].join('\n'));
    await enterCreatedRecording(page);
    await disableMandatoryHeadTailGate(page);

    const transport = page.getByTestId('main-transport');
    await transport.click();
    await feedActiveTake(page, transport);
    await transport.click();
    await expect(transport).toContainText(/确认|采用/);
    await transport.click();

    await expect(page.locator('.professional-item.active')).toContainText('002');
    await feedActiveTake(page, transport);
    await transport.click();
    await expect(transport).toContainText(/确认|采用/);
    await transport.click();
    await expect(transport).toContainText(/全部完成|完成采集/);

    const firstItem = page.locator('.professional-item').first();
    await firstItem.click();
    await expect(firstItem).toHaveClass(/\bactive\b/);
    await page.keyboard.press('r');
    await feedActiveTake(page, transport);
    await transport.click();

    await expectCompactRetakeDecision(page);
    const beforeDecision = await readEngineState(page);
    const beforeItem = beforeDecision.snapshot.items[0];
    const retainedAttemptId = beforeItem.selected_attempt_id;
    const candidate = beforeItem.attempts.find((attempt) => (
      attempt.attempt_id !== retainedAttemptId && attempt.status === 'recorded'
    ));
    expect(retainedAttemptId).toBeTruthy();
    expect(candidate, 'retake should create a safe candidate').toBeTruthy();
    await expect(page.locator('body')).not.toContainText(retainedAttemptId!);
    await expect(page.locator('body')).not.toContainText(candidate!.attempt_id);

    await page.getByTestId('preview-retake').click();
    await expect(page.getByTestId('preview-player')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(retainedAttemptId!);
    await expect(page.locator('body')).not.toContainText(candidate!.attempt_id);
    await page.getByTestId('preview-player-close').click();
    await expect(page.getByTestId('preview-player')).toBeHidden();

    await page.getByTestId('discard-retake').click();
    const afterDecision = await readEngineState(page);
    expect(afterDecision.snapshot.items[0].selected_attempt_id).toBe(retainedAttemptId);
    expect(afterDecision.snapshot.items[0].attempts.find((attempt) => (
      attempt.attempt_id === candidate!.attempt_id
    ))?.status).toBe('rejected_by_operator');

    await expect(page.locator('.professional-item.active')).toContainText('002');
    await expect(transport).toContainText('重录本句');
    await expect(transport).toHaveAttribute('data-retake-sequence', 'ready');
    await expect(transport).not.toHaveClass(/\b(stop|waiting)\b/);
    await expect(page.getByTestId('finish-retake-sequence')).toContainText('完成采集');

    await transport.click();
    await expect(transport).toHaveClass(/\b(?:waiting|stop|accept)\b/);
    await feedActiveTake(page, transport);
    await transport.click();
    await expectCompactRetakeDecision(page);
    await page.getByTestId('discard-retake').click();

    await expect(page.locator('.professional-item.active')).toContainText('002');
    await expect(transport).toContainText(/全部完成|完成采集/);
    await expect(transport).not.toHaveAttribute('data-retake-sequence', 'ready');
  } finally {
    await closeHarness(harness);
  }
});

test('real Electron restores local item context and an undecided take without ghost recording', async () => {
  let harness: Harness | null = null;
  try {
    harness = await launchHarness();
    const { page, root } = harness;
    await importScript(page, [
      '序号,正文,标签',
      '001,第一句已确认,同一标签',
      '002,第二句等待确认,同一标签',
    ].join('\n'));
    await enterCreatedRecording(page);
    await disableMandatoryHeadTailGate(page);

    let transport = page.getByTestId('main-transport');
    await transport.click();
    await feedActiveTake(page, transport);
    await transport.click();
    await expect(transport).toContainText(/确认|采用/);
    await transport.click();
    await expect(page.locator('.professional-item.active')).toContainText('002');
    await feedActiveTake(page, transport);
    await transport.click();
    await expect(transport).toContainText(/确认|采用/);

    await harness.app.close();
    harness = await launchHarness(root);
    await harness.page.getByTestId('handle-recording-issues').first().click();
    await harness.page.getByTestId('recording-workspace').waitFor();
    transport = harness.page.getByTestId('main-transport');

    await expect(harness.page.locator('.monitor-tabs button.active')).toContainText('问题');
    await expect(harness.page.getByTestId('issue-workbench')).toBeVisible();
    await expect(harness.page.getByTestId('issue-workbench').locator('.issue-list > button.active')).toHaveCount(1);
    await expect(harness.page.locator('.professional-item.active')).toContainText('002');
    await expect(transport).toContainText('试听本句');
    await expect(transport).not.toContainText(/完成本句|结束本句/);
  } finally {
    await closeHarness(harness);
  }
});

test('real Electron separates current-task recording settings from new-task defaults', async () => {
  let harness: Harness | null = null;
  try {
    harness = await launchHarness();
    const { page, root } = harness;
    await importScript(page, [
      '序号,正文,标签',
      '001,第一句使用同一标签,标签甲',
      '002,第二句切换新的标签,标签乙',
    ].join('\n'), 'recording-settings-scope.csv');
    await enterCreatedRecording(page);
    await page.locator('.monitor-tabs button').filter({ hasText: /^设置$/ }).click();

    const taskAutoNext = page.getByTestId('rule-auto-start-next');
    const taskLabelPause = page.getByTestId('rule-pause-on-label-change');
    await expect(taskAutoNext).toBeChecked();
    await taskLabelPause.check();
    await expect(page.locator('.continuous-rule-summary')).toContainText('同标签连续录制，标签变化时暂停');
    await taskAutoNext.uncheck();
    await expect(taskLabelPause).toBeChecked();
    await expect(taskLabelPause).toBeDisabled();
    await expect(page.locator('.continuous-rule-summary')).toContainText('每句确认后停在下一句');
    if (process.env.DATABAKER_UPDATE_MANUAL_CAPTURES === '1') {
      const taskEnvCheck = page.getByTestId('rule-env-check');
      const noiseDialog = page.getByRole('dialog', { name: /环境噪声检测/ });
      if (await noiseDialog.isVisible().catch(() => false) && !await taskEnvCheck.isChecked()) {
        await taskEnvCheck.check({ force: true });
      }
      if (await taskEnvCheck.isChecked()) await taskEnvCheck.uncheck({ force: true });
      await expect(noiseDialog).toHaveCount(0);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await expect(page.locator('.monitor-tabs button.active')).toContainText('设置');
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(workspace, 'doc', '手册', 'captures', '13-recording-settings.jpg'), type: 'jpeg', quality: 90 });
    }

    await page.getByTestId('edit-new-task-defaults').click();
    const defaults = page.getByTestId('settings-recording-defaults');
    await defaults.locator('summary').click();
    await expect(page.getByTestId('settings-rule-auto-start-next')).toBeChecked();
    await expect(page.getByTestId('settings-rule-pause-on-label-change')).not.toBeChecked();
    await page.getByRole('button', { name: '完成' }).click();
    if (process.env.DATABAKER_UPDATE_MANUAL_CAPTURES === '1') {
      await page.locator('.monitor-tabs button').filter({ hasText: /检测/ }).click();
      await expect(page.locator('.monitor-tabs button.active')).toContainText('检测');
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(workspace, 'doc', '手册', 'captures', '09-detection.jpg'), type: 'jpeg', quality: 90 });
      await page.locator('.monitor-tabs button').filter({ hasText: /^设置$/ }).click();
    }

    await harness.app.close();
    harness = await launchHarness(root);
    await enterHistoricalRecording(harness.page);
    await expect(harness.page.getByTestId('task-recording-settings')).toBeVisible();
    await expect(harness.page.getByTestId('rule-auto-start-next')).not.toBeChecked();
    await expect(harness.page.getByTestId('rule-pause-on-label-change')).toBeChecked();
    await expect(harness.page.getByTestId('rule-pause-on-label-change')).toBeDisabled();
  } finally {
    await closeHarness(harness);
  }
});

test('real Electron derives confirmed-only and complete-task export gates from task state', async () => {
  let harness: Harness | null = null;
  try {
    harness = await launchHarness();
    const { page } = harness;
    await importScript(page, [
      '序号,正文,标签',
      '001,这一句将被确认,导出范围',
      '002,这一句保持未录,导出范围',
    ].join('\n'), 'p1-export-scopes.csv');
    await enterCreatedRecording(page);
    await disableMandatoryHeadTailGate(page);
    await setAutomationRule(page, 'rule-auto-start-next', false);

    const transport = page.getByTestId('main-transport');
    await transport.click();
    await feedTakeWithSilenceWarning(page, transport);
    await transport.click();
    await expect(transport).toContainText(/确认|采用/);
    await transport.click();
    await expect(page.locator('.professional-item.active')).toContainText('002');
    await expect(transport).not.toContainText(/完成本句|结束本句/);

    await page.locator('.monitor-tabs button').filter({ hasText: /导出/ }).click();
    const scopeButtons = page.locator('.export-scope-control > button');
    const readiness = page.locator('.export-readiness');
    const cutsButton = page.getByRole('button', { name: /分段 ZIP/ });

    await expect(scopeButtons.nth(0)).toHaveClass(/\bactive\b/);
    await expect(readiness).toHaveClass(/\bwarning\b/);
    await expect(readiness).toContainText(/包含\s*1/);
    await expect(readiness).toContainText(/排除\s*1/);
    await expect(readiness).toContainText(/阻断\s*0/);
    const warningChecks = page.locator('.export-warning-acks input[type="checkbox"]');
    await expect(warningChecks.first()).toBeVisible();
    await expect(cutsButton).toBeDisabled();
    for (let index = 0; index < await warningChecks.count(); index += 1) {
      await warningChecks.nth(index).check();
    }
    await expect(cutsButton).toBeEnabled();

    await scopeButtons.nth(1).click();
    await expect(scopeButtons.nth(1)).toHaveClass(/\bactive\b/);
    await expect(readiness).toHaveClass(/\bblocked\b/);
    await expect(readiness).toContainText(/包含\s*1/);
    await expect(readiness).toContainText(/阻断\s*[1-9]/);
    await expect(cutsButton).toBeDisabled();

    await scopeButtons.nth(0).click();
    await expect(cutsButton).toBeDisabled();
    for (let index = 0; index < await warningChecks.count(); index += 1) {
      await warningChecks.nth(index).check();
    }
    await expect(cutsButton).toBeEnabled();
  } finally {
    await closeHarness(harness);
  }
});

test('real Electron filters and locates current-task issues without starting a recording', async () => {
  let harness: Harness | null = null;
  try {
    harness = await launchHarness();
    const { page } = harness;
    await importScript(page, [
      '序号,正文,标签',
      '001,已确认但保留首尾静音警告,问题工作台',
      '002,本句停在待确认状态,问题工作台',
    ].join('\n'), 'p1-issue-workbench.csv');
    await enterCreatedRecording(page);
    await disableMandatoryHeadTailGate(page);

    const transport = page.getByTestId('main-transport');
    await transport.click();
    await feedTakeWithSilenceWarning(page, transport);
    await transport.click();
    await expect(transport).toContainText(/确认|采用/);
    await transport.click();
    await expect(page.locator('.professional-item.active')).toContainText('002');
    await feedActiveTake(page, transport);
    await transport.click();
    await expect(transport).toContainText(/确认|采用/);
    expect((await readEngineState(page)).active_attempt).toBeNull();

    await page.locator('.monitor-tabs button').filter({ hasText: /问题/ }).click();
    const workbench = page.getByTestId('issue-workbench');
    await expect(workbench).toBeVisible();
    const filters = workbench.locator('.issue-filters > button');
    const issues = workbench.locator('.issue-list > button');

    await filters.filter({ hasText: '警告' }).click();
    await expect(issues.first()).toBeVisible();
    expect(await issues.count()).toBeGreaterThan(0);
    for (let index = 0; index < await issues.count(); index += 1) {
      await expect(issues.nth(index)).toHaveClass(/\bwarning\b/);
    }
    const firstItemWarning = issues.filter({ hasText: '001' }).first();
    await expect(firstItemWarning).toBeVisible();
    await firstItemWarning.click();
    await expect(page.locator('.professional-item.active')).toContainText('001');
    await expect(transport).not.toHaveClass(/\bstop\b/);
    expect((await readEngineState(page)).active_attempt).toBeNull();

    await filters.filter({ hasText: '阻断' }).click();
    await expect(issues.first()).toBeVisible();
    expect(await issues.count()).toBeGreaterThan(0);
    for (let index = 0; index < await issues.count(); index += 1) {
      await expect(issues.nth(index)).toHaveClass(/\bblocker\b/);
    }
    const secondItemBlocker = issues.filter({ hasText: '002' }).first();
    await expect(secondItemBlocker).toBeVisible();
    await secondItemBlocker.click();
    await expect(page.locator('.professional-item.active')).toContainText('002');
    await expect(transport).toContainText(/确认|采用/);
    await expect(transport).not.toHaveClass(/\bstop\b/);
    expect((await readEngineState(page)).active_attempt).toBeNull();

    await filters.filter({ hasText: '全部' }).click();
    await expect(issues.first()).toBeVisible();
    expect(await issues.count()).toBeGreaterThan(1);
  } finally {
    await closeHarness(harness);
  }
});

test('real Electron closes the issue queue and exposes one explicit path to delivery', async () => {
  let harness: Harness | null = null;
  try {
    harness = await launchHarness();
    const { page } = harness;
    await importScript(page, [
      '序号,正文,标签',
      '001,这句在问题队列中确认后前往交付,闭环',
    ].join('\n'), 'p1-issue-to-delivery.csv');
    await enterCreatedRecording(page);
    await disableMandatoryHeadTailGate(page);
    await setAutomationRule(page, 'rule-head-tail', false);

    const transport = page.getByTestId('main-transport');
    await transport.click();
    await feedTakeWithSilenceWarning(page, transport);
    await transport.click();
    await expect(transport).toContainText(/确认|采用/);
    expect((await readEngineState(page)).active_attempt).toBeNull();

    await page.locator('.monitor-tabs button').filter({ hasText: /问题/ }).click();
    const workbench = page.getByTestId('issue-workbench');
    await expect(workbench.locator('.issue-list > button')).toHaveCount(1);
    await workbench.locator('.issue-list > button').click();
    await workbench.locator('.issue-resolution-actions .primary').click();

    const goToDelivery = page.getByTestId('go-to-delivery');
    await expect(goToDelivery).toBeVisible();
    await expect(workbench.locator('.issue-list > button')).toHaveCount(0);
    expect((await readEngineState(page)).active_attempt).toBeNull();
    await goToDelivery.click();
    await expect(page.locator('.monitor-tabs button.active')).toContainText('导出');
  } finally {
    await closeHarness(harness);
  }
});

test('real Electron home warning action opens export review instead of restoring an old panel', async () => {
  let harness: Harness | null = null;
  try {
    harness = await launchHarness();
    const { page } = harness;
    await importScript(page, [
      '序号,正文,标签',
      '001,这句保留首尾静音告警用于交付复核,首页直达',
    ].join('\n'), 'p1-home-warning-export.csv');
    await enterCreatedRecording(page);
    await disableMandatoryHeadTailGate(page);
    await setAutomationRule(page, 'rule-head-tail', true);

    const transport = page.getByTestId('main-transport');
    await transport.click();
    await feedTakeWithSilenceWarning(page, transport);
    await transport.click();
    await expect(transport).toContainText(/确认|采用/);
    await transport.click();
    await expect(transport).toContainText(/全部完成|完成采集/);
    const sessionId = (await readEngineState(page)).snapshot.session_id;

    // Save an unrelated panel in local workspace context first. The home
    // primary action must override it with export review.
    await page.locator('.monitor-tabs button').filter({ hasText: /^设置$/ }).click();
    await transport.click();
    await expect(page.getByTestId('finish-confirm')).toBeVisible();
    await page.getByTestId('finish-confirm').click();
    await expect(page.getByTestId('enter-capture')).toBeVisible();
    await page.getByTestId('finish-session').click();
    await page.getByTestId('recordings-workspace').waitFor();

    const warningRow = page.locator('.home-recording-row').filter({ hasText: sessionId });
    const reviewAndDeliver = warningRow.getByTestId('view-recording');
    await expect(reviewAndDeliver).toHaveText('复核并交付');
    await reviewAndDeliver.click();
    await page.getByTestId('recording-workspace').waitFor();
    await expect(page.locator('.monitor-tabs button.active')).toContainText('导出');
  } finally {
    await closeHarness(harness);
  }
});

test('real Electron rejects a stale offline attempt switch without changing the selected version', async () => {
  let harness: Harness | null = null;
  try {
    harness = await launchHarness();
    const { page } = harness;
    await importScript(page, [
      '序号,正文,标签',
      '001,用自然修订变化制造过期版本切换,版本安全',
    ].join('\n'), 'p1-stale-attempt.csv');
    await enterCreatedRecording(page);
    await disableMandatoryHeadTailGate(page);

    const transport = page.getByTestId('main-transport');
    await transport.click();
    await feedActiveTake(page, transport);
    await transport.click();
    await expect(transport).toContainText(/确认|采用/);
    await transport.click();
    await expect(transport).toContainText(/全部完成|完成采集/);

    const item = page.locator('.professional-item').first();
    await item.click();
    await page.keyboard.press('r');
    await feedActiveTake(page, transport);
    await transport.click();
    await expectCompactRetakeDecision(page);

    const beforeDecision = await readEngineState(page);
    const beforeItem = beforeDecision.snapshot.items[0];
    const retainedAttemptId = beforeItem.selected_attempt_id;
    const candidate = beforeItem.attempts.find((attempt) => (
      attempt.attempt_id !== retainedAttemptId && attempt.status === 'recorded'
    ));
    expect(retainedAttemptId).toBeTruthy();
    expect(candidate, 'retake should create a safe candidate').toBeTruthy();
    const staleJournalSeq = beforeDecision.snapshot.journal_seq;

    await page.getByTestId('discard-retake').click();
    const afterDecision = await readEngineState(page);
    expect(afterDecision.snapshot.journal_seq).toBeGreaterThan(staleJournalSeq);
    expect(afterDecision.snapshot.items[0].selected_attempt_id).toBe(retainedAttemptId);

    await page.getByTestId('pause-capture').click();
    await page.getByTestId('pause-confirm').click();
    await expect(page.getByTestId('pause-confirm')).toBeHidden();
    await expect(page.getByTestId('pause-capture')).toBeHidden();

    const staleResult = await page.evaluate(async (request) => {
      const recorder = (window as unknown as {
        recorder: { request<T>(command: string, payload?: unknown): Promise<T> };
      }).recorder;
      try {
        await recorder.request('select_session_attempt', request);
        return { ok: true, message: '' };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    }, {
      session_dir: afterDecision.session_dir,
      item_id: beforeItem.id,
      attempt_id: candidate!.attempt_id,
      expected_journal_seq: staleJournalSeq,
    });
    expect(staleResult.ok).toBe(false);
    expect(staleResult.message).toMatch(/journal_seq|任务已在其他窗口变更/);

    const inspected = await page.evaluate(async (sessionDir) => {
      const recorder = (window as unknown as {
        recorder: { request<T>(command: string, payload?: unknown): Promise<T> };
      }).recorder;
      return await recorder.request<{ snapshot: E2eEngineState['snapshot'] }>('inspect_session', {
        session_dir: sessionDir,
      });
    }, afterDecision.session_dir);
    expect(inspected.snapshot.journal_seq).toBeGreaterThan(staleJournalSeq);
    expect(inspected.snapshot.items[0].selected_attempt_id).toBe(retainedAttemptId);
    expect(inspected.snapshot.items[0].attempts).toHaveLength(2);
  } finally {
    await closeHarness(harness);
  }
});

test('real Electron exports cuts, verifies the external copy, writes a receipt, and reverifies after restart', async () => {
  let harness: Harness | null = null;
  try {
    harness = await launchHarness();
    const { page, root, delivery } = harness;
    await importScript(page, [
      '序号,正文,标签',
      '001,完整任务切片将复制到外部交付目录,可靠交付',
    ].join('\n'), 'p1-reliable-delivery.csv');
    await page.getByTestId('start-session').click();
    await page.getByTestId('recording-workspace').waitFor();
    await confirmInputAudition(page);
    await disableMandatoryHeadTailGate(page);
    await setAutomationRule(page, 'rule-head-tail', false);
    await setAutomationRule(page, 'rule-discard-empty', true);

    const transport = page.getByTestId('main-transport');
    await transport.click();
    await feedActiveTake(page, transport);
    await transport.click();
    await expect(transport).toContainText(/确认|采用/);
    await transport.click();
    await expect(transport).toContainText(/全部完成|完成采集/);
    const beforeExport = await readEngineState(page);
    const sessionDir = beforeExport.session_dir;
    const sessionId = beforeExport.snapshot.session_id;

    // Delivery is an offline operation on Windows. Close the capture stream
    // first so the test exercises the real safe-stop -> inspect -> deliver
    // workflow instead of relying on platform-specific open-file semantics.
    await transport.click();
    await expect(page.getByTestId('finish-confirm')).toBeVisible();
    await page.getByTestId('finish-confirm').click();
    await expect(page.getByTestId('enter-capture')).toBeVisible();

    await page.locator('.monitor-tabs button').filter({ hasText: /导出/ }).click();
    const scopeButtons = page.locator('.export-scope-control > button');
    await scopeButtons.nth(1).click();
    const readiness = page.locator('.export-readiness');
    await expect(readiness).toHaveClass(/\bclear\b/);
    await expect(readiness).toContainText(/包含\s*1/);
    await expect(readiness).toContainText(/排除\s*0/);
    await expect(readiness).toContainText(/阻断\s*0/);
    await expect(page.locator('.export-warning-acks')).toHaveCount(0);

    await page.getByTestId('choose-export-dir').click();
    await expect(page.locator('.export-destination code')).toHaveText(delivery);
    const cutsButton = page.getByRole('button', { name: /分段 ZIP/ });
    await expect(cutsButton).toBeEnabled();
    await cutsButton.click();

    const resultDialog = page.getByTestId('export-result-dialog');
    await expect(resultDialog).toBeVisible();
    const resultTitle = resultDialog.locator('#export-result-title');
    await expect(resultTitle).toContainText(/导出完成|导出失败/, {
      timeout: 30_000,
    });
    if ((await resultTitle.textContent())?.includes('导出失败')) {
      const reason = await resultDialog.locator('.dialog-warning.danger').textContent();
      throw new Error(`cuts export failed: ${reason || '未返回错误原因'}`);
    }
    await expect(resultDialog.locator('.dialog-icon')).toHaveClass(/\bsuccess\b/);
    await expect(resultDialog).not.toContainText(/外部交付未完成/);

    const status = JSON.parse(await fs.readFile(
      path.join(sessionDir, 'export', 'status-cuts-zip.json'),
      'utf8',
    )) as {
      status: string;
      export_id: string;
      session_id: string;
      artifact: string;
      scope: string;
      sha256: string;
      manifest_file: string;
    };
    expect(status).toMatchObject({
      status: 'complete',
      session_id: sessionId,
      artifact: 'cuts_zip',
      scope: 'complete_task',
      manifest_file: 'cuts-manifest.json',
    });
    expect(status.export_id).toBeTruthy();
    expect(status.sha256).toMatch(/^[a-f0-9]{64}$/);

    const manifest = JSON.parse(await fs.readFile(
      path.join(sessionDir, 'export', status.manifest_file),
      'utf8',
    )) as {
      export_id: string;
      session_id: string;
      scope: string;
      included: unknown[];
      excluded: unknown[];
      warnings: Array<{ code: string }>;
      acknowledged_warning_codes: string[];
    };
    expect(manifest).toMatchObject({
      export_id: status.export_id,
      session_id: sessionId,
      scope: 'complete_task',
    });
    expect(manifest.included).toHaveLength(1);
    expect(manifest.excluded).toHaveLength(0);
    expect([...manifest.acknowledged_warning_codes].sort()).toEqual(
      [...new Set(manifest.warnings.map(({ code }) => code))].sort(),
    );

    const deliveredFiles = (await fs.readdir(delivery)).filter((name) => !name.endsWith('.partial'));
    expect(deliveredFiles).toHaveLength(1);
    expect(deliveredFiles[0]).toMatch(/\.zip$/);
    const deliveredFile = path.join(delivery, deliveredFiles[0]);
    expect(await sha256File(deliveredFile)).toBe(status.sha256);

    const receiptsDir = path.join(sessionDir, 'export', 'delivery-receipts');
    const receiptFiles = await fs.readdir(receiptsDir);
    expect(receiptFiles).toHaveLength(1);
    const receipt = JSON.parse(await fs.readFile(path.join(receiptsDir, receiptFiles[0]), 'utf8')) as {
      schema_version: number;
      session_id: string;
      artifact: string;
      export_id: string;
      source_sha256: string;
      destination_dir: string;
      destination_file: string;
    };
    expect(receipt).toMatchObject({
      schema_version: 1,
      session_id: sessionId,
      artifact: 'cuts_zip',
      export_id: status.export_id,
      source_sha256: status.sha256,
      destination_dir: delivery,
      destination_file: deliveredFile,
    });

    await page.getByTestId('export-result-close').click();
    await harness.app.close();
    harness = await launchHarness(root);

    // History loading must reverify the current cuts receipt in the background
    // and retain the returned external directory. No explicit export-dialog
    // visit or verification API call is required after restart.
    const deliveredRow = harness.page.locator('.home-recording-row').filter({ hasText: sessionId });
    await expect(deliveredRow.locator('.row-primary')).toHaveCount(1);
    const viewDelivery = deliveredRow.getByTestId('view-delivery');
    await expect(viewDelivery).toBeVisible({ timeout: 15_000 });
    await expect(viewDelivery).toHaveText('查看交付');
    await expect(viewDelivery).toHaveAttribute('title', delivery);
    await viewDelivery.click();
    await expect(harness.page.locator('.home-notice')).toContainText(/已.*打开/, { timeout: 10_000 });
    await expect(harness.page.getByRole('dialog', { name: '导出当前任务' })).toHaveCount(0);
  } finally {
    await closeHarness(harness);
  }
});

test('real Electron keeps 320 long-label items reachable at target resolutions and Windows 125% scaling', async () => {
  let harness: Harness | null = null;
  try {
    harness = await launchHarness();
    const { page } = harness;
    const rows = ['序号,正文,标签'];
    for (let index = 1; index <= 320; index += 1) {
      const id = String(index).padStart(4, '0');
      rows.push(`${id},这是第 ${index} 条专业音频采录文本,高噪声环境下的长标签条件说明与现场执行备注 ${index}`);
    }
    await importScript(page, rows.join('\n'), 'p1-320-long-labels.csv');
    await enterCreatedRecording(page);
    await disableMandatoryHeadTailGate(page);
    await page.locator('.monitor-tabs button').filter({ hasText: /检测/ }).click();

    const transport = page.getByTestId('main-transport');
    const durationInput = page.getByTestId('task-silence-duration');
    await expect(durationInput).toBeEnabled();
    await durationInput.focus();
    await expect(durationInput).toBeFocused();
    const transportBefore = (await transport.textContent()) ?? '';
    await page.keyboard.press('r');
    await page.keyboard.press('Space');
    await page.waitForTimeout(100);
    await expect(transport).toHaveText(transportBefore);
    await expect(transport).not.toHaveClass(/\bstop\b/);

    const targetSizes = [
      {
        label: 'Windows 1366x768 at 125%',
        width: 1093,
        height: 614,
        deviceScaleFactor: 1.25,
      },
      { label: '1080x700 at 100%', width: 1080, height: 700, deviceScaleFactor: 1 },
      { label: '1280x720 at 100%', width: 1280, height: 720, deviceScaleFactor: 1 },
      { label: '1366x768 at 100%', width: 1366, height: 768, deviceScaleFactor: 1 },
      { label: '1920x1080 at 100%', width: 1920, height: 1080, deviceScaleFactor: 1 },
    ];
    // Native BrowserWindow bounds are clamped by the host work area (for
    // example, a 1080px macOS display exposes less than 1080px below the menu
    // bar). CDP device metrics exercise the real Electron renderer at exact,
    // repeatable CSS viewports on developer machines and Windows CI alike.
    const cdp = await page.context().newCDPSession(page);
    for (const size of targetSizes) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: size.width,
        height: size.height,
        screenWidth: size.width,
        screenHeight: size.height,
        deviceScaleFactor: size.deviceScaleFactor,
        mobile: false,
      });
      await expect.poll(() => page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
        deviceScaleFactor: window.devicePixelRatio,
      }))).toEqual({
        width: size.width,
        height: size.height,
        deviceScaleFactor: size.deviceScaleFactor,
      });

      const layout = await page.evaluate(() => {
        const root = document.documentElement;
        const body = document.body;
        const shell = document.querySelector<HTMLElement>('.studio-shell');
        const workspace = document.querySelector<HTMLElement>('.recording-workspace');
        const inspector = document.querySelector<HTMLElement>('.inspector');
        const rect = (node: HTMLElement | null) => node?.getBoundingClientRect() ?? null;
        return {
          rootOverflow: root.scrollWidth > root.clientWidth + 1,
          bodyOverflow: body.scrollWidth > body.clientWidth + 1,
          shellOverflow: Boolean(shell && shell.scrollWidth > shell.clientWidth + 1),
          workspaceOverflow: Boolean(workspace && workspace.scrollWidth > workspace.clientWidth + 1),
          shell: rect(shell),
          workspace: rect(workspace),
          inspector: rect(inspector),
        };
      });
      expect(layout.rootOverflow, `${size.label} document overflow`).toBe(false);
      expect(layout.bodyOverflow, `${size.label} body overflow`).toBe(false);
      expect(layout.shellOverflow, `${size.label} shell overflow`).toBe(false);
      expect(layout.workspaceOverflow, `${size.label} workspace overflow`).toBe(false);
      for (const [name, rect] of [
        ['shell', layout.shell],
        ['workspace', layout.workspace],
        ['inspector', layout.inspector],
      ] as const) {
        expect(rect, `${name} should exist at ${size.label}`).not.toBeNull();
        expect(rect!.left, `${name} left edge at ${size.label}`).toBeGreaterThanOrEqual(-1);
        expect(rect!.right, `${name} right edge at ${size.label}`).toBeLessThanOrEqual(size.width + 1);
      }

      // These are the operator's essential controls. Merely avoiding a
      // horizontal scrollbar is insufficient if Windows scaling pushes the
      // transport, task navigation, settings, or safe-exit action off-screen.
      for (const [name, control] of [
        ['transport', page.getByTestId('main-transport')],
        ['active sentence', page.locator('.professional-item.active')],
        ['monitor tabs', page.locator('.monitor-tabs')],
        ['safe exit', page.getByTestId('finish-session')],
      ] as const) {
        const bounds = await control.boundingBox();
        expect(bounds, `${size.label} renders ${name}`).not.toBeNull();
        expect(bounds!.x, `${size.label} ${name} left edge`).toBeGreaterThanOrEqual(-1);
        expect(bounds!.y, `${size.label} ${name} top edge`).toBeGreaterThanOrEqual(-1);
        expect(bounds!.x + bounds!.width, `${size.label} ${name} right edge`)
          .toBeLessThanOrEqual(size.width + 1);
        expect(bounds!.y + bounds!.height, `${size.label} ${name} bottom edge`)
          .toBeLessThanOrEqual(size.height + 1);
      }
    }

    for (const index of [0, 159, 319]) await selectRowAndMeasure(page, index);
  } finally {
    await closeHarness(harness);
  }
});

test('real Electron keeps 1000-item navigation visible and bounded', async () => {
  let harness: Harness | null = null;
  try {
    harness = await launchHarness();
    const { page } = harness;
    const rows = ['序号,正文,标签'];
    for (let index = 1; index <= 1_000; index += 1) {
      const id = String(index).padStart(4, '0');
      const label = index < 501
        ? '普通采录条件'
        : '高噪声环境下的长标签条件说明与现场执行备注';
      rows.push(`${id},这是第 ${index} 条专业音频采录文本,${label}`);
    }
    await importScript(page, rows.join('\n'), 'p1-1000.csv');
    await enterCreatedRecording(page);

    for (const index of [0, 159, 499, 999]) await selectRowAndMeasure(page, index);
  } finally {
    await closeHarness(harness);
  }
});
