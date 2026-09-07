const { app, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { SystemLicenseProtection } = require('../dist-electron/license-protection.js');
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'databaker-license-protection-'));
  try {
    assert.equal(safeStorage.isEncryptionAvailable(), true);
    const file = path.join(directory, 'license.key');
    const original = new SystemLicenseProtection(file, safeStorage);
    const protectedValue = await original.seal('temporary test data', 'license-v2');
    const restarted = new SystemLicenseProtection(file, safeStorage);
    assert.equal(await restarted.open(protectedValue, 'license-v2'), 'temporary test data');
    await assert.rejects(restarted.open(protectedValue, 'license-clock-v1'));
    const tampered = Buffer.from(protectedValue, 'base64'); tampered[tampered.length - 1] ^= 1;
    await assert.rejects(restarted.open(tampered.toString('base64'), 'license-v2'));
    console.log(`${process.platform} real Electron safeStorage: encrypted key reload, authenticated record, purpose binding and tamper rejection passed`);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
  app.exit(0);
}).catch((error) => { console.error(error.message); app.exit(1); });
