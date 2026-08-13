import path from 'node:path';

export const EXPORT_DELIVER_BASENAMES = ['full-track.wav', 'cuts.zip', 'timestamps.json'] as const;

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

export function deliveredExportFilePath(destinationDir: string, sourceFile: string): string {
  return path.join(path.resolve(destinationDir), path.basename(sourceFile));
}

export function exportPathsAreSameDirectory(left: string, right: string): boolean {
  const normalize = (value: string) => path.normalize(path.resolve(value)).replace(/[\\/]+$/, '');
  const leftDir = normalize(left);
  const rightDir = normalize(right);
  return process.platform === 'win32'
    ? leftDir.toLocaleLowerCase('en-US') === rightDir.toLocaleLowerCase('en-US')
    : leftDir === rightDir;
}
