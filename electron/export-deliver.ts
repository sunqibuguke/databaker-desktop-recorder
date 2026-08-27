import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

export const EXPORT_DELIVER_BASENAMES = ['full-track.wav', 'cuts.zip', 'timestamps.json'] as const;
export const MAX_EXPORT_DELIVER_NAME_ATTEMPTS = 100;
export const EXPORT_DELIVERY_PROGRESS_CHANNEL = 'export:delivery-progress';

export type ExportDeliveryArtifact = 'full_track' | 'cuts_zip' | 'timestamps_json';

const ARTIFACT_FILES: Record<ExportDeliveryArtifact, { output: string; status: string }> = {
  full_track: { output: 'full-track.wav', status: 'status-full-track.json' },
  cuts_zip: { output: 'cuts.zip', status: 'status-cuts-zip.json' },
  timestamps_json: { output: 'timestamps.json', status: 'status-timestamps-json.json' },
};

const DELIVERY_RECEIPT_SCHEMA_VERSION = 1;
const RECEIPT_MAX_BYTES = 256 * 1024;
const COPY_BUFFER_BYTES = 1024 * 1024;

export const EXPORT_DELIVER_ERROR = {
  destMissing: 'EXPORT_DEST_MISSING',
  destNotDirectory: 'EXPORT_DEST_NOT_DIRECTORY',
  destNotAuthorized: 'EXPORT_DEST_NOT_AUTHORIZED',
  destReplaced: 'EXPORT_DEST_REPLACED',
  sourceNotInSession: 'EXPORT_SOURCE_NOT_IN_SESSION',
  sourceNotInExportDir: 'EXPORT_SOURCE_NOT_IN_EXPORT_DIR',
  sourceInvalid: 'EXPORT_SOURCE_INVALID',
  sourceReplaced: 'EXPORT_SOURCE_REPLACED',
  exportStale: 'EXPORT_GENERATION_STALE',
  copyResultInvalid: 'EXPORT_COPY_RESULT_INVALID',
  payloadInvalid: 'EXPORT_COPY_PAYLOAD_INVALID',
  requestDuplicate: 'EXPORT_DELIVERY_REQUEST_DUPLICATE',
  cancelled: 'EXPORT_DELIVERY_CANCELLED',
  receiptInvalid: 'EXPORT_DELIVERY_RECEIPT_INVALID',
  openPathDenied: 'EXPORT_OPEN_PATH_DENIED',
} as const;

export type ExportDeliverErrorCode = (typeof EXPORT_DELIVER_ERROR)[keyof typeof EXPORT_DELIVER_ERROR];

export type ExportDeliveryRequest = Readonly<{
  request_id: string;
  session_id: string;
  artifact: ExportDeliveryArtifact;
  export_id: string;
  destination_dir: string;
}>;

export type ExportDeliveryStage =
  | 'validating'
  | 'copying'
  | 'verifying'
  | 'publishing'
  | 'writing_receipt';

export type ExportDeliveryProgress = Readonly<{
  request_id: string;
  stage: ExportDeliveryStage;
  bytes_copied: number;
  total_bytes: number;
}>;

export type ExportDeliveryResult = Readonly<{
  request_id: string;
  session_id: string;
  artifact: ExportDeliveryArtifact;
  export_id: string;
  directory: string;
  file_path: string;
  file_name: string;
  size_bytes: number;
  sha256: string;
  copied: true;
  receipt_path: string;
  completed_at: string;
  verification: 'verified';
}>;

export type ExportDeliveryVerification = Readonly<{
  request_id: string;
  session_id: string;
  artifact: ExportDeliveryArtifact;
  export_id: string;
  directory: string;
  file_path: string;
  file_name: string;
  size_bytes: number;
  sha256: string;
  receipt_path: string;
  completed_at: string;
  verification: 'verified' | 'stale' | 'missing' | 'invalid';
  message?: string;
}>;

type FileIdentity = Readonly<{
  device: bigint;
  inode: bigint;
  size: bigint;
  modifiedNs: bigint;
  changedNs: bigint;
}>;

export type ExportDeliverySourceBinding = Readonly<{
  sessionDir: string;
  exportDir: string;
  sourceFile: string;
  statusFile: string;
  identity: FileIdentity;
  expectedSha256: string;
  validateCurrent?: () => Promise<void>;
}>;

export type ExportDeliveryDestinationBinding = Readonly<{
  canonicalPath: string;
  device: bigint;
  inode: bigint;
  birthtimeNs: bigint;
}>;

export type ExportDeliveryReceipt = Readonly<{
  schema_version: 1;
  request_id: string;
  session_id: string;
  artifact: ExportDeliveryArtifact;
  export_id: string;
  source_file: string;
  source_size_bytes: number;
  source_sha256: string;
  destination_dir: string;
  destination_device: string;
  destination_inode: string;
  destination_birthtime_ns: string;
  destination_file: string;
  completed_at: string;
}>;

export type ReliableExportDeliveryOptions = Readonly<{
  resolveSource: (request: ExportDeliveryRequest) => Promise<ExportDeliverySourceBinding>;
  resolveDestination: (request: ExportDeliveryRequest) => Promise<ExportDeliveryDestinationBinding>;
  resolveSessionDir?: (
    request: Pick<ExportDeliveryRequest, 'session_id' | 'artifact' | 'export_id'>,
  ) => Promise<string>;
  onProgress?: (progress: ExportDeliveryProgress) => void;
  now?: () => Date;
  /** Deterministic filesystem fault injection for local tests; never wired to IPC. */
  testHooks?: Readonly<{
    beforeChunkWrite?: (context: Readonly<{
      request: ExportDeliveryRequest;
      bytes_copied: number;
      chunk_bytes: number;
    }>) => void | Promise<void>;
    afterPublishBeforeReceipt?: (context: Readonly<{
      request: ExportDeliveryRequest;
      file_path: string;
    }>) => void | Promise<void>;
    beforePublish?: (context: Readonly<{
      request: ExportDeliveryRequest;
      file_path: string;
    }>) => void | Promise<void>;
    forceCopyPublishFallback?: boolean;
  }>;
}>;

type ActiveDelivery = {
  controller: AbortController;
  committing: boolean;
};

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => path.normalize(path.resolve(value)).replace(/[\\/]+$/, '');
  const leftPath = normalize(left);
  const rightPath = normalize(right);
  return process.platform === 'win32'
    ? leftPath.toLocaleLowerCase('en-US') === rightPath.toLocaleLowerCase('en-US')
    : leftPath === rightPath;
}

function inside(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isNonEmptyIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim() === value
    && value.length > 0
    && value.length <= 512
    && !/[\u0000-\u001f]/.test(value);
}

export function isExportDeliveryRequest(value: unknown): value is ExportDeliveryRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return isNonEmptyIdentifier(request.request_id)
    && isNonEmptyIdentifier(request.session_id)
    && isNonEmptyIdentifier(request.export_id)
    && typeof request.destination_dir === 'string'
    && request.destination_dir.trim().length > 0
    && request.destination_dir.length <= 32_768
    && (request.artifact === 'full_track'
      || request.artifact === 'cuts_zip'
      || request.artifact === 'timestamps_json');
}

function exportStatusMatchesRequest(status: unknown, request: ExportDeliveryRequest): boolean {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return false;
  const value = status as Record<string, unknown>;
  return value.schema_version === 2
    && value.status === 'complete'
    && value.session_id === request.session_id
    && value.artifact === request.artifact
    && value.export_id === request.export_id
    && typeof value.sha256 === 'string'
    && /^[a-f0-9]{64}$/i.test(value.sha256);
}

async function readCurrentExportStatus(
  statusFile: string,
  request: ExportDeliveryRequest,
): Promise<Record<string, unknown>> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    const entry = await fs.lstat(statusFile, { bigint: true });
    const canonical = await fs.realpath(statusFile);
    if (!entry.isFile() || entry.isSymbolicLink() || !samePath(canonical, statusFile)) {
      throw new Error(EXPORT_DELIVER_ERROR.exportStale);
    }
    handle = await fs.open(statusFile, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile()
      || metadata.dev !== entry.dev
      || metadata.ino !== entry.ino
      || metadata.size !== entry.size
      || metadata.mtimeNs !== entry.mtimeNs
      || metadata.ctimeNs !== entry.ctimeNs
      || metadata.size > BigInt(RECEIPT_MAX_BYTES)) {
      throw new Error(EXPORT_DELIVER_ERROR.exportStale);
    }
    const source = await handle.readFile({ encoding: 'utf8' });
    const after = await handle.stat({ bigint: true });
    if (after.size !== metadata.size
      || after.mtimeNs !== metadata.mtimeNs
      || after.ctimeNs !== metadata.ctimeNs) {
      throw new Error(EXPORT_DELIVER_ERROR.exportStale);
    }
    const status = JSON.parse(source) as unknown;
    if (!exportStatusMatchesRequest(status, request)) {
      throw new Error(EXPORT_DELIVER_ERROR.exportStale);
    }
    return status as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === EXPORT_DELIVER_ERROR.exportStale) throw error;
    throw new Error(EXPORT_DELIVER_ERROR.exportStale, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function fileIdentity(filePath: string): Promise<FileIdentity> {
  const metadata = await fs.lstat(filePath, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(EXPORT_DELIVER_ERROR.sourceInvalid);
  }
  return {
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    modifiedNs: metadata.mtimeNs,
    changedNs: metadata.ctimeNs,
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.modifiedNs === right.modifiedNs
    && left.changedNs === right.changedNs;
}

export async function bindExportDeliverySource(
  sessionDir: string,
  request: ExportDeliveryRequest,
  validateCurrent?: () => Promise<void>,
): Promise<ExportDeliverySourceBinding> {
  const canonicalSessionDir = await fs.realpath(path.resolve(sessionDir));
  const exportDir = path.join(canonicalSessionDir, 'export');
  const canonicalExportDir = await fs.realpath(exportDir);
  if (!samePath(exportDir, canonicalExportDir) || !inside(canonicalSessionDir, canonicalExportDir)) {
    throw new Error(EXPORT_DELIVER_ERROR.sourceNotInExportDir);
  }
  const descriptor = ARTIFACT_FILES[request.artifact];
  const sourceFile = path.join(canonicalExportDir, descriptor.output);
  const statusFile = path.join(canonicalExportDir, descriptor.status);
  const status = await readCurrentExportStatus(statusFile, request);
  await validateCurrent?.();
  const canonicalSource = await fs.realpath(sourceFile);
  if (!samePath(canonicalSource, sourceFile) || !inside(canonicalExportDir, canonicalSource)) {
    throw new Error(EXPORT_DELIVER_ERROR.sourceNotInExportDir);
  }
  const identity = await fileIdentity(canonicalSource);
  const expectedSha256 = String(status.sha256).toLocaleLowerCase('en-US');
  if (await hashFile(canonicalSource) !== expectedSha256
    || !sameFileIdentity(identity, await fileIdentity(canonicalSource))) {
    throw new Error(EXPORT_DELIVER_ERROR.sourceInvalid);
  }
  const currentStatus = await readCurrentExportStatus(statusFile, request);
  if (String(currentStatus.sha256).toLocaleLowerCase('en-US') !== expectedSha256) {
    throw new Error(EXPORT_DELIVER_ERROR.exportStale);
  }
  await validateCurrent?.();
  return {
    sessionDir: canonicalSessionDir,
    exportDir: canonicalExportDir,
    sourceFile: canonicalSource,
    statusFile,
    identity,
    expectedSha256,
    validateCurrent,
  };
}

export async function assertExportDeliverySourceUnchanged(
  binding: ExportDeliverySourceBinding,
  request: ExportDeliveryRequest,
): Promise<void> {
  const status = await readCurrentExportStatus(binding.statusFile, request);
  if (typeof status.sha256 !== 'string'
    || status.sha256.toLocaleLowerCase('en-US') !== binding.expectedSha256) {
    throw new Error(EXPORT_DELIVER_ERROR.exportStale);
  }
  await binding.validateCurrent?.();
  let canonicalSource: string;
  try {
    canonicalSource = await fs.realpath(binding.sourceFile);
  } catch (error) {
    throw new Error(EXPORT_DELIVER_ERROR.sourceReplaced, { cause: error });
  }
  if (!samePath(canonicalSource, binding.sourceFile)
    || !sameFileIdentity(binding.identity, await fileIdentity(binding.sourceFile))) {
    throw new Error(EXPORT_DELIVER_ERROR.sourceReplaced);
  }
}

export async function bindExportDeliveryDestination(
  destinationDir: string,
): Promise<ExportDeliveryDestinationBinding> {
  let canonicalPath: string;
  try {
    canonicalPath = await fs.realpath(path.resolve(destinationDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(EXPORT_DELIVER_ERROR.destMissing);
    }
    throw error;
  }
  const metadata = await fs.lstat(canonicalPath, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(EXPORT_DELIVER_ERROR.destNotDirectory);
  }
  return {
    canonicalPath,
    device: metadata.dev,
    inode: metadata.ino,
    birthtimeNs: metadata.birthtimeNs,
  };
}

export async function assertExportDeliveryDestinationUnchanged(
  binding: ExportDeliveryDestinationBinding,
): Promise<void> {
  let current: ExportDeliveryDestinationBinding;
  try {
    current = await bindExportDeliveryDestination(binding.canonicalPath);
  } catch (error) {
    throw new Error(EXPORT_DELIVER_ERROR.destReplaced, { cause: error });
  }
  if (!samePath(current.canonicalPath, binding.canonicalPath)
    || (binding.device !== 0n && current.device !== 0n && binding.device !== current.device)
    || (binding.inode !== 0n && current.inode !== 0n && binding.inode !== current.inode)
    || (binding.birthtimeNs !== 0n
      && current.birthtimeNs !== 0n
      && binding.birthtimeNs !== current.birthtimeNs)) {
    throw new Error(EXPORT_DELIVER_ERROR.destReplaced);
  }
}

export function isAllowedExportArtifactName(name: string): boolean {
  return (EXPORT_DELIVER_BASENAMES as readonly string[]).includes(path.basename(name));
}

export function formatExportDeliverStamp(now: Date = new Date()): string {
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('');
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join('');
  return `${date}-${time}`;
}

export function exportSessionNameFromSource(sourceFile: string): string {
  const raw = path.basename(path.dirname(path.dirname(path.resolve(sourceFile))));
  const cleaned = raw.trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/[. ]+$/g, '');
  if (!cleaned) return 'recording';
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
}

export function deliveredExportBasename(
  sourceFile: string,
  stamp: string,
  collision = 0,
): string {
  const artifact = path.basename(sourceFile);
  const ext = path.extname(artifact);
  const stem = ext ? artifact.slice(0, -ext.length) : artifact;
  const session = exportSessionNameFromSource(sourceFile);
  const extra = collision > 0 ? `-${collision + 1}` : '';
  return `${session}-${stem}-${stamp}${extra}${ext}`;
}

export function deliveredExportFilePath(
  destinationDir: string,
  sourceFile: string,
  stamp: string = formatExportDeliverStamp(),
  collision = 0,
): string {
  return path.join(path.resolve(destinationDir), deliveredExportBasename(sourceFile, stamp, collision));
}

export function exportPathsAreSameDirectory(left: string, right: string): boolean {
  return samePath(left, right);
}

function safeReceiptComponent(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return cleaned || createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function isAbsoluteReceiptPath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 32_768
    && !/[\u0000-\u001f]/.test(value)
    && path.isAbsolute(value);
}

function isUnsignedIntegerString(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
}

function isValidReceiptTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 64) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function abortIfRequested(signal: AbortSignal): void {
  if (signal.aborted) throw new Error(EXPORT_DELIVER_ERROR.cancelled);
}

async function hashFile(filePath: string, signal?: AbortSignal): Promise<string> {
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  try {
    let position = 0;
    while (true) {
      if (signal) abortIfRequested(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    // Windows and some removable filesystems cannot fsync a directory handle.
    // The file itself is always synced; the UI must not promise sudden power-loss durability.
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(code ?? '')) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.partial`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fs.link(temporary, filePath);
    } catch (error) {
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )) throw error;
      // FAT/exFAT may not support hard links. COPYFILE_EXCL keeps receipt IDs
      // immutable; a torn fallback copy remains invalid and is never accepted
      // as a successful delivery after restart.
      await fs.copyFile(temporary, filePath, fsConstants.COPYFILE_EXCL);
      const published = await fs.open(filePath, 'r');
      try {
        await published.sync();
      } finally {
        await published.close();
      }
    }
    await fs.unlink(temporary);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function ensureReceiptDirectory(sessionDir: string): Promise<string> {
  const exportDir = path.join(sessionDir, 'export');
  const receiptsDir = path.join(exportDir, 'delivery-receipts');
  await fs.mkdir(receiptsDir, { recursive: true });
  const exportCanonical = await fs.realpath(exportDir);
  const canonical = await fs.realpath(receiptsDir);
  const metadata = await fs.lstat(canonical);
  if (!metadata.isDirectory()
    || metadata.isSymbolicLink()
    || !samePath(canonical, receiptsDir)
    || !inside(exportCanonical, canonical)) {
    throw new Error(EXPORT_DELIVER_ERROR.receiptInvalid);
  }
  return canonical;
}

function receiptPathFor(
  receiptsDir: string,
  request: ExportDeliveryRequest,
): string {
  return path.join(
    receiptsDir,
    `${request.artifact}-${safeReceiptComponent(request.export_id)}-${safeReceiptComponent(request.request_id)}.json`,
  );
}

async function readReceipt(filePath: string): Promise<ExportDeliveryReceipt | null> {
  try {
    const metadata = await fs.lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > RECEIPT_MAX_BYTES) return null;
    const canonical = await fs.realpath(filePath);
    if (!samePath(canonical, filePath)) return null;
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (value.schema_version !== DELIVERY_RECEIPT_SCHEMA_VERSION
      || !isNonEmptyIdentifier(value.request_id)
      || !isNonEmptyIdentifier(value.session_id)
      || !isNonEmptyIdentifier(value.export_id)
      || typeof value.source_sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.source_sha256)
      || !isAbsoluteReceiptPath(value.source_file)
      || !isAbsoluteReceiptPath(value.destination_dir)
      || !isAbsoluteReceiptPath(value.destination_file)
      || !isUnsignedIntegerString(value.destination_device)
      || !isUnsignedIntegerString(value.destination_inode)
      || !isUnsignedIntegerString(value.destination_birthtime_ns)
      || !isValidReceiptTimestamp(value.completed_at)
      || typeof value.source_size_bytes !== 'number'
      || !Number.isSafeInteger(value.source_size_bytes)
      || value.source_size_bytes < 0
      || !['full_track', 'cuts_zip', 'timestamps_json'].includes(String(value.artifact))) return null;
    return parsed as ExportDeliveryReceipt;
  } catch {
    return null;
  }
}

function verificationFromReceipt(
  receipt: ExportDeliveryReceipt,
  receiptPath: string,
  verification: ExportDeliveryVerification['verification'],
  message?: string,
): ExportDeliveryVerification {
  return {
    request_id: receipt.request_id,
    session_id: receipt.session_id,
    artifact: receipt.artifact,
    export_id: receipt.export_id,
    directory: receipt.destination_dir,
    file_path: receipt.destination_file,
    file_name: path.basename(receipt.destination_file),
    size_bytes: receipt.source_size_bytes,
    sha256: receipt.source_sha256,
    receipt_path: receiptPath,
    completed_at: receipt.completed_at,
    verification,
    ...(message ? { message } : {}),
  };
}

export class ReliableExportDeliveryManager {
  readonly #active = new Map<string, ActiveDelivery>();
  readonly #options: ReliableExportDeliveryOptions;

  constructor(options: ReliableExportDeliveryOptions) {
    this.#options = options;
  }

  cancel(requestId: string): boolean {
    const active = this.#active.get(requestId);
    if (!active || active.committing) return false;
    active.controller.abort();
    return true;
  }

  #progress(
    request: ExportDeliveryRequest,
    stage: ExportDeliveryStage,
    bytesCopied: number,
    totalBytes: number,
  ): void {
    try {
      this.#options.onProgress?.({
        request_id: request.request_id,
        stage,
        bytes_copied: bytesCopied,
        total_bytes: totalBytes,
      });
    } catch {
      // A renderer reload or listener bug must not turn a correct filesystem
      // operation into an ambiguous delivery outcome.
    }
  }

  async deliver(request: ExportDeliveryRequest): Promise<ExportDeliveryResult> {
    if (!isExportDeliveryRequest(request)) throw new Error(EXPORT_DELIVER_ERROR.payloadInvalid);
    if (this.#active.has(request.request_id)) throw new Error(EXPORT_DELIVER_ERROR.requestDuplicate);
    const active: ActiveDelivery = { controller: new AbortController(), committing: false };
    this.#active.set(request.request_id, active);
    let partialFile = '';
    let finalFile = '';
    let published = false;
    try {
      this.#progress(request, 'validating', 0, 0);
      const source = await this.#options.resolveSource(request);
      const destination = await this.#options.resolveDestination(request);
      await assertExportDeliverySourceUnchanged(source, request);
      await assertExportDeliveryDestinationUnchanged(destination);
      abortIfRequested(active.controller.signal);
      if (exportPathsAreSameDirectory(source.exportDir, destination.canonicalPath)) {
        throw new Error(EXPORT_DELIVER_ERROR.destNotAuthorized);
      }
      const receiptsDir = await ensureReceiptDirectory(source.sessionDir);
      const receiptPath = receiptPathFor(receiptsDir, request);
      try {
        await fs.lstat(receiptPath);
        throw new Error(EXPORT_DELIVER_ERROR.requestDuplicate);
      } catch (error) {
        if (error instanceof Error && error.message === EXPORT_DELIVER_ERROR.requestDuplicate) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const totalBytes = Number(source.identity.size);
      if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
        throw new Error(EXPORT_DELIVER_ERROR.sourceInvalid);
      }
      const requestSuffix = createHash('sha256')
        .update(request.request_id)
        .digest('hex')
        .slice(0, 8);
      const stamp = `${formatExportDeliverStamp(this.#options.now?.() ?? new Date())}-${requestSuffix}`;
      partialFile = path.join(
        destination.canonicalPath,
        `.${path.basename(source.sourceFile)}.${safeReceiptComponent(request.request_id)}.${randomUUID()}.partial`,
      );
      const sourceHandle = await fs.open(
        source.sourceFile,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      const destinationHandle = await fs.open(partialFile, 'wx', 0o600);
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
      let copied = 0;
      try {
        while (true) {
          abortIfRequested(active.controller.signal);
          const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.byteLength, copied);
          if (bytesRead === 0) break;
          let written = 0;
          while (written < bytesRead) {
            abortIfRequested(active.controller.signal);
            await this.#options.testHooks?.beforeChunkWrite?.({
              request,
              bytes_copied: copied + written,
              chunk_bytes: bytesRead - written,
            });
            const result = await destinationHandle.write(
              buffer,
              written,
              bytesRead - written,
              copied + written,
            );
            if (result.bytesWritten <= 0) throw new Error(EXPORT_DELIVER_ERROR.copyResultInvalid);
            written += result.bytesWritten;
          }
          hash.update(buffer.subarray(0, bytesRead));
          copied += bytesRead;
          this.#progress(request, 'copying', copied, totalBytes);
        }
        if (copied !== totalBytes) throw new Error(EXPORT_DELIVER_ERROR.sourceReplaced);
        await destinationHandle.truncate(totalBytes);
        await destinationHandle.sync();
        const sourceAfter = await sourceHandle.stat({ bigint: true });
        const handleIdentity: FileIdentity = {
          device: sourceAfter.dev,
          inode: sourceAfter.ino,
          size: sourceAfter.size,
          modifiedNs: sourceAfter.mtimeNs,
          changedNs: sourceAfter.ctimeNs,
        };
        if (!sameFileIdentity(source.identity, handleIdentity)) {
          throw new Error(EXPORT_DELIVER_ERROR.sourceReplaced);
        }
      } finally {
        await Promise.allSettled([sourceHandle.close(), destinationHandle.close()]);
      }
      const sourceHash = hash.digest('hex');
      if (sourceHash !== source.expectedSha256) {
        throw new Error(EXPORT_DELIVER_ERROR.sourceInvalid);
      }
      this.#progress(request, 'verifying', totalBytes, totalBytes);
      await assertExportDeliverySourceUnchanged(source, request);
      await assertExportDeliveryDestinationUnchanged(destination);
      const destinationHash = await hashFile(partialFile, active.controller.signal);
      if (sourceHash !== destinationHash) throw new Error(EXPORT_DELIVER_ERROR.copyResultInvalid);
      abortIfRequested(active.controller.signal);

      active.committing = true;
      this.#progress(request, 'publishing', totalBytes, totalBytes);
      for (let collision = 0; collision < MAX_EXPORT_DELIVER_NAME_ATTEMPTS; collision += 1) {
        const candidate = deliveredExportFilePath(
          destination.canonicalPath,
          source.sourceFile,
          stamp,
          collision,
        );
        await this.#options.testHooks?.beforePublish?.({ request, file_path: candidate });
        // Revalidate after the final pre-publication boundary. On Windows a
        // directory containing an open partial file cannot always be renamed,
        // so replacement tests and real media changes are checked after the
        // copy handles have closed and immediately before publication.
        await assertExportDeliveryDestinationUnchanged(destination);
        let usedCopyFallback = this.#options.testHooks?.forceCopyPublishFallback === true;
        if (!usedCopyFallback) {
          try {
            // link() is the preferred no-replace atomic publication: EEXIST
            // means another writer owns this name and must never be overwritten.
            await fs.link(partialFile, candidate);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code ?? '';
            if (code === 'EEXIST') continue;
            if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(code)) throw error;
            usedCopyFallback = true;
          }
        }
        if (usedCopyFallback) {
          try {
            // FAT/exFAT and some Windows destinations do not support hard
            // links. COPYFILE_EXCL preserves the no-overwrite guarantee. It
            // may leave an unreceipted forensic orphan after sudden process or
            // power loss, but it can never replace a competing user file.
            await fs.copyFile(partialFile, candidate, fsConstants.COPYFILE_EXCL);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
            throw error;
          }
          finalFile = candidate;
          published = true;
          const fallbackHandle = await fs.open(candidate, 'r+');
          try {
            await fallbackHandle.sync();
          } finally {
            await fallbackHandle.close();
          }
        } else {
          finalFile = candidate;
          published = true;
        }
        await fs.unlink(partialFile);
        partialFile = '';
        break;
      }
      if (!published || !finalFile) throw new Error(EXPORT_DELIVER_ERROR.copyResultInvalid);
      await syncDirectory(destination.canonicalPath);
      await assertExportDeliverySourceUnchanged(source, request);
      await assertExportDeliveryDestinationUnchanged(destination);
      const finalMetadata = await fs.lstat(finalFile);
      if (!finalMetadata.isFile()
        || finalMetadata.isSymbolicLink()
        || finalMetadata.size !== totalBytes
        || await hashFile(finalFile) !== sourceHash) {
        throw new Error(EXPORT_DELIVER_ERROR.copyResultInvalid);
      }

      await this.#options.testHooks?.afterPublishBeforeReceipt?.({
        request,
        file_path: finalFile,
      });

      this.#progress(request, 'writing_receipt', totalBytes, totalBytes);
      await assertExportDeliverySourceUnchanged(source, request);
      const completedAt = (this.#options.now?.() ?? new Date()).toISOString();
      const receipt: ExportDeliveryReceipt = {
        schema_version: DELIVERY_RECEIPT_SCHEMA_VERSION,
        request_id: request.request_id,
        session_id: request.session_id,
        artifact: request.artifact,
        export_id: request.export_id,
        source_file: source.sourceFile,
        source_size_bytes: totalBytes,
        source_sha256: sourceHash,
        destination_dir: destination.canonicalPath,
        destination_device: destination.device.toString(),
        destination_inode: destination.inode.toString(),
        destination_birthtime_ns: destination.birthtimeNs.toString(),
        destination_file: finalFile,
        completed_at: completedAt,
      };
      await atomicJson(receiptPath, receipt);
      await assertExportDeliverySourceUnchanged(source, request);
      await assertExportDeliveryDestinationUnchanged(destination);
      const publishedMetadata = await fs.lstat(finalFile);
      if (!publishedMetadata.isFile()
        || publishedMetadata.isSymbolicLink()
        || publishedMetadata.size !== totalBytes
        || await hashFile(finalFile) !== sourceHash) {
        throw new Error(EXPORT_DELIVER_ERROR.copyResultInvalid);
      }
      return {
        request_id: request.request_id,
        session_id: request.session_id,
        artifact: request.artifact,
        export_id: request.export_id,
        directory: destination.canonicalPath,
        file_path: finalFile,
        file_name: path.basename(finalFile),
        size_bytes: totalBytes,
        sha256: sourceHash,
        copied: true,
        receipt_path: receiptPath,
        completed_at: completedAt,
        verification: 'verified',
      };
    } catch (error) {
      if (partialFile) await fs.unlink(partialFile).catch(() => undefined);
      // A published artifact without a receipt is intentionally not reported as
      // success. Keep it for forensic recovery; a later retry gets a new name.
      if (published) await syncDirectory(path.dirname(finalFile)).catch(() => undefined);
      throw error;
    } finally {
      this.#active.delete(request.request_id);
    }
  }

  async verify(
    request: Pick<ExportDeliveryRequest, 'session_id' | 'artifact' | 'export_id'>,
  ): Promise<ExportDeliveryVerification | null> {
    const syntheticRequest: ExportDeliveryRequest = {
      ...request,
      request_id: 'receipt-verification',
      destination_dir: '.',
    };
    if (!isExportDeliveryRequest(syntheticRequest)) {
      throw new Error(EXPORT_DELIVER_ERROR.payloadInvalid);
    }
    let sessionDir = '';
    let source: ExportDeliverySourceBinding | null = null;
    try {
      source = await this.#options.resolveSource(syntheticRequest);
      sessionDir = source.sessionDir;
      await assertExportDeliverySourceUnchanged(source, syntheticRequest);
    } catch {
      // Still return an existing receipt as stale so restart UX can distinguish
      // it from a task that was never delivered.
      sessionDir = await this.#options.resolveSessionDir?.(request).catch(() => '') ?? '';
    }
    if (!sessionDir) return null;
    const receiptsDir = path.join(sessionDir, 'export', 'delivery-receipts');
    let canonicalReceiptsDir: string;
    let names: string[];
    try {
      canonicalReceiptsDir = await fs.realpath(receiptsDir);
      const canonicalSessionDir = await fs.realpath(sessionDir);
      if (!inside(canonicalSessionDir, canonicalReceiptsDir)) return null;
      names = (await fs.readdir(canonicalReceiptsDir))
        .filter((name) => name.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, 1_000);
    } catch {
      return null;
    }
    const candidates: Array<{ receipt: ExportDeliveryReceipt; filePath: string }> = [];
    for (const name of names) {
      const filePath = path.join(canonicalReceiptsDir, name);
      const receipt = await readReceipt(filePath);
      if (receipt
        && receipt.session_id === request.session_id
        && receipt.artifact === request.artifact
        && receipt.export_id === request.export_id) {
        candidates.push({ receipt, filePath });
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((left, right) => left.receipt.completed_at.localeCompare(right.receipt.completed_at));
    const selected = candidates.at(-1)!;
    if (!source) {
      return verificationFromReceipt(selected.receipt, selected.filePath, 'stale', '导出产物已换代');
    }
    if (!samePath(selected.receipt.source_file, source.sourceFile)
      || selected.receipt.source_sha256 !== source.expectedSha256
      || BigInt(selected.receipt.source_size_bytes) !== source.identity.size) {
      return verificationFromReceipt(selected.receipt, selected.filePath, 'invalid', '交付回执与当前源产物不匹配');
    }
    try {
      await assertExportDeliverySourceUnchanged(source, syntheticRequest);
    } catch {
      return verificationFromReceipt(selected.receipt, selected.filePath, 'stale', '导出产物已换代');
    }
    let destination: ExportDeliveryDestinationBinding;
    try {
      destination = await bindExportDeliveryDestination(selected.receipt.destination_dir);
    } catch {
      return verificationFromReceipt(selected.receipt, selected.filePath, 'missing', '交付目录当前不可用');
    }
    if (destination.device.toString() !== selected.receipt.destination_device
      || destination.inode.toString() !== selected.receipt.destination_inode
      || destination.birthtimeNs.toString() !== selected.receipt.destination_birthtime_ns
      || !samePath(selected.receipt.destination_dir, destination.canonicalPath)
      || !samePath(path.dirname(selected.receipt.destination_file), destination.canonicalPath)) {
      return verificationFromReceipt(selected.receipt, selected.filePath, 'invalid', '交付目录身份已变化');
    }
    try {
      const metadata = await fs.lstat(selected.receipt.destination_file);
      const canonicalDestinationFile = await fs.realpath(selected.receipt.destination_file);
      const targetIdentityBefore = await fileIdentity(selected.receipt.destination_file);
      const targetHash = await hashFile(selected.receipt.destination_file);
      const sourceHash = await hashFile(source.sourceFile);
      const targetIdentityAfter = await fileIdentity(selected.receipt.destination_file);
      if (!metadata.isFile()
        || metadata.isSymbolicLink()
        || !samePath(canonicalDestinationFile, selected.receipt.destination_file)
        || !samePath(path.dirname(canonicalDestinationFile), destination.canonicalPath)
        || !sameFileIdentity(targetIdentityBefore, targetIdentityAfter)
        || metadata.size !== selected.receipt.source_size_bytes
        || targetHash !== selected.receipt.source_sha256
        || sourceHash !== selected.receipt.source_sha256) {
        return verificationFromReceipt(selected.receipt, selected.filePath, 'invalid', '交付文件校验失败');
      }
    } catch {
      return verificationFromReceipt(selected.receipt, selected.filePath, 'missing', '交付文件当前不可用');
    }
    try {
      await assertExportDeliverySourceUnchanged(source, syntheticRequest);
    } catch {
      return verificationFromReceipt(selected.receipt, selected.filePath, 'stale', '导出产物已换代');
    }
    try {
      await assertExportDeliveryDestinationUnchanged(destination);
    } catch {
      return verificationFromReceipt(selected.receipt, selected.filePath, 'invalid', '交付目录身份已变化');
    }
    return verificationFromReceipt(selected.receipt, selected.filePath, 'verified');
  }
}
