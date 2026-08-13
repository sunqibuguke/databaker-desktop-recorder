'use strict';

const fs = require('node:fs');
const path = require('node:path');

function printUsage() {
  console.log(`Usage:
  node scripts/issue-license.cjs issue --machine <CODE> --subject <NAME> [--days 365|--perpetual] [--kid 2026a]
  node scripts/issue-license.cjs verify --ticket <TICKET>

Environment:
  DATABAKER_LICENSE_PRIVATE_KEY_FILE   PEM private key path (default: tools/license-issuer/keys/license-2026a.pem)
  DATABAKER_LICENSE_PUBLIC_KEY_FILE    optional PEM used only by verify
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (command !== 'issue' && command !== 'verify') {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const license = loadLicenseModule();
  if (command === 'verify') {
    const ticket = required(args, 'ticket');
    const claims = license.inspectLicenseTicket(ticket);
    const publicKeys = loadOptionalPublicKeys() ?? undefined;
    const verified = license.verifyLicenseTicket(ticket, { publicKeys });
    if ('reason' in verified) {
      console.error(`INVALID ${verified.reason}`);
      console.log(JSON.stringify(claims, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(verified.claims, null, 2));
    return;
  }

  const ticket = license.issueLicense({
    privateKeyPem: loadPrivateKey(),
    kid: args.kid || '2026a',
    subject: required(args, 'subject'),
    machineCode: required(args, 'machine'),
    days: args.days ? Number(args.days) : undefined,
    perpetual: Boolean(args.perpetual),
  });
  process.stdout.write(`${ticket}\n`);
}

function loadLicenseModule() {
  const compiled = path.join(__dirname, '..', 'dist-electron', 'license.js');
  if (!fs.existsSync(compiled)) {
    throw new Error('找不到 dist-electron/license.js，请先运行 npm run build:electron');
  }
  return require(compiled);
}

function loadPrivateKey() {
  const file = process.env.DATABAKER_LICENSE_PRIVATE_KEY_FILE
    || path.join(__dirname, '..', 'tools', 'license-issuer', 'keys', 'license-2026a.pem');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`读不到签发私钥：${file}。请把正式 PEM 放到该路径，或设置 DATABAKER_LICENSE_PRIVATE_KEY_FILE`);
  }
}

function loadOptionalPublicKeys() {
  const file = process.env.DATABAKER_LICENSE_PUBLIC_KEY_FILE;
  if (!file) return null;
  const kid = process.env.DATABAKER_LICENSE_KID || '2026a';
  return { [kid]: fs.readFileSync(file, 'utf8') };
}

function required(args, name) {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`缺少 --${name}`);
  }
  return value;
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--perpetual') {
      parsed.perpetual = true;
      continue;
    }
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`缺少 --${key} 的值`);
      parsed[key] = value;
      index += 1;
      continue;
    }
    parsed._.push(token);
  }
  return parsed;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
