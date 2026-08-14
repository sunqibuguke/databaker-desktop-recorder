import path from 'node:path';

export const EXPORT_DELIVER_BASENAMES = ['full-track.wav', 'cuts.zip', 'timestamps.json'] as const;
export const MAX_EXPORT_DELIVER_NAME_ATTEMPTS = 100;

export const EXPORT_DELIVER_ERROR = {
  destMissing: 'EXPORT_DEST_MISSING',
  destNotDirectory: 'EXPORT_DEST_NOT_DIRECTORY',
  sourceNotInSession: 'EXPORT_SOURCE_NOT_IN_SESSION',
  sourceNotInExportDir: 'EXPORT_SOURCE_NOT_IN_EXPORT_DIR',
  sourceInvalid: 'EXPORT_SOURCE_INVALID',
  copyResultInvalid: 'EXPORT_COPY_RESULT_INVALID',
  payloadInvalid: 'EXPORT_COPY_PAYLOAD_INVALID',
  openPathDenied: 'EXPORT_OPEN_PATH_DENIED',
} as const;

export type ExportDeliverErrorCode = (typeof EXPORT_DELIVER_ERROR)[keyof typeof EXPORT_DELIVER_ERROR];

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
  const normalize = (value: string) => path.normalize(path.resolve(value)).replace(/[\\/]+$/, '');
  const leftDir = normalize(left);
  const rightDir = normalize(right);
  return process.platform === 'win32'
    ? leftDir.toLocaleLowerCase('en-US') === rightDir.toLocaleLowerCase('en-US')
    : leftDir === rightDir;
}
