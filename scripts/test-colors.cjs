'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CSS_PATH = path.join(ROOT, 'src', 'styles.css');
const ISSUER_PATH = path.join(ROOT, 'tools', 'license-issuer', 'index.html');
const REQUIRED_TOKENS = [
  'ink', 'canvas', 'chrome', 'chrome-2', 'editor', 'panel', 'panel-raised', 'dialog',
  'surface', 'surface-hover', 'control', 'control-hover', 'input',
  'library', 'library-header', 'library-row', 'library-raised', 'library-input',
  'library-line', 'library-line-2',
  'line-deep', 'line', 'line-soft', 'line-field', 'line-control', 'line-strong',
  'text', 'text-bright', 'text-soft', 'text-2', 'label', 'muted', 'quiet', 'faint',
  'accent', 'accent-fill', 'accent-fill-hover', 'accent-ink', 'accent-muted',
  'accent-tint', 'accent-soft', 'accent-wash', 'accent-line',
  'record', 'warning', 'ready', 'success', 'success-muted', 'success-fill', 'success-line', 'post-ready', 'danger', 'focus',
  'danger-soft', 'warning-soft', 'shadow', 'shadow-soft', 'highlight', 'scrim', 'brand-tile', 'prompter-live',
];
const NEAR_TOKEN_LIMIT = 8;
const MAX_UNIQUE_LEFTOVERS = 120;

function expandHex(hex) {
  const value = hex.toLowerCase();
  if (value.length === 4) return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  return value;
}

function parseColor(value) {
  const raw = value.trim().toLowerCase().replace(/\s+/g, ' ');
  const hex = raw.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    const full = expandHex(`#${hex[1]}`);
    return {
      r: parseInt(full.slice(1, 3), 16),
      g: parseInt(full.slice(3, 5), 16),
      b: parseInt(full.slice(5, 7), 16),
      a: 1,
    };
  }
  const rgba = raw.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)$/);
  if (!rgba) return null;
  return {
    r: Number(rgba[1]),
    g: Number(rgba[2]),
    b: Number(rgba[3]),
    a: rgba[4] === undefined ? 1 : Number(rgba[4]),
  };
}

function rgbDist(a, b) {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b) + Math.abs(a.a - b.a) * 80;
}

function rootBlock(source) {
  const match = source.match(/:root\s*\{[\s\S]*?\n\s*\}/);
  assert.ok(match, 'missing :root block');
  return match[0];
}

function colorTokens(root) {
  const tokens = [];
  for (const match of root.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const color = parseColor(match[2]);
    if (color) tokens.push({ name: match[1], value: match[2].trim(), color });
  }
  return tokens;
}

function leftoverColors(source) {
  const body = source.slice(rootBlock(source).length);
  return [...body.matchAll(/#(?:[0-9a-fA-F]{3,8})\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*[0-9.]+)?\s*\)/g)]
    .map((match) => match[0]);
}

function main() {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  assert.doesNotMatch(css, /var\(--white\)-space/);
  assert.match(css, /white-space/);
  assert.match(css, /color:\s*var\(--text\)/);
  assert.match(css, /background:\s*var\(--ink\)/);
  assert.doesNotMatch(css, /\.prompter-shell\s*\{[^}]*border-(?:top|bottom)\s*:/);
  assert.doesNotMatch(
    css,
    /\.prompter-shell\.(?:checking|pending|recording|ready|fault)\s*\{[^}]*\bbackground\s*:/,
    'prompter cue states must not wash the page background',
  );
  assert.match(css, /\.silence-review-toggle\s*\{[^}]*cursor:\s*pointer/, 'rule rows must show a pointer');
  assert.match(css, /\.silence-review-toggle input\s*\{[^}]*cursor:\s*pointer/, 'the hidden checkbox must keep the pointer');
  assert.match(
    css,
    /\.silence-review-toggle:hover:not\(:has\(input:disabled\)\):not\(:has\(input:checked\)\) \.rule-switch/,
    'unchecked switch hover must not apply to a checked rule',
  );
  assert.match(
    css,
    /\.silence-review-toggle:hover:has\(input:checked\):not\(:has\(input:disabled\)\) \.rule-switch[^}]*background:\s*var\(--accent-fill-hover\)/,
    'checked switch hover must stay filled',
  );
  assert.doesNotMatch(
    css,
    /\.silence-review-toggle:hover:not\(:has\(input:disabled\)\) \.rule-switch/,
    'checked hover must not reuse the unchecked switch fill',
  );
  assert.match(css, /\.silence-review-toggle:has\(input:disabled\)\s*\{[^}]*opacity:\s*\.38/, 'disabled switches must be visibly muted');
  assert.match(css, /button:not\(:disabled\),\s*select:not\(:disabled\)/, 'clickable controls must share a pointer');
  assert.match(css, /input:not\(:disabled\):is\([^{]*\[type="text"\]/, 'text fields must keep a text cursor');
  assert.match(
    css,
    /input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="range"\]\)/,
    'range inputs must not inherit text-field chrome',
  );
  assert.match(css, /input\[type="range"\]::-webkit-slider-thumb\s*\{[^}]*-webkit-appearance:\s*none/, 'range thumbs must be real custom controls');

  const tokens = colorTokens(rootBlock(css));
  const names = new Set(tokens.map((token) => token.name));
  for (const name of REQUIRED_TOKENS) {
    assert.ok(names.has(name), `missing color token --${name}`);
  }

  const leftovers = leftoverColors(css);
  const near = [];
  for (const leftover of leftovers) {
    const color = parseColor(leftover);
    if (!color) continue;
    for (const token of tokens) {
      if (rgbDist(color, token.color) <= NEAR_TOKEN_LIMIT) {
        near.push(`${leftover} ≈ --${token.name} (${token.value})`);
      }
    }
  }
  assert.deepEqual(near, [], `raw colors still match a token:\n${near.join('\n')}`);

  const unique = new Set(leftovers.map((value) => value.toLowerCase().replace(/\s+/g, ' ')));
  assert.ok(
    unique.size <= MAX_UNIQUE_LEFTOVERS,
    `too many leftover unique colors: ${unique.size} > ${MAX_UNIQUE_LEFTOVERS}`,
  );

  const issuer = fs.readFileSync(ISSUER_PATH, 'utf8');
  assert.doesNotMatch(issuer.slice(rootBlock(issuer).length), /#[0-9a-fA-F]{3,8}\b|rgba?\(/);

  console.log(`color tests passed (${tokens.length} tokens, ${unique.size} leftover uniques)`);
}

main();
