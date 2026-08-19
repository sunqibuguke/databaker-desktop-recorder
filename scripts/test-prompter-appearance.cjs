'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const helperPath = path.join(__dirname, '..', 'src', 'prompter-appearance.ts');
  const {
    DEFAULT_PROMPTER_FONT_SIZE,
    DEFAULT_PROMPTER_LABEL_FONT_SIZE,
    DEFAULT_PROMPTER_LIVE_COLOR,
    MAX_PROMPTER_FONT_SIZE,
    MAX_PROMPTER_LABEL_FONT_SIZE,
    MIN_PROMPTER_FONT_SIZE,
    MIN_PROMPTER_LABEL_FONT_SIZE,
    PROMPTER_APPEARANCE_KEY,
    PROMPTER_FONT_SIZE_STEP,
    defaultPrompterAppearance,
    loadPrompterAppearance,
    normalizePrompterFontSize,
    normalizePrompterLabelFontSize,
    normalizePrompterLiveColor,
    nudgePrompterFontSize,
    nudgePrompterLabelFontSize,
    parsePrompterAppearance,
    prompterFontSizeRem,
    prompterLabelFontSizeRem,
    savePrompterAppearance,
  } = await import(pathToFileURL(helperPath).href);

  assert.equal(DEFAULT_PROMPTER_FONT_SIZE, 36);
  assert.equal(DEFAULT_PROMPTER_LABEL_FONT_SIZE, 16);
  assert.equal(DEFAULT_PROMPTER_LIVE_COLOR, '#3dcc7a');
  assert.equal(MAX_PROMPTER_FONT_SIZE, 250);
  assert.equal(normalizePrompterFontSize(48), 48);
  assert.equal(normalizePrompterFontSize(8), MIN_PROMPTER_FONT_SIZE);
  assert.equal(normalizePrompterFontSize(200), 200);
  assert.equal(normalizePrompterFontSize(250), 250);
  assert.equal(normalizePrompterFontSize(400), MAX_PROMPTER_FONT_SIZE);
  assert.equal(normalizePrompterFontSize('nope'), DEFAULT_PROMPTER_FONT_SIZE);
  assert.equal(prompterFontSizeRem(36), '2.25rem');
  assert.equal(prompterFontSizeRem(8), `${MIN_PROMPTER_FONT_SIZE / 16}rem`);
  assert.equal(PROMPTER_FONT_SIZE_STEP, 2);
  assert.equal(nudgePrompterFontSize(36, PROMPTER_FONT_SIZE_STEP), 38);
  assert.equal(nudgePrompterFontSize(36, -PROMPTER_FONT_SIZE_STEP), 34);
  assert.equal(nudgePrompterFontSize(MIN_PROMPTER_FONT_SIZE, -4), MIN_PROMPTER_FONT_SIZE);
  assert.equal(nudgePrompterFontSize(MAX_PROMPTER_FONT_SIZE, 4), MAX_PROMPTER_FONT_SIZE);
  assert.equal(normalizePrompterLabelFontSize(20), 20);
  assert.equal(normalizePrompterLabelFontSize(4), MIN_PROMPTER_LABEL_FONT_SIZE);
  assert.equal(normalizePrompterLabelFontSize(80), MAX_PROMPTER_LABEL_FONT_SIZE);
  assert.equal(prompterLabelFontSizeRem(16), '1rem');
  assert.equal(nudgePrompterLabelFontSize(16, PROMPTER_FONT_SIZE_STEP), 18);
  assert.equal(nudgePrompterLabelFontSize(MIN_PROMPTER_LABEL_FONT_SIZE, -4), MIN_PROMPTER_LABEL_FONT_SIZE);
  assert.equal(PROMPTER_APPEARANCE_KEY, 'databaker-prompter-appearance');
  assert.doesNotMatch(PROMPTER_APPEARANCE_KEY, /session|task|item/i);
  assert.equal(normalizePrompterLiveColor('#3DCC7A'), '#3dcc7a');
  assert.equal(normalizePrompterLiveColor('#fff'), '#ffffff');
  assert.equal(normalizePrompterLiveColor('green'), DEFAULT_PROMPTER_LIVE_COLOR);
  assert.deepEqual(parsePrompterAppearance(null), defaultPrompterAppearance());
  assert.deepEqual(parsePrompterAppearance({ fontSize: 52, liveColor: '#F4D35E' }), {
    fontSize: 52,
    labelFontSize: DEFAULT_PROMPTER_LABEL_FONT_SIZE,
    liveColor: '#f4d35e',
  });
  assert.deepEqual(parsePrompterAppearance({ fontSize: 40, labelFontSize: 24, liveColor: '#F4D35E' }), {
    fontSize: 40,
    labelFontSize: 24,
    liveColor: '#f4d35e',
  });

  const store = new Map();
  const storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, value); },
  };
  assert.deepEqual(loadPrompterAppearance(storage), defaultPrompterAppearance());
  const saved = savePrompterAppearance({ fontSize: 44, labelFontSize: 22, liveColor: '#5EC8F4' }, storage);
  assert.deepEqual(saved, { fontSize: 44, labelFontSize: 22, liveColor: '#5ec8f4' });
  assert.equal(JSON.parse(store.get(PROMPTER_APPEARANCE_KEY)).fontSize, 44);
  assert.equal(JSON.parse(store.get(PROMPTER_APPEARANCE_KEY)).labelFontSize, 22);
  assert.deepEqual(loadPrompterAppearance(storage), saved);
  savePrompterAppearance({ fontSize: 50, labelFontSize: 28, liveColor: saved.liveColor }, storage);
  assert.deepEqual([...store.keys()], [PROMPTER_APPEARANCE_KEY]);
  assert.equal(loadPrompterAppearance(storage).fontSize, 50);
  assert.equal(loadPrompterAppearance(storage).labelFontSize, 28);

  console.log('prompter appearance tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
