'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MIN_REM = 0.625;
const TYPE_SOURCES = [
  path.join(ROOT, 'src', 'styles.css'),
  path.join(ROOT, 'tools', 'license-issuer', 'index.html'),
];

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

function collectMatches(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match[0]);
}

function remValues(source) {
  return [...source.matchAll(/(\d+(?:\.\d+)?)rem/g)].map((match) => Number(match[1]));
}

function main() {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /--text-xs:\s*0\.625rem/);
  assert.match(css, /html\s*\{\s*font-size:\s*16px\s*;/);
  assert.match(css, /body\s*\{[^}]*font-size:\s*var\(--text-sm\)/);
  assert.match(css, /small\s*\{\s*font-size:\s*var\(--text-xs\)/);

  for (const filePath of TYPE_SOURCES) {
    const raw = stripComments(fs.readFileSync(filePath, 'utf8'));
    const relative = path.relative(ROOT, filePath);
    const pxType = collectMatches(raw, /font(?:-size)?:\s*[^;{}]*?\d+px/g)
      .filter((declaration) => declaration !== 'font-size: 16px');
    assert.deepEqual(pxType, [], `${relative} still has px type: ${pxType.join(', ')}`);

    for (const value of remValues(raw).filter((rem) => {
      const at = raw.search(new RegExp(`${String(rem).replace('.', '\\.')}rem`));
      const window = raw.slice(Math.max(0, at - 40), at + 20);
      return /font(?:-size)?:/.test(window) || /--text-/.test(window) || /--prompter-copy-size/.test(window);
    })) {
      assert.ok(value + 1e-9 >= MIN_REM, `${relative} has type below 10px: ${value}rem`);
    }
  }

  const prompter = fs.readFileSync(path.join(ROOT, 'src', 'Prompter.tsx'), 'utf8');
  assert.match(prompter, /prompterFontSizeRem\(appearance\.fontSize\)/);
  assert.match(prompter, /prompterLabelFontSizeRem\(appearance\.labelFontSize\)/);
  assert.doesNotMatch(prompter, /--prompter-copy-size['"]?\s*as string\]:\s*`\$\{appearance\.fontSize\}px`/);
  assert.doesNotMatch(prompter, /--prompter-label-size['"]?\s*as string\]:\s*`\$\{appearance\.labelFontSize\}px`/);
  const recorder = fs.readFileSync(path.join(ROOT, 'src', 'Recorder.tsx'), 'utf8');
  assert.match(recorder, /prompterFontSizeRem\(appearance\.fontSize\)/);
  assert.match(recorder, /prompterLabelFontSizeRem\(appearance\.labelFontSize\)/);
  assert.doesNotMatch(recorder, /--prompter-copy-size['"]?\s*as string\]:\s*`\$\{appearance\.fontSize\}px`/);
  assert.match(css, /\.prompt-surface p\s*\{[^}]*font-size:\s*var\(--prompter-copy-size/);
  assert.match(css, /\.prompter-label strong\s*\{[^}]*font-size:\s*var\(--prompter-label-size/);

  assert.match(css, /\.settings-dialog\s*\{[^}]*max-height:\s*calc\(100d?vh - 71px\)/);
  assert.match(css, /\.settings-dialog\s*\{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto/);
  assert.match(css, /\.settings-content\s*\{[^}]*overflow:\s*auto/);

  console.log('typography tests passed');
}

main();
