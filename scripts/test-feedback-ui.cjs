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
assert.match(recorder, /data-testid="confirm-script-preview"/);
assert.match(recorder, /scriptPreviewConfirmed && scriptItems\.length > 0/);
assert.match(recorder, /isLabelBoundary\(items, index\)/);
assert.match(recorder, /itemRequiresRerecord\(item\)/);
assert.match(recorder, /findNextRerecordIndex\(items, currentIndex\)/);
assert.match(recorder, /scrollIntoView\(\{\s*block: 'nearest'/);
assert.match(recorder, /tabIndex=\{index === currentIndex \? 0 : -1\}/);
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
assert.match(recorder, /hasRetakeVersionChoice/);
assert.ok(
  recorder.indexOf('if (isRetakeDecision)')
    < recorder.indexOf('const continuation = continuationAfterAccept'),
  'retake decisions must return before ordinary auto-start continuation',
);
assert.match(recorder, /reviewCount > 0/);
assert.match(recorder, /export-status-summary/);
assert.match(recorder, /exportDialog\.cutsBlockedReview/);
assert.match(recorder, /state\.exported_count/);
assert.match(recorder, /void refreshRecordings\(outputDirRef\.current\)/);
assert.match(recorder, /recording \|\| captureFault \|\| workspaceFaulted \|\| reviewCount > 0/);
assert.match(recorder, /disabled=\{recording \|\| !reviewAttempt \|\| Boolean\(busy\)\}/);
assert.doesNotMatch(recorder, /知道了/);

assert.match(types, /labelTransition\?: ScriptLabelTransition \| null/);
assert.match(prompter, /state\?\.labelTransition\?\.changed/);
assert.equal((prompter.match(/step=\{1\}/g) ?? []).length, 2);
assert.equal((prompter.match(/step=\{2\}/g) ?? []).length, 2);
assert.match(prompter, /className="prompter-label-transition" role="status" aria-live="polite"/);

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
assert.match(css, /\.export-dialog \.export-status-summary/);

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
