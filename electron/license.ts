import { createPrivateKey, createPublicKey, randomUUID, sign as signBytes, verify as verifyBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { LICENSE_PUBLIC_KEYS } from './license-keys';
import {
  isMachineCode,
  matchFingerprint,
  normalizeMachineCode,
  type MachineFingerprint,
} from './machine-fingerprint';

export const LICENSE_TICKET_PREFIX = 'DBR1';
export const LICENSE_DISABLED_ENV = 'DATABAKER_LICENSE_DISABLED';
export const CLOCK_ROLLBACK_GRACE_SECONDS = 86_400;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_SUBJECT_LENGTH = 128;
const MAX_TICKET_LENGTH = 4_096;

export type LicenseClaims = {
  v: 1;
  kid: string;
  jti: string;
  sub: string;
  mid: string;
  iat: number;
  exp: number | null;
};

export type LicenseReason =
  | 'unlicensed'
  | 'malformed'
  | 'bad_signature'
  | 'unknown_kid'
  | 'wrong_machine'
  | 'expired'
  | 'clock_rollback'
  | 'fingerprint_unavailable';

export type LicenseStatus = {
  state: 'valid' | 'invalid';
  reason: LicenseReason | null;
  machineCode: string;
  licensee: string | null;
  expiresAt: number | null;
  daysRemaining: number | null;
  issuedAt: number | null;
  kid: string | null;
};

export type StoredLicense = {
  schemaVersion: 1;
  ticket: string;
  componentHashes: string[];
  firstSeenAt: number;
  lastSeenAt: number;
};

export type IssueLicenseInput = {
  privateKeyPem: string;
  kid: string;
  subject: string;
  machineCode: string;
  now?: number;
  jti?: string;
  days?: number;
  perpetual?: boolean;
  expiresAt?: number | null;
};

export class LicenseRequiredError extends Error {
  readonly code = 'LICENSE_REQUIRED';
  readonly reason: LicenseReason;

  constructor(reason: LicenseReason = 'unlicensed') {
    super(licenseRequiredMessage(reason));
    this.name = 'LicenseRequiredError';
    this.reason = reason;
  }
}

export function isLicenseCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LICENSE_DISABLED_ENV] === '1';
}

export function isLicenseExemptEngineCommand(command: string): boolean {
  return command === 'seal_interrupted_session'
    || command === 'stop_session'
    || command === 'stop_attempt';
}

export function licenseRequiredMessage(reason: LicenseReason): string {
  switch (reason) {
    case 'expired': return 'LICENSE_REQUIRED:授权已过期';
    case 'wrong_machine': return 'LICENSE_REQUIRED:授权码与本机不匹配';
    case 'clock_rollback': return 'LICENSE_REQUIRED:系统时间异常';
    case 'fingerprint_unavailable': return 'LICENSE_REQUIRED:无法识别本机';
    case 'unknown_kid': return 'LICENSE_REQUIRED:授权码版本不受支持';
    case 'bad_signature':
    case 'malformed': return 'LICENSE_REQUIRED:授权码无效';
    default: return 'LICENSE_REQUIRED:软件未授权';
  }
}

export function disabledLicenseStatus(machineCode = ''): LicenseStatus {
  return {
    state: 'valid',
    reason: null,
    machineCode,
    licensee: 'development',
    expiresAt: null,
    daysRemaining: null,
    issuedAt: null,
    kid: 'disabled',
  };
}

export function emptyLicenseStatus(
  machineCode: string,
  reason: LicenseReason = 'unlicensed',
): LicenseStatus {
  return {
    state: 'invalid',
    reason,
    machineCode,
    licensee: null,
    expiresAt: null,
    daysRemaining: null,
    issuedAt: null,
    kid: null,
  };
}

export function issueLicense(input: IssueLicenseInput): string {
  const now = unixSeconds(input.now ?? Date.now());
  const mid = normalizeMachineCode(input.machineCode);
  const sub = normalizeSubject(input.subject);
  const kid = input.kid.trim();
  if (!kid) throw new Error('密钥编号无效');
  const exp = resolveExpiry(input, now);
  const claims: LicenseClaims = {
    v: 1,
    kid,
    jti: input.jti?.trim() || randomUUID(),
    sub,
    mid,
    iat: now,
    exp,
  };
  const payload = Buffer.from(canonicalClaimsJson(claims), 'utf8');
  const signature = signBytes(null, payload, createPrivateKey(input.privateKeyPem));
  return `${LICENSE_TICKET_PREFIX}.${encodeCrockford(payload)}.${encodeCrockford(signature)}`;
}

export function inspectLicenseTicket(ticket: string): LicenseClaims {
  return decodeTicket(ticket).claims;
}

export function verifyLicenseTicket(
  ticket: string,
  options: {
    publicKeys?: Readonly<Record<string, string>>;
    now?: number;
    machineCode?: string;
    storedComponentHashes?: readonly string[];
    currentComponentHashes?: readonly string[];
    lastSeenAt?: number;
  } = {},
): { claims: LicenseClaims } | { reason: LicenseReason } {
  let decoded: { claims: LicenseClaims; payload: Buffer; signature: Buffer };
  try {
    decoded = decodeTicket(ticket);
  } catch {
    return { reason: 'malformed' };
  }

  const publicKeys = options.publicKeys ?? LICENSE_PUBLIC_KEYS;
  const pem = publicKeys[decoded.claims.kid];
  if (!pem) return { reason: 'unknown_kid' };

  let verified = false;
  try {
    verified = verifyBytes(null, decoded.payload, createPublicKey(pem), decoded.signature);
  } catch {
    return { reason: 'bad_signature' };
  }
  if (!verified) return { reason: 'bad_signature' };

  const now = unixSeconds(options.now ?? Date.now());
  if (options.lastSeenAt !== undefined && now + CLOCK_ROLLBACK_GRACE_SECONDS < options.lastSeenAt) {
    return { reason: 'clock_rollback' };
  }
  if (decoded.claims.exp !== null && now >= decoded.claims.exp) return { reason: 'expired' };

  if (options.machineCode) {
    const currentCode = isMachineCode(options.machineCode)
      ? options.machineCode
      : '';
    const midMatches = currentCode !== '' && decoded.claims.mid === currentCode;
    const drifted = Boolean(
      options.storedComponentHashes
      && options.currentComponentHashes
      && matchFingerprint(options.storedComponentHashes, options.currentComponentHashes),
    );
    if (!midMatches && !drifted) return { reason: 'wrong_machine' };
  }

  return { claims: decoded.claims };
}

export function statusFromVerification(
  machineCode: string,
  result: { claims: LicenseClaims } | { reason: LicenseReason },
  now = Date.now(),
): LicenseStatus {
  if ('reason' in result) {
    return emptyLicenseStatus(machineCode, result.reason);
  }
  const nowSec = unixSeconds(now);
  const expiresAt = result.claims.exp;
  return {
    state: 'valid',
    reason: null,
    machineCode,
    licensee: result.claims.sub,
    expiresAt,
    daysRemaining: expiresAt === null ? null : Math.max(0, Math.ceil((expiresAt - nowSec) / 86_400)),
    issuedAt: result.claims.iat,
    kid: result.claims.kid,
  };
}

export class LicenseRepository {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly options: {
      publicKeys?: Readonly<Record<string, string>>;
      now?: () => number;
      createToken?: () => string;
    } = {},
  ) {}

  async load(): Promise<{ license: StoredLicense | null; warning?: string }> {
    return this.runExclusive(() => this.read());
  }

  async evaluate(fingerprint: MachineFingerprint): Promise<LicenseStatus> {
    return this.runExclusive(async () => {
      if (!fingerprint.machineCode) {
        return emptyLicenseStatus('', 'fingerprint_unavailable');
      }
      const loaded = await this.read();
      if (!loaded.license) return emptyLicenseStatus(fingerprint.machineCode, 'unlicensed');
      const now = this.now();
      const verified = verifyLicenseTicket(loaded.license.ticket, {
        publicKeys: this.options.publicKeys,
        now,
        machineCode: fingerprint.machineCode,
        storedComponentHashes: loaded.license.componentHashes,
        currentComponentHashes: fingerprint.componentHashes,
        lastSeenAt: loaded.license.lastSeenAt,
      });
      if ('reason' in verified) {
        const status = statusFromVerification(fingerprint.machineCode, verified, now);
        if (verified.reason === 'expired' || verified.reason === 'clock_rollback') {
          try {
            const claims = inspectLicenseTicket(loaded.license.ticket);
            status.licensee = claims.sub;
            status.expiresAt = claims.exp;
            status.issuedAt = claims.iat;
            status.kid = claims.kid;
          } catch {
            // Keep the verification reason; claims are informational only.
          }
        }
        return status;
      }
      const nextSeen = unixSeconds(now);
      if (nextSeen >= loaded.license.lastSeenAt) {
        await this.write({
          ...loaded.license,
          lastSeenAt: nextSeen,
        });
      }
      return statusFromVerification(fingerprint.machineCode, verified, now);
    });
  }

  async activate(ticket: string, fingerprint: MachineFingerprint): Promise<LicenseStatus> {
    return this.runExclusive(async () => {
      if (!fingerprint.machineCode) {
        return emptyLicenseStatus('', 'fingerprint_unavailable');
      }
      const now = this.now();
      const verified = verifyLicenseTicket(ticket, {
        publicKeys: this.options.publicKeys,
        now,
        machineCode: fingerprint.machineCode,
        currentComponentHashes: fingerprint.componentHashes,
      });
      if ('reason' in verified) {
        return statusFromVerification(fingerprint.machineCode, verified, now);
      }
      if (verified.claims.mid !== fingerprint.machineCode) {
        return emptyLicenseStatus(fingerprint.machineCode, 'wrong_machine');
      }
      const nowSec = unixSeconds(now);
      await this.write({
        schemaVersion: 1,
        ticket: normalizeTicket(ticket),
        componentHashes: [...fingerprint.componentHashes],
        firstSeenAt: nowSec,
        lastSeenAt: nowSec,
      });
      return statusFromVerification(fingerprint.machineCode, verified, now);
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private token(): string {
    const raw = (this.options.createToken ?? randomUUID)().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
    return raw || `${this.now()}`;
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async read(): Promise<{ license: StoredLicense | null; warning?: string }> {
    let serialized: string;
    try {
      serialized = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { license: null };
      throw error;
    }
    try {
      return { license: validateStoredLicense(JSON.parse(serialized)) };
    } catch (error) {
      const backupPath = `${this.filePath}.corrupt-${this.now()}-${this.token()}`;
      try {
        await fs.rename(this.filePath, backupPath);
      } catch (backupError) {
        throw new Error(
          `授权记录已损坏，且无法创建安全备份：${errorMessage(backupError)}`,
          { cause: backupError },
        );
      }
      return {
        license: null,
        warning: `授权记录无法读取，已保留为 ${path.basename(backupPath)}：${errorMessage(error)}`,
      };
    }
  }

  private async write(license: StoredLicense): Promise<StoredLicense> {
    const validated = validateStoredLicense(license);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${this.token()}`;
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return validated;
  }
}

function decodeTicket(ticket: string): { claims: LicenseClaims; payload: Buffer; signature: Buffer } {
  const normalized = normalizeTicket(ticket);
  const parts = normalized.split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_TICKET_PREFIX) throw new Error('授权码格式无效');
  const payload = Buffer.from(decodeCrockford(parts[1]));
  const signature = Buffer.from(decodeCrockford(parts[2]));
  if (payload.length === 0 || signature.length !== 64) throw new Error('授权码格式无效');
  const claims = validateClaims(JSON.parse(payload.toString('utf8')));
  if (canonicalClaimsJson(claims) !== payload.toString('utf8')) throw new Error('授权码格式无效');
  return { claims, payload, signature };
}

function normalizeTicket(ticket: string): string {
  if (typeof ticket !== 'string') throw new Error('授权码无效');
  const compact = ticket.replace(/\s+/g, '').trim();
  if (!compact || compact.length > MAX_TICKET_LENGTH) throw new Error('授权码无效');
  return compact;
}

function validateClaims(value: unknown): LicenseClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('授权码载荷无效');
  const claims = value as Record<string, unknown>;
  if (claims.v !== 1) throw new Error('授权码版本无效');
  if (typeof claims.kid !== 'string' || !claims.kid.trim()) throw new Error('密钥编号无效');
  if (typeof claims.jti !== 'string' || !claims.jti.trim()) throw new Error('授权编号无效');
  if (typeof claims.sub !== 'string') throw new Error('授权主体无效');
  if (typeof claims.mid !== 'string' || !isMachineCode(claims.mid)) throw new Error('绑定机器码无效');
  if (!Number.isSafeInteger(claims.iat) || (claims.iat as number) <= 0) throw new Error('签发时间无效');
  if (claims.exp !== null && (!Number.isSafeInteger(claims.exp) || (claims.exp as number) <= 0)) {
    throw new Error('到期时间无效');
  }
  return {
    v: 1,
    kid: claims.kid.trim(),
    jti: claims.jti.trim(),
    sub: normalizeSubject(claims.sub),
    mid: claims.mid,
    iat: claims.iat as number,
    exp: claims.exp as number | null,
  };
}

function validateStoredLicense(value: unknown): StoredLicense {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('授权记录格式无效');
  const stored = value as Record<string, unknown>;
  if (stored.schemaVersion !== 1) throw new Error('授权记录版本无效');
  if (typeof stored.ticket !== 'string' || !stored.ticket.trim()) throw new Error('授权记录缺少授权码');
  if (!Array.isArray(stored.componentHashes)
    || stored.componentHashes.some((item) => typeof item !== 'string' || !/^[0-9a-f]{64}$/.test(item))) {
    throw new Error('授权记录机器分量无效');
  }
  if (!Number.isSafeInteger(stored.firstSeenAt) || !Number.isSafeInteger(stored.lastSeenAt)) {
    throw new Error('授权记录时间无效');
  }
  return {
    schemaVersion: 1,
    ticket: normalizeTicket(stored.ticket),
    componentHashes: [...stored.componentHashes],
    firstSeenAt: stored.firstSeenAt as number,
    lastSeenAt: stored.lastSeenAt as number,
  };
}

function resolveExpiry(input: IssueLicenseInput, now: number): number | null {
  if (input.perpetual || input.expiresAt === null) return null;
  if (typeof input.expiresAt === 'number') {
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) throw new Error('到期时间无效');
    return input.expiresAt;
  }
  const days = input.days ?? 365;
  if (!Number.isSafeInteger(days) || days < 1 || days > 365 * 30) throw new Error('授权天数无效');
  return now + days * 86_400;
}

function normalizeSubject(value: string): string {
  const subject = value.normalize('NFKC').trim();
  if (!subject || subject.length > MAX_SUBJECT_LENGTH) throw new Error('客户或工位名称无效');
  return subject;
}

function canonicalClaimsJson(claims: LicenseClaims): string {
  return JSON.stringify({
    v: claims.v,
    kid: claims.kid,
    jti: claims.jti,
    sub: claims.sub,
    mid: claims.mid,
    iat: claims.iat,
    exp: claims.exp,
  });
}

function unixSeconds(nowMs: number): number {
  return Math.floor(nowMs / 1_000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function decodeCrockford(input: string): Uint8Array {
  const normalized = input
    .toUpperCase()
    .replace(/-/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (!normalized || /[^0-9A-HJKMNP-TV-Z]/.test(normalized)) throw new Error('授权码编码无效');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    const index = CROCKFORD.indexOf(char);
    if (index < 0) throw new Error('授权码编码无效');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(bytes);
}
