import { createPrivateKey, createPublicKey, randomUUID, sign as signBytes, verify as verifyBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { writeProtectedFile, type LicenseProtection } from './license-protection';
import { LICENSE_PUBLIC_KEYS } from './license-keys';
import {
  isMachineCode,
  encodeMachineCode,
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
  | 'fingerprint_unavailable'
  | 'state_invalid';

export type LicenseStatus = {
  transitionRevision?: number;
  captureStopPending?: boolean;
  captureStopError?: string;
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

export function isLicenseCheckDisabled(env: NodeJS.ProcessEnv = process.env, isPackaged = true): boolean {
  return !isPackaged && env[LICENSE_DISABLED_ENV] === '1';
}

export function isLicenseExemptEngineCommand(command: string): boolean {
  return command === 'seal_interrupted_session'
    || command === 'stop_session'
    || command === 'stop_attempt'
    || command === 'cancel_input_audition';
}

export function licenseRequiredMessage(reason: LicenseReason): string {
  switch (reason) {
    case 'state_invalid': return 'LICENSE_REQUIRED:本地授权记录无法验证，请检查系统安全存储或恢复授权记录';
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
    trustedComponentHashes?: readonly string[];
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
  if (now + CLOCK_ROLLBACK_GRACE_SECONDS < Math.max(decoded.claims.iat, options.lastSeenAt ?? 0)) {
    return { reason: 'clock_rollback' };
  }
  if (decoded.claims.exp !== null && now >= decoded.claims.exp) return { reason: 'expired' };

  if (options.machineCode) {
    const currentCode = isMachineCode(options.machineCode)
      ? options.machineCode
      : '';
    const midMatches = currentCode !== '' && decoded.claims.mid === currentCode;
    const drifted = Boolean(
      options.trustedComponentHashes
      && encodeMachineCode(options.trustedComponentHashes) === decoded.claims.mid
      && options.currentComponentHashes
      && matchFingerprint(options.trustedComponentHashes, options.currentComponentHashes),
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
  constructor(private readonly filePath: string, private readonly options: {
    publicKeys?: Readonly<Record<string, string>>;
    now?: () => number;
    createToken?: () => string;
    protection?: LicenseProtection;
  } = {}) {}

  async load(): Promise<{ license: StoredLicense | null; warning?: string }> {
    return this.runExclusive(async () => ({ license: (await this.read()).license }));
  }

  private protection(): LicenseProtection {
    if (!this.options.protection) throw new Error('系统安全存储不可用');
    return this.options.protection;
  }

  async evaluate(fingerprint: MachineFingerprint): Promise<LicenseStatus> {
    return this.runExclusive(() => this.check(fingerprint));
  }

  async activate(ticket: string, fingerprint: MachineFingerprint): Promise<LicenseStatus> {
    return this.runExclusive(() => this.check(fingerprint, ticket));
  }

  private async check(fingerprint: MachineFingerprint, activation?: string): Promise<LicenseStatus> {
    if (!fingerprint.machineCode) return emptyLicenseStatus('', 'fingerprint_unavailable');
    const now = this.options.now?.() ?? Date.now();
    let loaded: Awaited<ReturnType<LicenseRepository['read']>>;
    let highWater: number;
    try {
      loaded = await this.read();
      highWater = Math.max(await this.readClock(), loaded.license?.lastSeenAt ?? 0);
    } catch {
      return emptyLicenseStatus(fingerprint.machineCode, 'state_invalid');
    }
    const ticket = activation ?? loaded.license?.ticket;
    if (!ticket) return emptyLicenseStatus(fingerprint.machineCode, 'unlicensed');
    const verified = verifyLicenseTicket(ticket, {
      publicKeys: this.options.publicKeys, now, machineCode: fingerprint.machineCode,
      // Legacy hashes are unsigned. Only an exact signed machine-code match
      // may migrate them, using freshly collected components.
      trustedComponentHashes: loaded.protected ? loaded.license?.componentHashes : undefined,
      currentComponentHashes: fingerprint.componentHashes, lastSeenAt: highWater,
    });
    if ('reason' in verified) {
      if (loaded.protected && unixSeconds(now) > highWater) {
        try { await this.writeClock(unixSeconds(now)); } catch { return emptyLicenseStatus(fingerprint.machineCode, 'state_invalid'); }
      }
      const status = statusFromVerification(fingerprint.machineCode, verified, now);
      if (verified.reason === 'expired' || verified.reason === 'clock_rollback') {
        const claims = inspectLicenseTicket(ticket);
        Object.assign(status, { licensee: claims.sub, expiresAt: claims.exp, issuedAt: claims.iat, kid: claims.kid });
      }
      return status;
    }
    const lastSeenAt = Math.max(highWater, unixSeconds(now));
    const components = verified.claims.mid === fingerprint.machineCode
      ? fingerprint.componentHashes : loaded.license!.componentHashes;
    const next: StoredLicense = {
      schemaVersion: 1, ticket: normalizeTicket(ticket), componentHashes: [...components],
      firstSeenAt: loaded.license?.firstSeenAt ?? unixSeconds(now), lastSeenAt,
    };
    try {
      // Persist the monotonic anchor first, including renewals. Replacing or
      // deleting license.json must not reset the last observed system time.
      if (lastSeenAt > highWater || !loaded.protected) await this.writeClock(lastSeenAt);
      if (activation !== undefined || !loaded.protected || loaded.license?.lastSeenAt !== lastSeenAt) await this.write(next);
    } catch {
      return emptyLicenseStatus(fingerprint.machineCode, 'state_invalid');
    }
    return statusFromVerification(fingerprint.machineCode, verified, now);
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async read(): Promise<{ license: StoredLicense | null; protected: boolean }> {
    let serialized: string;
    try { serialized = await fs.readFile(this.filePath, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { license: null, protected: false };
      throw error;
    }
    const raw = JSON.parse(serialized);
    if (raw?.schemaVersion === 2 && typeof raw.protectedData === 'string') {
      const license = validateStoredLicense(JSON.parse(await this.protection().open(raw.protectedData, 'license-v2')));
      return { license, protected: true };
    }
    // Once protected state exists, never accept a downgraded plaintext record.
    try { await fs.stat(`${this.filePath}.clock`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { license: validateStoredLicense(raw), protected: false };
      throw error;
    }
    throw new Error('本地授权记录被降级');
  }

  private async readClock(): Promise<number> {
    let value: string;
    try { value = await fs.readFile(`${this.filePath}.clock`, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // A protected record without its clock is incomplete, not a new install.
        const raw = await fs.readFile(this.filePath, 'utf8').catch((readError: NodeJS.ErrnoException) => {
          if (readError.code === 'ENOENT') return '{}';
          throw readError;
        });
        if (JSON.parse(raw)?.schemaVersion === 2) throw new Error('授权时间记录缺失');
        return 0;
      }
      throw error;
    }
    const clock = JSON.parse(await this.protection().open(value, 'license-clock-v1'));
    if (!Number.isSafeInteger(clock.lastSeenAt) || clock.lastSeenAt <= 0) throw new Error('授权时间记录无效');
    return clock.lastSeenAt;
  }

  private async writeClock(lastSeenAt: number): Promise<void> {
    await writeProtectedFile(`${this.filePath}.clock`, await this.protection().seal(JSON.stringify({ lastSeenAt }), 'license-clock-v1'));
  }

  private async write(license: StoredLicense): Promise<void> {
    const protectedData = await this.protection().seal(JSON.stringify(validateStoredLicense(license)), 'license-v2');
    await writeProtectedFile(this.filePath, JSON.stringify({ schemaVersion: 2, protectedData }));
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

/** Exclusive unix instant after the last valid UTC second of `YYYY-MM-DD`. */
export function parseExpiryDate(value: string): number {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) throw new Error('授权日期格式无效，请使用 YYYY-MM-DD');
  const startMs = Date.parse(`${trimmed}T00:00:00Z`);
  if (!Number.isFinite(startMs)) throw new Error('授权日期无效');
  if (new Date(startMs).toISOString().slice(0, 10) !== trimmed) throw new Error('授权日期无效');
  return startMs / 1_000 + 86_400;
}

/** Last valid UTC calendar day for an exclusive expiry instant. */
export function formatExpiryDate(exclusiveUnixSeconds: number): string {
  return new Date((exclusiveUnixSeconds - 1) * 1_000).toISOString().slice(0, 10);
}

function normalizeSubject(value: string): string {
  const subject = value.normalize('NFKC').trim();
  if (subject.length > MAX_SUBJECT_LENGTH) throw new Error('客户或工位名称无效');
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
