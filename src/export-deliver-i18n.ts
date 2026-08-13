import { t } from '../shared/i18n/index.ts';

const EXPORT_DELIVER_ERROR_KEYS: Record<string, string> = {
  EXPORT_DEST_MISSING: 'exportDialog.destMissing',
  EXPORT_DEST_NOT_DIRECTORY: 'exportDialog.destNotDirectory',
  EXPORT_SOURCE_NOT_IN_SESSION: 'exportDialog.sourceNotInSession',
  EXPORT_SOURCE_NOT_IN_EXPORT_DIR: 'exportDialog.sourceNotInExportDir',
  EXPORT_SOURCE_INVALID: 'exportDialog.sourceInvalid',
  EXPORT_COPY_RESULT_INVALID: 'exportDialog.copyResultInvalid',
  EXPORT_COPY_PAYLOAD_INVALID: 'exportDialog.copyPayloadInvalid',
  EXPORT_OPEN_PATH_DENIED: 'exportDialog.openPathDenied',
};

export function translateExportDeliverError(message: string): string {
  const trimmed = message.trim();
  const key = EXPORT_DELIVER_ERROR_KEYS[trimmed];
  return key ? t(key) : message;
}
