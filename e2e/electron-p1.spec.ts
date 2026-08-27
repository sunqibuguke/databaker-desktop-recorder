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
  if (detector === 'energy') await detectorOption.click();
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

async function feedActiveTake(page: Page, transport: ReturnType<Page['getByTestId']>): Promise<void> {
  await expect(transport).toContainText(/即将开始|完成本句|结束本句/);
  // Keep a half-second margin around the one-second gate so block boundaries
  // and the independently sampled meter cannot make this a threshold-edge test.
  await feedPaced(page, 72_000, 'silence');
  await feedPaced(page, 48_000, 'speech');
  await feedPaced(page, 72_000, 'silence');
  await expect(transport).toContainText(/完成本句|结束本句/);
}

async function disableMandatoryHeadTailGate(page: Page): Promise<void> {
  await page.locator('.monitor-tabs button').filter({ hasText: /检测/ }).click();
  const toggle = page.getByTestId('rule-enforce-head-tail');
  if (await toggle.isChecked()) await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
}

async function setAutomationRule(page: Page, testId: string, enabled: boolean): Promise<void> {
  await page.locator('.monitor-tabs button').filter({ hasText: /检测/ }).click();
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
  await expect(previewRetake.locator('span')).toHaveText('试听本次重录');
  await expect(useRetake).toHaveCount(1);
  await expect(useRetake.locator('strong')).toHaveText('使用本次重录');
  await expect(discardRetake).toHaveCount(1);
  await expect(discardRetake.locator('span')).toHaveText('放弃本次重录');

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
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const bounds = target.getBoundingClientRect();
    return {
      elapsed: performance.now() - started,
      active: target.classList.contains('active'),
      visible: bounds.bottom > 0 && bounds.top < window.innerHeight,
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

test('real Electron uses default VAD for a complete first-take confirmation flow', async () => {
  let harness: Harness | null = null;
  try {
    harness = await launchHarness();
    const { page } = harness;
    await importScript(page, [
      '序号,正文,标签',
      '001,请保持正常语速和音量,VAD 黄金流程',
    ].join('\n'), 'p1-default-vad.csv', 'vad');
    await page.getByTestId('start-session').click();
    await page.getByTestId('recording-workspace').waitFor();
    await disableMandatoryHeadTailGate(page);

    const selectedDetector = page.getByTestId('detector-vad');
    await expect(selectedDetector).toHaveAttribute('aria-checked', 'true');
    await expect(selectedDetector).toBeDisabled();

    const transport = page.getByTestId('main-transport');
    await transport.click();
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
    await page.getByTestId('start-session').click();
    await page.getByTestId('recording-workspace').waitFor();
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
    await transport.click();
    await expect(page.locator('.professional-item.active')).toContainText('003');
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

test('real Electron keeps the selected take until a retake decision and never auto-records after it', async () => {
  let harness: Harness | null = null;
  try {
    harness = await launchHarness();
    const { page } = harness;
    await importScript(page, [
      '序号,正文,标签',
      '001,这是此前已确认录音,同一标签',
      '002,这是物理下一句,同一标签',
    ].join('\n'));
    await page.getByTestId('start-session').click();
    await page.getByTestId('recording-workspace').waitFor();
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
    await expect(transport).not.toContainText(/完成本句|结束本句/);
    await expect(transport).not.toHaveClass(/\b(stop|waiting)\b/);
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
    await page.getByTestId('start-session').click();
    await page.getByTestId('recording-workspace').waitFor();
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
    await harness.page.getByTestId('record-recording').first().click();
    await harness.page.getByTestId('recording-workspace').waitFor();
    transport = harness.page.getByTestId('main-transport');

    await expect(harness.page.locator('.professional-item.active')).toContainText('002');
    await expect(transport).toContainText(/确认|采用/);
    await expect(transport).not.toContainText(/完成本句|结束本句/);
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
    await page.getByTestId('start-session').click();
    await page.getByTestId('recording-workspace').waitFor();
    await disableMandatoryHeadTailGate(page);
    await setAutomationRule(page, 'rule-auto-start-next', false);

    const transport = page.getByTestId('main-transport');
    await transport.click();
    await feedActiveTake(page, transport);
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
    await page.getByTestId('start-session').click();
    await page.getByTestId('recording-workspace').waitFor();
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

test('real Electron rejects a stale offline attempt switch without changing the selected version', async () => {
  let harness: Harness | null = null;
  try {
    harness = await launchHarness();
    const { page } = harness;
    await importScript(page, [
      '序号,正文,标签',
      '001,用自然修订变化制造过期版本切换,版本安全',
    ].join('\n'), 'p1-stale-attempt.csv');
    await page.getByTestId('start-session').click();
    await page.getByTestId('recording-workspace').waitFor();
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
    await disableMandatoryHeadTailGate(page);

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

    await page.locator('.monitor-tabs button').filter({ hasText: /导出/ }).click();
    const scopeButtons = page.locator('.export-scope-control > button');
    await scopeButtons.nth(1).click();
    const readiness = page.locator('.export-readiness');
    await expect(readiness).toHaveClass(/\bwarning\b/);
    await expect(readiness).toContainText(/包含\s*1/);
    await expect(readiness).toContainText(/排除\s*0/);
    await expect(readiness).toContainText(/阻断\s*0/);
    const warningChecks = page.locator('.export-warning-acks input[type="checkbox"]');
    await expect(warningChecks.first()).toBeVisible();
    for (let index = 0; index < await warningChecks.count(); index += 1) {
      await warningChecks.nth(index).check();
    }

    await page.getByTestId('choose-export-dir').click();
    await expect(page.locator('.export-destination code')).toHaveText(delivery);
    const cutsButton = page.getByRole('button', { name: /分段 ZIP/ });
    await expect(cutsButton).toBeEnabled();
    await cutsButton.click();

    const resultDialog = page.getByTestId('export-result-dialog');
    await expect(resultDialog).toBeVisible();
    await expect(resultDialog.locator('#export-result-title')).toContainText(/导出完成/, {
      timeout: 30_000,
    });
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
    };
    expect(manifest).toMatchObject({
      export_id: status.export_id,
      session_id: sessionId,
      scope: 'complete_task',
    });
    expect(manifest.included).toHaveLength(1);
    expect(manifest.excluded).toHaveLength(0);

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

    const history = await harness.page.evaluate(async (output) => {
      const recorder = (window as unknown as {
        recorder: { listRecordings(root: string, options?: unknown): Promise<{
          recordings: Array<{
            session_id: string;
            export_artifacts?: { cuts_zip?: { export_id?: string; delivery_verification?: string } };
          }>;
        }> };
      }).recorder;
      return await recorder.listRecordings(output, { offset: 0, limit: 100 });
    }, harness.output);
    const restartedTask = history.recordings.find((recording) => recording.session_id === sessionId);
    expect(restartedTask?.export_artifacts?.cuts_zip).toMatchObject({
      export_id: status.export_id,
      delivery_verification: 'pending',
    });

    const verification = await harness.page.evaluate(async (request) => {
      const recorder = (window as unknown as {
        recorder: { verifyExportDelivery(payload: unknown): Promise<{ verification: string } | null> };
      }).recorder;
      return await recorder.verifyExportDelivery(request);
    }, {
      session_id: sessionId,
      artifact: 'cuts_zip',
      export_id: status.export_id,
    });
    expect(verification?.verification).toBe('verified');

    await harness.page.getByTestId('view-recording').first().click();
    await harness.page.getByTestId('recording-workspace').waitFor();
    await harness.page.locator('.monitor-tabs button').filter({ hasText: /导出/ }).click();
    const restartedWarningChecks = harness.page.locator(
      '.export-warning-acks input[type="checkbox"]',
    );
    for (let index = 0; index < await restartedWarningChecks.count(); index += 1) {
      await restartedWarningChecks.nth(index).check();
    }
    await expect(harness.page.getByRole('button', { name: /分段 ZIP/ }))
      .toContainText(/外部交付已复验/, { timeout: 15_000 });
  } finally {
    await closeHarness(harness);
  }
});

test('real Electron keeps 320 long-label items bounded at target resolutions and blocks shortcut bleed', async () => {
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
    await page.getByTestId('start-session').click();
    await page.getByTestId('recording-workspace').waitFor();
    await disableMandatoryHeadTailGate(page);

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
      { width: 1080, height: 700 },
      { width: 1280, height: 720 },
      { width: 1366, height: 768 },
      { width: 1920, height: 1080 },
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
        deviceScaleFactor: 1,
        mobile: false,
      });
      await expect.poll(() => page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }))).toEqual(size);

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
      expect(layout.rootOverflow, `${size.width}x${size.height} document overflow`).toBe(false);
      expect(layout.bodyOverflow, `${size.width}x${size.height} body overflow`).toBe(false);
      expect(layout.shellOverflow, `${size.width}x${size.height} shell overflow`).toBe(false);
      expect(layout.workspaceOverflow, `${size.width}x${size.height} workspace overflow`).toBe(false);
      for (const [name, rect] of [
        ['shell', layout.shell],
        ['workspace', layout.workspace],
        ['inspector', layout.inspector],
      ] as const) {
        expect(rect, `${name} should exist at ${size.width}x${size.height}`).not.toBeNull();
        expect(rect!.left, `${name} left edge at ${size.width}x${size.height}`).toBeGreaterThanOrEqual(-1);
        expect(rect!.right, `${name} right edge at ${size.width}x${size.height}`).toBeLessThanOrEqual(size.width + 1);
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
    await page.getByTestId('start-session').click();
    await page.getByTestId('recording-workspace').waitFor();

    for (const index of [0, 159, 499, 999]) await selectRowAndMeasure(page, index);
  } finally {
    await closeHarness(harness);
  }
});
