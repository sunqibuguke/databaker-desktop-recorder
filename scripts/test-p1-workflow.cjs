'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const root = path.join(__dirname, '..');
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'p1-workflow-matrix.json'), 'utf8'));
  const workflow = await import(pathToFileURL(path.join(root, 'src', 'p1-workflow.ts')).href);
  const context = await import(pathToFileURL(path.join(root, 'src', 'workspace-context.ts')).href);
  const historyWorkflow = await import(pathToFileURL(path.join(root, 'electron', 'p1-history.ts')).href);
  const fullProvenance = fixture.capture_provenance;
  const deriveHistorySummary = (snapshot) => historyWorkflow.deriveHistoryWorkflowSummary({
    audio_format: fixture.audio_format,
    ...snapshot,
  });

  for (const scenario of fixture.cases) {
    const actual = workflow.deriveItemWorkflow(scenario.item, {
      committedSamples: fixture.committed_samples,
      provenance: fullProvenance,
    });
    assert.equal(actual.disposition, scenario.expected.disposition, `${scenario.name}: disposition`);
    assert.equal(actual.recommendedAction, scenario.expected.recommendedAction, `${scenario.name}: action`);
    assert.equal(actual.deliveryHealth, scenario.expected.deliveryHealth, `${scenario.name}: health`);
    for (const blocker of scenario.expected.blockers ?? []) {
      assert.ok(actual.blockers.includes(blocker), `${scenario.name}: missing ${blocker}`);
    }
    const history = deriveHistorySummary({
      status: 'stopped',
      overflow_samples: 0,
      committed_samples: fixture.committed_samples,
      capture_provenance: fullProvenance,
      items: [scenario.item],
    });
    assert.equal(
      history.blocker_items,
      scenario.expected.deliveryHealth === 'blocked' ? 1 : 0,
      `${scenario.name}: history blocker parity`,
    );
    assert.equal(
      history.warning_items,
      scenario.expected.deliveryHealth === 'warning' ? 1 : 0,
      `${scenario.name}: history warning parity`,
    );
  }

  for (const scenario of fixture.task_cases ?? []) {
    const task = workflow.deriveTaskWorkflow({
      items: scenario.items,
      status: fixture.task_status,
      overflow_samples: fixture.overflow_samples,
      committed_samples: fixture.committed_samples,
      capture_provenance: fullProvenance,
      audio_format: fixture.audio_format,
    });
    assert.equal(task.blockerCount, scenario.expected.blocker_count, `${scenario.name}: blocker count`);
    assert.equal(task.confirmedOnly.ready, scenario.expected.confirmed_only_ready, `${scenario.name}: confirmed-only readiness`);
    assert.equal(task.completeTask.ready, scenario.expected.complete_task_ready, `${scenario.name}: complete-task readiness`);
    for (const itemIndex of scenario.expected.affected_indices) {
      const item = task.items[itemIndex];
      assert.equal(item.disposition, 'inconsistent', `${scenario.name}: item ${itemIndex} disposition`);
      assert.equal(item.recommendedAction, 'repair', `${scenario.name}: item ${itemIndex} action`);
      assert.equal(item.deliveryHealth, 'blocked', `${scenario.name}: item ${itemIndex} health`);
      assert.ok(item.blockers.includes(scenario.expected.reason), `${scenario.name}: item ${itemIndex} reason`);
    }
    const taskIssues = workflow.buildIssueWorkbench(task);
    assert.equal(
      new Set(taskIssues.map((issue) => issue.id)).size,
      taskIssues.length,
      `${scenario.name}: repair issue IDs remain unique`,
    );
    const history = deriveHistorySummary({
      status: 'stopped',
      overflow_samples: 0,
      committed_samples: fixture.committed_samples,
      capture_provenance: fullProvenance,
      items: scenario.items,
    });
    assert.equal(history.blocker_items, scenario.expected.blocker_count, `${scenario.name}: history blocker parity`);
    assert.equal(
      history.confirmed_only_readiness.ready,
      scenario.expected.confirmed_only_ready,
      `${scenario.name}: history confirmed-only readiness`,
    );
    assert.equal(
      history.complete_task_readiness.ready,
      scenario.expected.complete_task_ready,
      `${scenario.name}: history complete-task readiness`,
    );
  }

  for (const scenario of fixture.warning_cases ?? []) {
    assert.deepEqual(
      workflow.deliveryWarningCodesForAttempt(scenario.attempt),
      scenario.expected_warning_codes,
      `${scenario.name}: warning codes`,
    );
    const history = deriveHistorySummary({
      status: 'stopped',
      overflow_samples: 0,
      committed_samples: fixture.committed_samples,
      capture_provenance: fullProvenance,
      items: [{
        id: `history-${scenario.attempt.attempt_id}`,
        text: scenario.name,
        label: '',
        status: 'accepted',
        selected_attempt_id: scenario.attempt.attempt_id,
        attempts: [scenario.attempt],
      }],
    });
    assert.equal(
      history.confirmed_only_readiness.warning_count,
      scenario.expected_warning_codes.length,
      `${scenario.name}: history warning parity`,
    );
  }

  const byName = new Map(fixture.cases.map((scenario) => [scenario.name, scenario.item]));
  for (const scenario of fixture.provenance_cases ?? []) {
    const item = byName.get(scenario.item_name);
    const provenance = scenario.mode === 'empty' ? [] : undefined;
    const actual = workflow.deriveItemWorkflow(item, {
      committedSamples: fixture.committed_samples,
      provenance,
    });
    assert.equal(actual.disposition, 'inconsistent', `${scenario.name}: disposition`);
    assert.ok(actual.blockers.includes(scenario.expected_blocker), `${scenario.name}: TS blocker`);
    const historySnapshot = {
      status: 'stopped',
      overflow_samples: 0,
      committed_samples: fixture.committed_samples,
      items: [item],
      ...(scenario.mode === 'empty' ? { capture_provenance: [] } : {}),
    };
    const history = deriveHistorySummary(historySnapshot);
    assert.equal(history.blocker_items, 1, `${scenario.name}: history blocker parity`);
    assert.equal(history.confirmed_only_readiness.ready, false, `${scenario.name}: history readiness`);
  }

  for (const scenario of fixture.task_provenance_cases ?? []) {
    const snapshotFields = {
      status: 'stopped',
      overflow_samples: 0,
      committed_samples: fixture.committed_samples,
      items: [byName.get('selected clean version')],
      audio_format: fixture.audio_format,
      ...(Object.hasOwn(scenario, 'capture_provenance')
        ? { capture_provenance: scenario.capture_provenance }
        : {}),
    };
    const task = workflow.deriveTaskWorkflow(snapshotFields);
    assert.equal(
      task.confirmedOnly.ready,
      scenario.expected_ready,
      `${scenario.name}: TS confirmed-only readiness`,
    );
    assert.equal(
      task.completeTask.ready,
      scenario.expected_ready,
      `${scenario.name}: TS complete-task readiness`,
    );
    assert.equal(
      task.confirmedOnly.blockers.includes('task_provenance_incomplete'),
      !scenario.expected_ready,
      `${scenario.name}: TS task provenance reason`,
    );
    const history = deriveHistorySummary({
      ...snapshotFields,
    });
    assert.equal(
      history.confirmed_only_readiness.ready,
      scenario.expected_ready,
      `${scenario.name}: history confirmed-only readiness`,
    );
    assert.equal(
      history.complete_task_readiness.ready,
      scenario.expected_ready,
      `${scenario.name}: history complete-task readiness`,
    );
  }

  for (const scenario of fixture.data_preservation_cases ?? []) {
    const actual = workflow.deriveDataPreservationReadiness(scenario.input);
    assert.equal(actual.ready, scenario.expected.ready, `${scenario.name}: ready`);
    assert.equal(actual.health, scenario.expected.health, `${scenario.name}: health`);
    for (const blocker of scenario.expected.blockers ?? []) {
      assert.ok(actual.blockers.includes(blocker), `${scenario.name}: missing blocker ${blocker}`);
    }
    for (const warning of scenario.expected.warnings ?? []) {
      assert.ok(actual.warnings.includes(warning), `${scenario.name}: missing warning ${warning}`);
    }
  }

  const healthSummary = workflow.deriveTaskWorkflow({
    items: [byName.get('selected clean version')],
    status: fixture.task_status,
    overflow_samples: fixture.overflow_samples,
    committed_samples: fixture.committed_samples,
    capture_provenance: fullProvenance,
    audio_format: fixture.audio_format,
  });

  const headTailWarningSummary = structuredClone(healthSummary);
  headTailWarningSummary.items[0].warnings = ['head_silence_short', 'tail_silence_short'];
  headTailWarningSummary.items[0].deliveryHealth = 'warning';
  headTailWarningSummary.warningCount = 1;
  for (const readiness of [headTailWarningSummary.confirmedOnly, headTailWarningSummary.completeTask]) {
    readiness.warningCodes = ['head_silence_short', 'tail_silence_short'];
    readiness.health = 'warning';
    readiness.requiresAcknowledgement = true;
  }
  assert.deepEqual(
    headTailWarningSummary.completeTask.warningCodes,
    ['head_silence_short', 'tail_silence_short'],
    'enabled head/tail hints retain both derived warnings',
  );
  const headTailHintsOff = workflow.applyHeadTailWarningPreference(headTailWarningSummary, false);
  assert.equal(headTailHintsOff.warningCount, 0, 'disabled head/tail hints clear item warning count');
  assert.equal(headTailHintsOff.items[0].deliveryHealth, 'clear', 'disabled head/tail hints clear item health');
  assert.deepEqual(headTailHintsOff.items[0].warnings, [], 'disabled head/tail hints clear item warnings');
  assert.equal(headTailHintsOff.completeTask.health, 'clear', 'disabled head/tail hints clear export health');
  assert.deepEqual(headTailHintsOff.completeTask.warningCodes, [], 'disabled head/tail hints clear export warnings');
  assert.equal(headTailHintsOff.completeTask.requiresAcknowledgement, false, 'disabled hints need no acknowledgement');
  assert.equal(
    workflow.applyHeadTailWarningPreference(headTailWarningSummary, true),
    headTailWarningSummary,
    'enabled head/tail hints preserve the original summary',
  );

  const mixedHistoryHeadTailItem = structuredClone(byName.get('selected clean version'));
  Object.assign(mixedHistoryHeadTailItem.attempts[0], {
    head_silence_armed_sample: 100,
    head_silence_passed_sample: 250,
    required_head_silence_samples: 150,
    tail_silence_samples: 0,
    required_tail_silence_samples: 150,
  });
  const mixedHistoryWarnings = deriveHistorySummary({
    status: 'stopped',
    overflow_samples: 0,
    committed_samples: fixture.committed_samples,
    capture_provenance: fullProvenance,
    items: [mixedHistoryHeadTailItem, byName.get('skipped item')],
  });
  assert.equal(mixedHistoryWarnings.warning_items, 2, 'history counts head/tail and skipped warning items');
  assert.equal(
    mixedHistoryWarnings.warning_items_without_head_tail,
    1,
    'disabling head/tail hints preserves the skipped history warning item',
  );

  for (const scenario of fixture.vad_health_cases ?? []) {
    const healthIssues = workflow.buildIssueWorkbench(healthSummary, scenario.task_issues);
    assert.equal(
      healthIssues.filter((issue) => issue.severity === 'blocker').length,
      scenario.expected.blockers,
      `${scenario.name}: blocker count`,
    );
    assert.equal(
      healthIssues.filter((issue) => issue.severity === 'warning').length,
      scenario.expected.warnings,
      `${scenario.name}: warning count`,
    );
    assert.deepEqual(healthIssues.map((issue) => issue.kind), scenario.expected.kinds, `${scenario.name}: issue kinds`);
  }

  const historicalVadSummary = deriveHistorySummary({
    status: 'stopped',
    overflow_samples: 0,
    committed_samples: fixture.committed_samples,
    capture_provenance: fullProvenance,
    items: [byName.get('selected clean version')],
    vad_diagnostics: {
      queue_capacity_samples: 48_000,
      queue_capacity_blocks: 1_024,
      queue_high_water_samples: 24_000,
      overflow_count: 1,
      dropped_samples: 480,
      classifier_failure_count: 0,
      flush_timeout_count: 0,
      worker_disconnect_count: 0,
    },
  });
  assert.equal(historicalVadSummary.blocker_items, 0, 'persisted VAD faults are not history blockers');
  assert.equal(historicalVadSummary.warning_items, 1, 'persisted VAD faults aggregate as one task warning');
  assert.equal(historicalVadSummary.confirmed_only_readiness.ready, true, 'persisted VAD faults do not block confirmed-only export');
  assert.equal(historicalVadSummary.confirmed_only_readiness.health, 'clear', 'persisted VAD faults do not change cuts readiness health');
  assert.equal(historicalVadSummary.complete_task_readiness.ready, true, 'persisted VAD faults do not block complete-task export');

  const healthyHistoricalVadSummary = deriveHistorySummary({
    status: 'stopped',
    overflow_samples: 0,
    committed_samples: fixture.committed_samples,
    capture_provenance: fullProvenance,
    items: [byName.get('selected clean version')],
    vad_diagnostics: {
      queue_capacity_samples: 48_000,
      queue_capacity_blocks: 1_024,
      queue_high_water_samples: 24_000,
      overflow_count: 0,
      dropped_samples: 0,
      classifier_failure_count: 0,
      flush_timeout_count: 0,
      worker_disconnect_count: 0,
    },
  });
  assert.equal(healthyHistoricalVadSummary.warning_items, 0, 'healthy cumulative VAD diagnostics do not create a warning');

  const scopeItems = fixture.scope_case.item_names.map((name) => byName.get(name));
  const derived = scopeItems.map((item) => workflow.deriveItemWorkflow(item, {
    committedSamples: fixture.committed_samples,
    provenance: fullProvenance,
  }));
  for (const [scopeName, expected] of Object.entries({
    confirmed_only: fixture.scope_case.confirmed_only,
    complete_task: fixture.scope_case.complete_task,
  })) {
    const readiness = workflow.deriveDeliveryReadiness(derived, scopeName);
    assert.equal(readiness.ready, expected.ready, `${scopeName}: ready`);
    assert.deepEqual(readiness.includedItemIds, expected.included, `${scopeName}: included`);
    assert.deepEqual(readiness.excluded.map((entry) => entry.itemId), expected.excluded, `${scopeName}: excluded`);
    assert.equal(readiness.requiresAcknowledgement, expected.requiresAcknowledgement, `${scopeName}: acknowledgement`);
  }
  const historyScope = deriveHistorySummary({
    status: 'stopped',
    overflow_samples: 0,
    committed_samples: fixture.committed_samples,
    capture_provenance: fullProvenance,
    items: scopeItems,
  });
  for (const [scopeName, expected] of Object.entries({
    confirmed_only: fixture.scope_case.confirmed_only,
    complete_task: fixture.scope_case.complete_task,
  })) {
    const actual = scopeName === 'confirmed_only'
      ? historyScope.confirmed_only_readiness
      : historyScope.complete_task_readiness;
    assert.equal(actual.ready, expected.ready, `${scopeName}: history ready`);
    assert.equal(actual.included_items, expected.included.length, `${scopeName}: history included count`);
    assert.equal(actual.excluded_items, expected.excluded.length, `${scopeName}: history excluded count`);
    assert.equal(actual.warning_count > 0, expected.requiresAcknowledgement, `${scopeName}: history warnings`);
  }
  const unsafeTask = deriveHistorySummary({
    status: 'recording',
    overflow_samples: 0,
    committed_samples: fixture.committed_samples,
    capture_provenance: fullProvenance,
    items: [byName.get('selected clean version')],
  });
  assert.equal(unsafeTask.confirmed_only_readiness.ready, false, 'a live task is not deliverable from history');
  assert.equal(unsafeTask.complete_task_readiness.health, 'blocked');

  const missingProvenance = deriveHistorySummary({
    status: 'stopped',
    overflow_samples: 0,
    committed_samples: fixture.committed_samples,
    items: [byName.get('selected clean version')],
  });
  assert.equal(
    missingProvenance.confirmed_only_readiness.ready,
    false,
    'a selected range without provenance is not deliverable from history',
  );
  const retainedWithReviewStatus = deriveHistorySummary({
    status: 'stopped',
    overflow_samples: 0,
    committed_samples: fixture.committed_samples,
    capture_provenance: fullProvenance,
    items: [{ ...byName.get('affected retake retains old version'), status: 'review' }],
  });
  assert.equal(
    retainedWithReviewStatus.confirmed_only_readiness.ready,
    false,
    'retained_previous requires an accepted item status',
  );
  for (const malformedAttempt of [
    { recording_started_sample: 801 },
    { content_started_sample: 99 },
  ]) {
    const malformedHistory = deriveHistorySummary({
      status: 'stopped',
      overflow_samples: 0,
      committed_samples: fixture.committed_samples,
      capture_provenance: fullProvenance,
      items: [{
        ...byName.get('selected clean version'),
        attempts: [{ ...byName.get('selected clean version').attempts[0], ...malformedAttempt }],
      }],
    });
    assert.equal(
      malformedHistory.confirmed_only_readiness.ready,
      false,
      'recording/content boundaries must remain inside the attempt range',
    );
  }

  const previewAttempt = byName.get('selected clean version').attempts[0];
  assert.equal(workflow.isAttemptPreviewSafe(previewAttempt, {
    committed_samples: 10000,
    capture_provenance: fullProvenance,
  }), true);
  assert.equal(workflow.isAttemptPreviewSafe({ ...previewAttempt, end_sample: 10001 }, {
    committed_samples: 10000,
    capture_provenance: fullProvenance,
  }), false);
  assert.equal(workflow.isAttemptPreviewSafe({ ...previewAttempt, status: 'needs_rerecord' }, {
    committed_samples: 10000,
    capture_provenance: fullProvenance,
  }), false);
  assert.ok(workflow.attemptStructuralReasons({ ...previewAttempt, start_sample: -1 }, 10000).includes('selected_range_invalid'));
  assert.ok(workflow.attemptStructuralReasons({ ...previewAttempt, end_sample: previewAttempt.start_sample }, 10000).includes('selected_range_invalid'));
  assert.ok(workflow.attemptStructuralReasons({ ...previewAttempt, end_sample: Number.POSITIVE_INFINITY }, 10000).includes('selected_range_invalid'));
  assert.ok(workflow.attemptStructuralReasons({ ...previewAttempt, end_sample: 10001 }, 10000).includes('selected_beyond_committed'));
  assert.ok(workflow.attemptStructuralReasons({ ...previewAttempt, attempt_id: '  ' }, 10000).includes('attempt_id_invalid'));
  assert.ok(workflow.attemptStructuralReasons({ ...previewAttempt, recording_started_sample: 801 }, 10000).includes('selected_range_invalid'));
  assert.ok(workflow.attemptStructuralReasons({ ...previewAttempt, start_sample: 300, content_started_sample: 200 }, 10000).includes('selected_range_invalid'));
  assert.equal(
    workflow.attemptStructuralReasons({ ...previewAttempt, start_sample: 150, recording_started_sample: 100 }, 10000).includes('selected_range_invalid'),
    false,
    'a trimmed clip may start after the operator began recording',
  );
  assert.ok(workflow.attemptStructuralReasons({
    ...previewAttempt,
    quality_issues: [{ code: 'input_discontinuity', start_sample: 200 }],
  }, 10000).includes('quality_issue_range_invalid'));
  assert.equal(workflow.attemptRangeCoveredByProvenance(previewAttempt, [
    { start_sample: 0, end_sample: 500 },
    { start_sample: 500, end_sample: 1000 },
  ]), true, 'contiguous provenance spans cover the attempt');
  const resumedProvenance = [
    ...fullProvenance,
    {
      ...fullProvenance.at(-1),
      start_sample: fixture.committed_samples,
      end_sample: fixture.committed_samples,
    },
  ];
  assert.equal(
    workflow.attemptRangeCoveredByProvenance(previewAttempt, resumedProvenance),
    true,
    'a newly activated zero-length tail span does not invalidate an earlier attempt',
  );
  const resumedTask = workflow.deriveTaskWorkflow({
    status: 'recording',
    overflow_samples: 0,
    committed_samples: fixture.committed_samples,
    capture_provenance: resumedProvenance,
    audio_format: fixture.audio_format,
    items: [byName.get('selected clean version')],
  });
  assert.equal(resumedTask.items[0].disposition, 'selected', 'resume keeps the selected item valid');
  assert.equal(resumedTask.blockerCount, 0, 'resume does not create an item blocker');
  assert.equal(
    workflow.buildIssueWorkbench(resumedTask).length,
    0,
    'resume does not create a false state-conflict issue',
  );
  const resumedHistory = deriveHistorySummary({
    status: 'recording',
    overflow_samples: 0,
    committed_samples: fixture.committed_samples,
    capture_provenance: resumedProvenance,
    items: [byName.get('selected clean version')],
  });
  assert.equal(resumedHistory.blocker_items, 0, 'history summary agrees during resume');
  assert.equal(workflow.attemptRangeCoveredByProvenance(previewAttempt, [
    { start_sample: 0, end_sample: 1000 },
    { start_sample: 1000, end_sample: 999 },
  ]), false, 'a reversed provenance span remains unsafe');
  assert.equal(workflow.attemptRangeCoveredByProvenance(previewAttempt, [
    { start_sample: 0, end_sample: 450 },
    { start_sample: 500, end_sample: 1000 },
  ]), false, 'a provenance gap is unsafe');
  assert.equal(workflow.attemptRangeCoveredByProvenance(previewAttempt, []), false, 'empty provenance is not evidence');
  assert.equal(workflow.attemptRangeCoveredByProvenance(previewAttempt, undefined), false, 'missing legacy provenance fails closed');

  const summary = {
    items: derived,
    counts: {},
    blockerCount: 2,
    warningCount: 2,
    dataPreservation: { ready: true, health: 'clear', blockers: [], warnings: [] },
    confirmedOnly: workflow.deriveDeliveryReadiness(derived, 'confirmed_only'),
    completeTask: workflow.deriveDeliveryReadiness(derived, 'complete_task'),
  };
  const issues = workflow.buildIssueWorkbench(summary, { vadHealth: 'lagging', inputDiscontinuity: true });
  assert.ok(issues.some((issue) => issue.kind === 'retained_previous' && issue.severity === 'warning'));
  assert.ok(issues.some((issue) => issue.kind === 'vad_health' && issue.severity === 'warning'));
  assert.ok(workflow.filterWorkbenchIssues(issues, 'blocker').every((issue) => issue.severity === 'blocker'));
  const first = workflow.adjacentWorkbenchIssue(issues, null, 1);
  assert.equal(first.issue, issues[0]);
  const wrapped = workflow.adjacentWorkbenchIssue(issues, issues.at(-1).id, 1);
  assert.equal(wrapped.issue, issues[0]);

  const orderedIssues = workflow.buildIssueWorkbench(summary, { captureFault: true });
  assert.equal(orderedIssues[0].kind, 'capture_fault', 'task blockers must lead the issue queue');
  const firstWarning = orderedIssues.findIndex((issue) => issue.severity === 'warning');
  const lastBlocker = orderedIssues.findLastIndex((issue) => issue.severity === 'blocker');
  assert.ok(firstWarning < 0 || lastBlocker < firstWarning, 'all sentence blockers must precede warnings');
  assert.equal(wrapped.wrapped, true);

  const issueA = { id: 'issue-a' };
  const issueB = { id: 'issue-b' };
  const issueC = { id: 'issue-c' };
  assert.equal(
    workflow.nextWorkbenchIssueAfterResolution([issueA, issueB, issueC], 'issue-b', [issueA, issueC]),
    issueC,
    'resolving a selected issue advances to the next surviving issue',
  );
  assert.equal(
    workflow.nextWorkbenchIssueAfterResolution([issueA, issueB], 'issue-b', [issueA]),
    issueA,
    'resolving the last issue falls back to the nearest preceding survivor',
  );
  assert.equal(
    workflow.nextWorkbenchIssueAfterResolution([issueA], 'issue-a', []),
    null,
    'resolving the final issue closes the queue',
  );

  assert.deepEqual(
    workflow.setupReadinessIssues({ engineReady: false, scriptReady: false, captureReady: false, outputReady: false }),
    ['engine', 'script', 'capture', 'output'],
    'setup readiness reports every missing prerequisite in stable action order',
  );
  assert.deepEqual(
    workflow.setupReadinessIssues({ engineReady: true, scriptReady: true, captureReady: true, outputReady: true }),
    [],
    'setup readiness is empty only when every structural prerequisite is satisfied',
  );

  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  context.saveWorkspaceContext({ sessionId: 'task-1', currentItemId: '500', issueFilter: 'warning', panel: 'issues', updatedAt: 1 }, storage);
  assert.deepEqual(context.loadWorkspaceContext('task-1', storage), {
    sessionId: 'task-1', currentItemId: '500', issueFilter: 'warning', panel: 'issues', updatedAt: 1,
  });
  context.saveWorkspaceContext({ sessionId: 'task-settings', currentItemId: null, issueFilter: 'all', panel: 'settings', updatedAt: 2 }, storage);
  assert.equal(context.loadWorkspaceContext('task-settings', storage)?.panel, 'settings', 'recording settings is a restorable inspector tab');
  for (let index = 2; index <= 102; index += 1) {
    context.saveWorkspaceContext({ sessionId: `task-${index}`, currentItemId: null, issueFilter: 'all', panel: 'monitor', updatedAt: index }, storage);
  }
  assert.equal(context.loadWorkspaceContext('task-1', storage), null, 'LRU keeps only the newest 100 contexts');
  assert.ok(context.loadWorkspaceContext('task-102', storage));
  context.removeWorkspaceContext('task-102', storage);
  assert.equal(context.loadWorkspaceContext('task-102', storage), null);

  values.set(context.WORKSPACE_CONTEXT_KEY, JSON.stringify({
    version: 1,
    entries: [
      { sessionId: 'bad-item-id', currentItemId: 42, issueFilter: 'all', panel: 'monitor', updatedAt: 500 },
      { sessionId: 'bad-time', currentItemId: null, issueFilter: 'all', panel: 'monitor', updatedAt: 'recent' },
    ],
  }));
  assert.equal(context.loadWorkspaceContext('bad-item-id', storage), null, 'malformed current item IDs fail closed');
  assert.equal(context.loadWorkspaceContext('bad-time', storage), null, 'malformed timestamps fail closed');

  values.set(context.WORKSPACE_CONTEXT_KEY, JSON.stringify({
    version: 1,
    entries: Array.from({ length: 125 }, (_, index) => ({
      sessionId: `oversized-${index}`,
      currentItemId: null,
      issueFilter: 'all',
      panel: 'monitor',
      updatedAt: index,
    })),
  }));
  assert.equal(context.loadWorkspaceContext('oversized-0', storage), null, 'oversized stores are capped on read');
  assert.equal(context.loadWorkspaceContext('oversized-24', storage), null, 'only the newest 100 contexts survive read-time capping');
  assert.equal(context.loadWorkspaceContext('oversized-124', storage)?.updatedAt, 124, 'read-time capping sorts by recency');

  console.log('P1 workflow matrix and local context tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
