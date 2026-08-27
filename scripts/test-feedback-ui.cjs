'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const recorder = fs.readFileSync(path.join(root, 'src', 'Recorder.tsx'), 'utf8');
const prompter = fs.readFileSync(path.join(root, 'src', 'Prompter.tsx'), 'utf8');
const types = fs.readFileSync(path.join(root, 'src', 'types.ts'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');

assert.match(recorder, /parseScript\(file\.content, file\.name\)/);
assert.match(recorder, /scriptPreview\.items\.slice\(0, 10\)/);
assert.match(recorder, /data-testid="open-script-preview"/);
assert.match(recorder, /data-testid="close-script-preview"/);
assert.match(recorder, /setScriptItems\(parsed\.errors\.length \? \[\] : parsed\.items\)/);
assert.match(recorder, /const scriptReady = scriptItems\.length > 0 && !scriptErrors\.length/);
assert.doesNotMatch(recorder, /confirm-script-preview|scriptPreviewConfirmed|confirmScriptPreview/);
assert.match(recorder, /isLabelBoundary\(items, index\)/);
assert.match(recorder, /itemRequiresRerecord\(item\)/);
assert.match(recorder, /findNextRerecordIndex\(items, currentIndex\)/);
assert.match(recorder, /scrollIntoView\(\{\s*block: 'nearest'/);
assert.match(recorder, /const deferredItemBrowserIndex = useDeferredValue\(currentIndex\)/);
assert.match(recorder, /tabIndex=\{index === deferredItemBrowserIndex \? 0 : -1\}/);
assert.match(recorder, /event\.key === 'ArrowDown'/);
assert.match(recorder, /className="item-label-value" title=\{normalizedLabel \|\| undefined\}/);
assert.match(recorder, /testId="recorder-label-font-size"/);
assert.match(recorder, /labelTransition\(currentItem\.label, nextItem\.label\)/);
assert.match(recorder, /testId="rule-pause-on-label-change" checked=\{automationRules\.pauseOnLabelChange\}/);
assert.match(recorder, /applyAutomationRule\('pauseOnLabelChange', enabled\)/);
assert.match(recorder, /pauseOnLabelChange: automationRules\.pauseOnLabelChange/);
assert.match(recorder, /startAttempt\(nextItem, \{ acknowledgeLabelTransition: false \}\)/);
assert.match(recorder, /acceptTarget\?\.status === 'review' \|\| acceptPausesForLabelChange/);
assert.match(recorder, /acceptAttempt\(retainedDeliveryAttempt\.attempt_id\)/);
assert.match(recorder, /nextPhysicalItemIndex\(currentIndex, latest\.items\.length\)/);
assert.match(recorder, /moveToAutomaticTarget\(currentItem, latest\.items\[nextIndex\], nextIndex\)/);
assert.match(recorder, /selectionIndexAfterStoppedRetake/);
assert.match(recorder, /setRetakeItemId\(item\.status === 'pending' \? null : item\.id\)/);
assert.match(recorder, /retakeItemId === currentItem\.id/);
assert.match(recorder, /const isRetakeDecision = hasRetakeDecision/);
assert.match(recorder, /const hasRetakeChoice = Boolean/);
assert.ok(
  recorder.indexOf('if (isRetakeDecision)')
    < recorder.indexOf('const continuation = continuationAfterAccept'),
  'retake decisions must return before ordinary auto-start continuation',
);
assert.match(recorder, /deriveTaskWorkflow/);
assert.match(recorder, /cutsReadiness\.ready/);
assert.match(recorder, /export-status-summary/);
assert.match(recorder, /exportDialog\.cutsBlockedReview/);
assert.match(recorder, /state\.exported_count/);
assert.match(recorder, /void refreshRecordings\(outputDirRef\.current\)/);
assert.match(recorder, /recording \|\| captureFault \|\| workspaceFaulted \|\| !cutsReadiness\.ready \|\| !exportWarningsAcknowledged/);
assert.match(recorder, /disabled=\{recording \|\| !reviewAttempt \|\| Boolean\(busy\)\}/);
assert.doesNotMatch(recorder, /知道了/);
assert.match(recorder, /data-testid="retake-decision-summary"/);
assert.match(recorder, /data-testid=\{hasRetakeDecision \? 'preview-retake' : undefined\}[\s\S]*?t\('recorder\.previewCandidate'\)/);
assert.match(recorder, /data-retake-action=\{hasRetakeDecision \? 'use' : undefined\}[\s\S]*?t\('recorder\.useRetakeCandidate'\)/);
assert.match(recorder, /data-testid="discard-retake"[\s\S]*?acceptAttempt\(retainedDeliveryAttempt\.attempt_id\)[\s\S]*?t\('recorder\.keepPreviousVersion'\)/);
assert.equal((recorder.match(/t\('recorder\.previewCandidate'\)/g) ?? []).length, 1);
assert.equal((recorder.match(/t\('recorder\.useRetakeCandidate'\)/g) ?? []).length, 1);
assert.equal((recorder.match(/t\('recorder\.keepPreviousVersion'\)/g) ?? []).length, 1);
assert.doesNotMatch(recorder, /data-testid="version-workbench"/, '普通录制界面不得恢复版本工作台');
assert.doesNotMatch(recorder, /className="version-(?:comparison|column|silence-metrics)/, '普通录制界面不得恢复版本比较');
assert.doesNotMatch(recorder, /className="attempt-history(?:-row)?/, '普通录制界面不得展开 attempt 历史');
assert.doesNotMatch(recorder, /previewAttempt\(retainedDeliveryAttempt\.attempt_id\)/, '重录决策不得提供原录音试听');
assert.match(recorder, /isAttemptPreviewSafe/);
assert.match(recorder, /expected_journal_seq: sourceSnapshot\.journal_seq/);
assert.match(recorder, /if \(!safeAttemptIds\.has\(attemptId\)\) return/);
assert.match(recorder, /data-testid="issue-workbench"/);
assert.match(recorder, /adjacentWorkbenchIssue\(visibleWorkbenchIssues, selectedIssueId, direction\)/);
assert.match(recorder, /setCurrentIndex\(issue\.itemIndex\)/);
const issueLocator = recorder.slice(
  recorder.indexOf('function locateWorkbenchIssue'),
  recorder.indexOf('function moveWorkbenchIssue'),
);
assert.doesNotMatch(issueLocator, /startAttempt/, '问题定位绝不得开始录音');
assert.match(recorder, /exportScope === 'complete_task'/);
assert.match(recorder, /acknowledged_warning_codes/);
assert.match(recorder, /expected_session_id: task\.session_id/);
assert.match(recorder, /const externalDeliveryFailed = Boolean\(destination\) && !deliveryVerified/);
assert.match(recorder, /status: externalDeliveryFailed \? 'preserved' : 'ok'/);
assert.match(recorder, /exportFeedback\.status === 'preserved'/);
assert.match(recorder, /data-testid="vad-health-banner"/);
assert.match(recorder, /const vadHealth = meter\.vad_health \?\? 'healthy'/);
assert.match(recorder, /vadDiagnosticFaultCount: persistedVadFaults/);
assert.doesNotMatch(recorder, /meter\.vad_health \?\? \(persistedVadFaults > 0 \? 'degraded'/);
assert.match(recorder, /saveWorkspaceContext/);
assert.match(recorder, /loadWorkspaceContext/);
assert.match(recorder, /workflowShortcutTargetAllowed\(\{/);
assert.match(recorder, /modalOpen: Boolean\(document\.querySelector\('\[role="dialog"\]\[aria-modal="true"\]'\)\)[\s\S]*?&& !showDeviceWarningDialog[\s\S]*?&& !showNoiseCheckDialog/);
assert.match(recorder, /formControl: Boolean\(target\?\.closest\('input, textarea, select, audio, \[contenteditable="true"\]'\)\)/);
assert.match(recorder, /professionalItem: Boolean\(target\?\.closest\('\.professional-item'\)\)/);
assert.doesNotMatch(recorder, /target\?\.closest\('input, textarea, select, button, audio'\)/, 'focused sentence rows must not be rejected by the blanket button guard');
assert.match(recorder, /if \(options\.activate\) await activateCapture\(undefined, inspected\.session_dir\)/);

assert.match(types, /labelTransition\?: ScriptLabelTransition \| null/);
assert.match(types, /capture_provenance: CaptureProvenanceSpan\[\]/);
assert.match(prompter, /state\?\.labelTransition\?\.changed/);
assert.match(recorder, /<b>\{t\('recorder\.labelChanged'\)\}<\/b>/);
assert.match(prompter, /<span>\{t\('prompter\.labelChanged'\)\}<\/span>/);
assert.match(recorder, /key=\{`transition:\$\{currentItem\?\.id/);
assert.match(recorder, /key=\{`label:\$\{currentItem\?\.id/);
assert.doesNotMatch(recorder, /labelChangedFromTo/, '主控端标签提醒只说标签已变化');
assert.doesNotMatch(prompter, /labelChangedFromTo/, '提词端标签提醒只说标签已变化');
assert.equal((prompter.match(/step=\{1\}/g) ?? []).length, 2);
assert.equal((prompter.match(/step=\{2\}/g) ?? []).length, 2);
assert.match(prompter, /className="prompter-label-transition" role="status" aria-live="polite"/);
assert.match(prompter, /data-item-disposition/);
assert.match(prompter, /data-delivery-health/);

assert.match(css, /--label-change:\s*#[0-9a-f]{6}/i);
assert.match(css, /\.professional-item\.label-boundary/);
assert.match(css, /\.professional-item\s*\{[^}]*grid-template-areas:\s*"state copy meta" "state label label"/);
assert.match(css, /\.item-label-line em\s*\{[^}]*white-space:\s*nowrap[^}]*text-overflow:\s*ellipsis/);
assert.match(css, /\.professional-item\.active \.item-label-line em,[\s\S]*?\.professional-item:focus-visible \.item-label-line em\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*white-space:\s*normal[^}]*-webkit-line-clamp:\s*2/);
const ordinaryLabelBadgeRule = css.match(/\.item-label-line b\s*\{([^}]*)\}/)?.[1] ?? '';
const ordinaryLabelValueRule = css.match(/\.item-label-line em\s*\{([^}]*)\}/)?.[1] ?? '';
assert.doesNotMatch(ordinaryLabelBadgeRule, /label-change/, 'ordinary labels must not use the label-change accent');
assert.doesNotMatch(ordinaryLabelValueRule, /label-change/, 'ordinary label values must not use the label-change accent');
assert.match(css, /\.professional-item\.label-boundary \.item-label-line b\s*\{[^}]*var\(--label-change-line\)[^}]*var\(--label-change-bright\)[^}]*var\(--label-change-fill\)/);
assert.match(css, /\.professional-item\.label-boundary \.item-label-line em\s*\{[^}]*var\(--label-change\)/);
assert.match(css, /\.prompt-surface\.label-changed/);
assert.match(css, /\.prompt-surface\s*\{[^}]*position:\s*relative/);
assert.match(css, /\.label-transition-chip\s*\{[^}]*position:\s*absolute/);
assert.match(css, /\.prompter-label-transition/);
assert.match(css, /\.transport-secondary button span\s*\{[^}]*white-space:\s*nowrap/);
const controllerLabelTransitionRule = css.match(/\.label-transition-chip\s*\{([^}]*)\}/)?.[1] ?? '';
const prompterLabelTransitionRule = css.match(/\.prompter-label-transition\s*\{([^}]*)\}/)?.[1] ?? '';
assert.match(controllerLabelTransitionRule, /animation:\s*label-change-notice-in\s+180ms\s+ease-out/);
assert.match(prompterLabelTransitionRule, /animation:\s*label-change-notice-in\s+180ms\s+ease-out/);
assert.doesNotMatch(controllerLabelTransitionRule, /infinite/, '主控端标签提醒动效只执行一次');
assert.doesNotMatch(prompterLabelTransitionRule, /infinite/, '提词端标签提醒动效只执行一次');
assert.match(css, /@keyframes label-change-notice-in\s*\{/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.label-transition-chip,[\s\S]*?\.prompter-label-transition,[\s\S]*?\{ animation: none; \}\s*\}/);
assert.match(css, /\.export-dialog \.export-status-summary/);
assert.doesNotMatch(css, /\.version-comparison\b/, '普通录制界面不保留版本工作台样式');
assert.doesNotMatch(css, /\.attempt-history-row\b/, '普通录制界面不保留 attempt 历史样式');
assert.match(css, /\.issue-filters\s*\{[^}]*grid-template-columns:\s*repeat\(3, 1fr\)/);
assert.match(css, /\.export-scope-control/);
assert.match(css, /\.vad-health-banner\.degraded/);

function luminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi).map((value) => Number.parseInt(value, 16) / 255);
  const linear = channels.map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function token(name) {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  assert.ok(match, `missing color token --${name}`);
  return match[1];
}

function contrast(foreground, background) {
  const high = Math.max(luminance(foreground), luminance(background));
  const low = Math.min(luminance(foreground), luminance(background));
  return (high + 0.05) / (low + 0.05);
}

assert.ok(
  contrast(token('label-change'), token('library')) >= 4.5,
  'label-change text must meet WCAG AA contrast on the sidebar surface',
);
assert.ok(
  contrast(token('label'), token('library')) >= 4.5,
  'ordinary label text must meet WCAG AA contrast on the sidebar surface',
);
assert.ok(
  contrast(token('label'), token('library-raised')) >= 4.5,
  'ordinary label badge text must meet WCAG AA contrast',
);
assert.ok(
  contrast(token('text-2'), token('control')) >= 4.5,
  'selected ordinary label text must meet WCAG AA contrast',
);
assert.ok(
  contrast(token('label-change-bright'), token('chrome')) >= 4.5,
  'label-change emphasis must meet WCAG AA contrast on the prompt surface',
);

console.log('feedback UI contract tests passed');
