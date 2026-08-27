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
  EXPORT_DEST_NOT_AUTHORIZED: 'p1.deliveryError.destNotAuthorized',
  EXPORT_DEST_REPLACED: 'p1.deliveryError.destReplaced',
  EXPORT_SOURCE_REPLACED: 'p1.deliveryError.sourceReplaced',
  EXPORT_GENERATION_STALE: 'p1.deliveryError.generationStale',
  EXPORT_DELIVERY_REQUEST_DUPLICATE: 'p1.deliveryError.requestDuplicate',
  EXPORT_DELIVERY_CANCELLED: 'p1.deliveryError.cancelled',
  EXPORT_DELIVERY_RECEIPT_INVALID: 'p1.deliveryError.receiptInvalid',
};

export function translateExportDeliverError(message: string): string {
  const trimmed = message.trim();
  const key = EXPORT_DELIVER_ERROR_KEYS[trimmed];
  return key ? t(key) : message;
}
