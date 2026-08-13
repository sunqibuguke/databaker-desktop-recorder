'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');

async function main() {
  const {
    LicenseRepository,
    issueLicense,
    verifyLicenseTicket,
    inspectLicenseTicket,
    isLicenseExemptEngineCommand,
    isLicenseCheckDisabled,
    LicenseRequiredError,
    CLOCK_ROLLBACK_GRACE_SECONDS,
  } = require('../dist-electron/license.js');
  const {
    collectMachineFingerprint,
    encodeMachineCode,
    hashFingerprintComponent,
    matchFingerprint,
    normalizeMachineCode,
  } = require('../dist-electron/machine-fingerprint.js');

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeys = {
    test1: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const hashes = ['a', 'b', 'c'].map((id) => hashFingerprintComponent(id, `value-${id}`));
  const fingerprint = {
    machineCode: encodeMachineCode(hashes),
    componentHashes: hashes,
  };
  assert.match(fingerprint.machineCode, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(normalizeMachineCode(fingerprint.machineCode.toLowerCase()), fingerprint.machineCode);

  const now = 1_786_377_600_000;
  const issue = (overrides = {}) => issueLicense({
    privateKeyPem,
    kid: 'test1',
    subject: '客户A-工位3',
    machineCode: fingerprint.machineCode,
    now,
    jti: 'ticket-1',
    days: 365,
    ...overrides,
  });

  const valid = issue();
  const verified = verifyLicenseTicket(valid, {
    publicKeys,
    now,
    machineCode: fingerprint.machineCode,
  });
  assert.equal('claims' in verified, true);
  assert.equal(verified.claims.sub, '客户A-工位3');
  assert.equal(verified.claims.mid, fingerprint.machineCode);
  assert.equal(verified.claims.exp, Math.floor(now / 1000) + 365 * 86_400);
  assert.deepEqual(inspectLicenseTicket(valid), verified.claims);

  assert.equal(verifyLicenseTicket('not-a-ticket', { publicKeys }).reason, 'malformed');
  assert.equal(verifyLicenseTicket(valid.slice(0, -4), { publicKeys }).reason, 'malformed');
  const other = generateKeyPairSync('ed25519');
  const forged = issueLicense({
    privateKeyPem: other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    kid: 'test1',
    subject: '伪造',
    machineCode: fingerprint.machineCode,
    now,
  });
  assert.equal(verifyLicenseTicket(forged, { publicKeys }).reason, 'bad_signature');
  assert.equal(verifyLicenseTicket(valid, { publicKeys: { other: publicKeys.test1 } }).reason, 'unknown_kid');
  assert.equal(verifyLicenseTicket(valid, {
    publicKeys,
    now,
    machineCode: 'A7K2-9M3P-Q4WX',
  }).reason, 'wrong_machine');
  assert.equal(verifyLicenseTicket(valid, {
    publicKeys,
    now: now + 366 * 86_400 * 1000,
    machineCode: fingerprint.machineCode,
  }).reason, 'expired');

  const perpetual = issue({ perpetual: true, jti: 'forever' });
  assert.equal(inspectLicenseTicket(perpetual).exp, null);
  assert.equal('claims' in verifyLicenseTicket(perpetual, {
    publicKeys,
    now: now + 20 * 365 * 86_400 * 1000,
    machineCode: fingerprint.machineCode,
  }), true);

  assert.equal(matchFingerprint(hashes, hashes), true);
  assert.equal(matchFingerprint(hashes, [hashes[0], hashes[1], hashFingerprintComponent('x', 'y')]), true);
  assert.equal(matchFingerprint(hashes, [hashes[0], hashFingerprintComponent('x', 'y'), hashFingerprintComponent('z', 'w')]), false);

  const drifted = verifyLicenseTicket(valid, {
    publicKeys,
    now,
    machineCode: 'A7K2-9M3P-Q4WX',
    storedComponentHashes: hashes,
    currentComponentHashes: [hashes[0], hashes[1], hashFingerprintComponent('x', 'y')],
  });
  assert.equal('claims' in drifted, true, '2 of 3 component hashes must keep an already issued ticket valid');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'databaker-license-'));
  const file = path.join(root, 'license.json');
  let clock = now;
  try {
    const repository = new LicenseRepository(file, {
      publicKeys,
      now: () => clock,
      createToken: () => 'token-1',
    });
    assert.deepEqual(await repository.evaluate(fingerprint), {
      state: 'invalid',
      reason: 'unlicensed',
      machineCode: fingerprint.machineCode,
      licensee: null,
      expiresAt: null,
      daysRemaining: null,
      issuedAt: null,
      kid: null,
    });

    const activated = await repository.activate(valid, fingerprint);
    assert.equal(activated.state, 'valid');
    assert.equal(activated.licensee, '客户A-工位3');
    assert.equal(activated.daysRemaining, 365);
    assert.equal((await repository.evaluate(fingerprint)).state, 'valid');

    const replacement = issue({ subject: '客户A-续期', jti: 'ticket-2', days: 10 });
    const renewed = await repository.activate(replacement, fingerprint);
    assert.equal(renewed.licensee, '客户A-续期');
    assert.equal(renewed.daysRemaining, 10);

    clock = now + 11 * 86_400 * 1000;
    const expired = await repository.evaluate(fingerprint);
    assert.equal(expired.state, 'invalid');
    assert.equal(expired.reason, 'expired');
    assert.equal(expired.licensee, '客户A-续期');

    await repository.activate(issue({ jti: 'fresh', days: 30 }), fingerprint);
    clock = now - (CLOCK_ROLLBACK_GRACE_SECONDS + 10) * 1000;
    const rolled = await repository.evaluate(fingerprint);
    assert.equal(rolled.reason, 'clock_rollback');

    const otherMachine = {
      machineCode: encodeMachineCode([hashFingerprintComponent('solo', 'only')]),
      componentHashes: [hashFingerprintComponent('solo', 'only')],
    };
    assert.equal((await repository.activate(valid, otherMachine)).reason, 'wrong_machine');

    await fs.writeFile(file, '{broken', 'utf8');
    const recovered = await repository.load();
    assert.equal(recovered.license, null);
    assert.match(recovered.warning, /已保留/);

    assert.equal((await repository.evaluate({ machineCode: '', componentHashes: [] })).reason, 'fingerprint_unavailable');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  const collected = await collectMachineFingerprint(async () => [
    { id: 'machine-guid', value: 'guid-a' },
    { id: 'system-volume', value: 'vol-b' },
    { id: 'board-uuid', value: 'board-c' },
  ]);
  assert.equal(collected.componentHashes.length, 3);
  assert.ok(collected.machineCode);

  const productionKeys = require('../dist-electron/license-keys.js').LICENSE_PUBLIC_KEYS;
  assert.ok(productionKeys['2026a']);
  assert.equal(productionKeys.test1, undefined, 'test keypairs must not ship in the app public key set');

  const fixtureKey = await fs.readFile(
    path.join(__dirname, 'fixtures', 'license-test-only-test1.pem'),
    'utf8',
  );
  const fixtureTicket = issueLicense({
    privateKeyPem: fixtureKey,
    kid: 'test1',
    subject: 'fixture',
    machineCode: fingerprint.machineCode,
    now,
    perpetual: true,
  });
  assert.equal(verifyLicenseTicket(fixtureTicket, {
    publicKeys: productionKeys,
    machineCode: fingerprint.machineCode,
  }).reason, 'unknown_kid');

  assert.equal(isLicenseExemptEngineCommand('seal_interrupted_session'), true);
  assert.equal(isLicenseExemptEngineCommand('stop_session'), true);
  assert.equal(isLicenseExemptEngineCommand('create_session'), false);
  assert.equal(isLicenseExemptEngineCommand('export_session'), false);
  assert.equal(isLicenseCheckDisabled({ DATABAKER_LICENSE_DISABLED: '1' }), true);
  assert.equal(isLicenseCheckDisabled({}), false);

  const required = new LicenseRequiredError('unlicensed');
  assert.equal(required.code, 'LICENSE_REQUIRED');
  assert.match(required.message, /LICENSE_REQUIRED/);

  const { sanitizeValue } = require('../dist-electron/sentry-sanitize.js');
  assert.equal(sanitizeValue({ ticket: valid, license: valid }).ticket, '[Filtered]');
  assert.equal(sanitizeValue({ machineCode: fingerprint.machineCode }).machineCode, '[Filtered]');

  console.log('license tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
