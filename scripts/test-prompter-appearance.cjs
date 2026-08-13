'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const helperPath = path.join(__dirname, '..', 'src', 'prompter-appearance.ts');
  const {
    DEFAULT_PROMPTER_FONT_SIZE,
    DEFAULT_PROMPTER_LIVE_COLOR,
    MAX_PROMPTER_FONT_SIZE,
    MIN_PROMPTER_FONT_SIZE,
    PROMPTER_APPEARANCE_KEY,
    defaultPrompterAppearance,
    loadPrompterAppearance,
    normalizePrompterFontSize,
    normalizePrompterLiveColor,
    parsePrompterAppearance,
    prompterFontSizeRem,
    savePrompterAppearance,
  } = await import(pathToFileURL(helperPath).href);

  assert.equal(DEFAULT_PROMPTER_FONT_SIZE, 36);
  assert.equal(DEFAULT_PROMPTER_LIVE_COLOR, '#3dcc7a');
  assert.equal(normalizePrompterFontSize(48), 48);
  assert.equal(normalizePrompterFontSize(8), MIN_PROMPTER_FONT_SIZE);
  assert.equal(normalizePrompterFontSize(200), MAX_PROMPTER_FONT_SIZE);
  assert.equal(normalizePrompterFontSize('nope'), DEFAULT_PROMPTER_FONT_SIZE);
  assert.equal(prompterFontSizeRem(36), '2.25rem');
  assert.equal(prompterFontSizeRem(8), `${MIN_PROMPTER_FONT_SIZE / 16}rem`);
  assert.equal(normalizePrompterLiveColor('#3DCC7A'), '#3dcc7a');
  assert.equal(normalizePrompterLiveColor('#fff'), '#ffffff');
  assert.equal(normalizePrompterLiveColor('green'), DEFAULT_PROMPTER_LIVE_COLOR);
  assert.deepEqual(parsePrompterAppearance(null), defaultPrompterAppearance());
  assert.deepEqual(parsePrompterAppearance({ fontSize: 52, liveColor: '#F4D35E' }), {
    fontSize: 52,
    liveColor: '#f4d35e',
  });

  const store = new Map();
  const storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, value); },
  };
  assert.deepEqual(loadPrompterAppearance(storage), defaultPrompterAppearance());
  const saved = savePrompterAppearance({ fontSize: 44, liveColor: '#5EC8F4' }, storage);
  assert.deepEqual(saved, { fontSize: 44, liveColor: '#5ec8f4' });
  assert.equal(JSON.parse(store.get(PROMPTER_APPEARANCE_KEY)).fontSize, 44);
  assert.deepEqual(loadPrompterAppearance(storage), saved);

  console.log('prompter appearance tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
