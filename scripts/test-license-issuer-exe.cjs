'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join('tools', 'license-issuer-exe', 'Cargo.toml');
const GOLDEN = 'DBR1.FCH7C8HT64P24TV9CGH3M8KMCNSQ8C925GH6MX3948X24X39CDNPAX1D64H2R8KKENH24EH2WPQA5SM8PX0JVSDQMQJBV39K48P24VB9CGH3M8J16X5K4B9S9MSN0BAH6HBNG8HC49MP2X1278RKEE1P6CVKEDHG60P24SBRE0H3MC9R64VKJC9K6RR30Z8.NQ2WRXENJS77WYD341DSAWSJ234AY8GCGA4VCH3EYP0SGN69SJ1JD18ESZZZB4CYQGPQ004VH71J7RZFE2K6X2PVXJ3NQMP3M9JWE3G';

function cargo(args) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-cargo.cjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`cargo ${args.join(' ')} failed`);
  }
}

function issuerBin() {
  const name = process.platform === 'win32'
    ? 'databaker-license-issuer.exe'
    : 'databaker-license-issuer';
  return path.join(ROOT, 'tools', 'license-issuer-exe', 'target', 'debug', name);
}

function runIssuer(args, env = {}) {
  return spawnSync(issuerBin(), args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function loadLicenseModule() {
  const compiled = path.join(ROOT, 'dist-electron', 'license.js');
  if (!fs.existsSync(compiled)) {
    const build = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'electron/tsconfig.json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'inherit',
    });
    if (build.status !== 0) {
      throw new Error('找不到 dist-electron/license.js，且无法编译 electron');
    }
  }
  return require(compiled);
}

function main() {
  cargo(['fmt', '--manifest-path', MANIFEST, '--', '--check']);
  cargo(['clippy', '--manifest-path', MANIFEST, '--all-targets', '--no-default-features', '--', '-D', 'warnings']);
  cargo(['test', '--manifest-path', MANIFEST, '--no-default-features']);
  cargo(['build', '--manifest-path', MANIFEST, '--no-default-features']);

  const key = path.join(ROOT, 'scripts', 'fixtures', 'license-test-only-test1.pem');
  const issued = runIssuer([
    '--key', key,
    '--kid', 'test1',
    '--machine', 'A7K2-9M3P-Q4WX',
    '--subject', '客户A-工位3',
    '--days', '365',
    '--jti', 'ticket-1',
    '--now-ms', '1786377600000',
  ]);
  assert.equal(issued.status, 0, issued.stderr || issued.stdout);
  const ticket = issued.stdout.trim();
  assert.equal(ticket, GOLDEN);

  const license = loadLicenseModule();
  const publicKey = fs.readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'license-test-only-test1.pub.pem'), 'utf8');
  const verified = license.verifyLicenseTicket(ticket, {
    publicKeys: { test1: publicKey },
    now: 1_786_377_600_000,
    machineCode: 'A7K2-9M3P-Q4WX',
  });
  assert.equal('claims' in verified, true, JSON.stringify(verified));
  assert.equal(verified.claims.sub, '客户A-工位3');
  assert.equal(verified.claims.mid, 'A7K2-9M3P-Q4WX');

  const fresh = runIssuer([
    '--key', key,
    '--kid', 'test1',
    '--machine', 'a7k2 9m3p q4wx',
    '--subject', '客户A-工位3',
    '--perpetual',
  ]);
  assert.equal(fresh.status, 0, fresh.stderr || fresh.stdout);
  const freshTicket = fresh.stdout.trim();
  const freshVerified = license.verifyLicenseTicket(freshTicket, {
    publicKeys: { test1: publicKey },
    machineCode: 'A7K2-9M3P-Q4WX',
  });
  assert.equal('claims' in freshVerified, true, JSON.stringify(freshVerified));
  assert.equal(freshVerified.claims.exp, null);

  const tempRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'databaker-issuer-clear-'));
  const licenseFile = path.join(tempRoot, 'license.json');
  const sidecar = path.join(tempRoot, 'license.json.corrupt-1');
  const keep = path.join(tempRoot, 'output-root.json');
  fs.writeFileSync(licenseFile, '{"schemaVersion":1,"ticket":"x"}\n');
  fs.writeFileSync(sidecar, 'broken\n');
  fs.writeFileSync(keep, '{}\n');
  const cleared = runIssuer(['--clear-local', '--license-file', licenseFile]);
  assert.equal(cleared.status, 0, cleared.stderr || cleared.stdout);
  assert.match(cleared.stdout, /已删除 2 个授权文件/);
  assert.equal(fs.existsSync(licenseFile), false);
  assert.equal(fs.existsSync(sidecar), false);
  assert.equal(fs.existsSync(keep), true);
  const alreadyClear = runIssuer(['--clear-local', '--license-file', licenseFile]);
  assert.equal(alreadyClear.status, 0, alreadyClear.stderr || alreadyClear.stdout);
  assert.match(alreadyClear.stdout, /本机没有授权记录/);
  fs.rmSync(tempRoot, { recursive: true, force: true });

  console.log('license issuer exe tests passed');
}

main();
