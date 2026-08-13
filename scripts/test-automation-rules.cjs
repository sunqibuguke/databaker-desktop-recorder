const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const {
    DEFAULT_AUTOMATION_RULES,
    loadAutomationRules,
    normalizeAutomationRules,
    saveAutomationRules,
    showsPostTakeQualityBill,
  } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'automation-rules.ts')).href);

  assert.deepEqual(DEFAULT_AUTOMATION_RULES, {
    autoStartNext: true,
    headTailSilence: true,
    discardEmpty: true,
    envCheck: true,
    almostSilent: false,
    peakHigh: false,
  });
  assert.equal(showsPostTakeQualityBill(DEFAULT_AUTOMATION_RULES), true);
  assert.equal(
    showsPostTakeQualityBill({ ...DEFAULT_AUTOMATION_RULES, headTailSilence: false }),
    false,
  );
  assert.equal(
    showsPostTakeQualityBill({
      ...DEFAULT_AUTOMATION_RULES,
      headTailSilence: false,
      almostSilent: true,
    }),
    true,
  );

  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };

  assert.deepEqual(loadAutomationRules('session-a'), DEFAULT_AUTOMATION_RULES);
  store.set('databaker:post-take-silence:session-a', '0');
  assert.equal(loadAutomationRules('session-a').headTailSilence, false);
  assert.equal(loadAutomationRules('session-a').discardEmpty, true);

  saveAutomationRules('session-a', {
    ...DEFAULT_AUTOMATION_RULES,
    envCheck: false,
    almostSilent: true,
  });
  const loaded = loadAutomationRules('session-a');
  assert.equal(loaded.envCheck, false);
  assert.equal(loaded.almostSilent, true);
  assert.equal(loaded.headTailSilence, true);
  assert.deepEqual(
    normalizeAutomationRules({ discardEmpty: 'nope', peakHigh: true }),
    { ...DEFAULT_AUTOMATION_RULES, peakHigh: true },
  );
  assert.equal(
    normalizeAutomationRules({ headTailSilence: false }).autoStartNext,
    true,
    'older saved rules without autoStartNext must default on',
  );

  console.log('automation rules tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
