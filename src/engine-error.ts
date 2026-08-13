export type EngineErrorKind =
  | 'exclusive_open'
  | 'exclusive_busy'
  | 'exclusive_format'
  | 'exclusive_policy'
  | 'exclusive_empty'
  | 'activation'
  | 'generic';

export type ClassifiedEngineError = {
  kind: EngineErrorKind;
  message: string;
  canEditCaptureSettings: boolean;
};

const IPC_PREFIX = /^Error invoking remote method '[^']+':\s*/i;
const ERROR_NAME_PREFIX = /^(?:EngineRequestError|EngineRequestTimeoutError|Error):\s*/i;
const ACTIVATION_WRAPPER = /^activation stage \S+ failed;.*?(?:may be resumed|manual recovery|finish cleanup|commit session_activation_failed:[^:]*):\s*/is;

const USER_FACING_MARKERS = [
  '独占开流失败',
  '无法以独占模式',
  '该输入设备未枚举到独占格式',
  '独占模式：',
  '系统混音：',
  '声卡正被其他程序',
  '系统策略不允许',
  '该设备不支持所选',
  '独占开流缓冲',
  '所选设备在',
];

function rawErrorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error ?? '');
}

function stripIpcWrappers(text: string): string {
  let value = text.trim();
  value = value.replace(IPC_PREFIX, '');
  value = value.replace(ERROR_NAME_PREFIX, '');
  return value.trim();
}

export function userFacingEngineError(error: unknown): string {
  const stripped = stripIpcWrappers(rawErrorText(error));
  if (!stripped) return '录音引擎调用失败';
  for (const marker of USER_FACING_MARKERS) {
    const index = stripped.indexOf(marker);
    if (index >= 0) return stripped.slice(index).trim();
  }
  const peeled = stripped.replace(ACTIVATION_WRAPPER, '').trim();
  return peeled || stripped;
}

export function classifyEngineError(error: unknown): ClassifiedEngineError {
  const raw = `${rawErrorText(error)}\n${userFacingEngineError(error)}`;
  const message = userFacingEngineError(error);
  const exclusive = /独占|exclusive|0x8889/i.test(raw);
  if (/0x8889000[aA]|声卡正被其他程序独占使用|DEVICE_IN_USE/i.test(raw)) {
    return { kind: 'exclusive_busy', message, canEditCaptureSettings: true };
  }
  if (/0x8889000[eE]|系统策略不允许该设备使用独占|EXCLUSIVE_MODE_NOT_ALLOWED/i.test(raw)) {
    return { kind: 'exclusive_policy', message, canEditCaptureSettings: true };
  }
  if (/未枚举到独占格式|exclusive_empty/i.test(raw)) {
    return { kind: 'exclusive_empty', message, canEditCaptureSettings: true };
  }
  if (/0x88890008|不支持所选采样率|不支持采集格式|UNSUPPORTED_FORMAT|独占模式：所选设备/i.test(raw)) {
    return { kind: 'exclusive_format', message, canEditCaptureSettings: true };
  }
  if (/0x8889000[fF]|独占开流失败|无法以独占模式创建采集端点|ENDPOINT_CREATE_FAILED/i.test(raw)) {
    return { kind: 'exclusive_open', message, canEditCaptureSettings: true };
  }
  if (exclusive || /activation stage \S+ failed/i.test(raw)) {
    return { kind: exclusive ? 'exclusive_open' : 'activation', message, canEditCaptureSettings: true };
  }
  return { kind: 'generic', message, canEditCaptureSettings: false };
}
