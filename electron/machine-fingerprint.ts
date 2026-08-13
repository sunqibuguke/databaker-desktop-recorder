import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type FingerprintComponent = {
  id: string;
  value: string;
};

export type MachineFingerprint = {
  machineCode: string;
  componentHashes: string[];
};

export type FingerprintCollector = () => Promise<FingerprintComponent[]>;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MACHINE_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const COLLECT_TIMEOUT_MS = 5_000;
const MIN_COMPONENTS_FOR_CODE = 1;

export function isMachineCode(value: string): boolean {
  return MACHINE_CODE_PATTERN.test(value);
}

export function normalizeMachineCode(value: string): string {
  const compact = value
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/[^0-9A-HJKMNP-TV-Z]/g, '');
  if (compact.length !== 12) throw new Error('机器码格式无效');
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}`;
}

export function hashFingerprintComponent(id: string, value: string): string {
  return createHash('sha256').update(`${id}\0${value.trim()}`).digest('hex');
}

export function encodeMachineCode(componentHashes: readonly string[]): string {
  if (componentHashes.length < MIN_COMPONENTS_FOR_CODE) return '';
  const digest = createHash('sha256').update(componentHashes.slice().sort().join(',')).digest();
  const chars = encodeCrockford(digest.subarray(0, 8)).slice(0, 12);
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

export function matchFingerprint(
  storedHashes: readonly string[],
  currentHashes: readonly string[],
): boolean {
  if (storedHashes.length === 0 || currentHashes.length === 0) return false;
  const current = new Set(currentHashes);
  const hits = storedHashes.filter((hash) => current.has(hash)).length;
  if (storedHashes.length >= 3) return hits >= 2;
  return hits === storedHashes.length;
}

export async function collectMachineFingerprint(
  collector: FingerprintCollector = collectPlatformComponents,
): Promise<MachineFingerprint> {
  const components = await collector();
  const unique = new Map<string, string>();
  for (const component of components) {
    const id = component.id.trim();
    const value = component.value.trim();
    if (!id || !value) continue;
    unique.set(id, hashFingerprintComponent(id, value));
  }
  const componentHashes = [...unique.values()].sort();
  return {
    machineCode: encodeMachineCode(componentHashes),
    componentHashes,
  };
}

async function collectPlatformComponents(): Promise<FingerprintComponent[]> {
  if (process.platform === 'win32') return collectWindowsComponents();
  if (process.platform === 'darwin') return collectDarwinComponents();
  return collectLinuxComponents();
}

async function collectWindowsComponents(): Promise<FingerprintComponent[]> {
  const [machineGuid, volumeSerial, boardUuid] = await Promise.all([
    runText('reg', [
      'query',
      'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
      '/v',
      'MachineGuid',
    ]).then((text) => firstMatch(text, /MachineGuid\s+REG_SZ\s+([0-9a-f-]+)/i)),
    runText('cmd', ['/d', '/c', 'vol C:']).then((text) => firstMatch(
      text,
      /Volume Serial Number is\s+([0-9A-F-]+)/i,
    )),
    runText('powershell', [
      '-NoProfile',
      '-Command',
      '(Get-CimInstance -Class Win32_ComputerSystemProduct).UUID',
    ]).then((text) => text.trim()),
  ]);
  return namedComponents([
    ['machine-guid', machineGuid],
    ['system-volume', volumeSerial],
    ['board-uuid', boardUuid],
  ]);
}

async function collectDarwinComponents(): Promise<FingerprintComponent[]> {
  const [ioreg, diskutil] = await Promise.all([
    runText('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']),
    runText('diskutil', ['info', '/']),
  ]);
  return namedComponents([
    ['platform-uuid', firstMatch(ioreg, /"IOPlatformUUID"\s*=\s*"([^"]+)"/)],
    ['hardware-serial', firstMatch(ioreg, /"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/)],
    ['boot-volume', firstMatch(diskutil, /Volume UUID:\s+([0-9A-F-]+)/i)],
  ]);
}

async function collectLinuxComponents(): Promise<FingerprintComponent[]> {
  const [machineId, productUuid] = await Promise.all([
    runText('cat', ['/etc/machine-id']).catch(() => ''),
    runText('cat', ['/sys/class/dmi/id/product_uuid']).catch(() => ''),
  ]);
  return namedComponents([
    ['machine-id', machineId],
    ['product-uuid', productUuid],
  ]);
}

function namedComponents(entries: ReadonlyArray<readonly [string, string]>): FingerprintComponent[] {
  return entries
    .filter(([, value]) => Boolean(value && !/^(none|to be filled|default string)$/i.test(value)))
    .map(([id, value]) => ({ id, value }));
}

function firstMatch(text: string, pattern: RegExp): string {
  return text.match(pattern)?.[1]?.trim() ?? '';
}

async function runText(command: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: COLLECT_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf8',
    });
    return `${stdout}\n${stderr}`;
  } catch {
    return '';
  }
}

function encodeCrockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += CROCKFORD[(value << (5 - bits)) & 31];
  return output;
}
