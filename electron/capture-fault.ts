export type CaptureFaultNotice = Readonly<{
  kind: string;
  title: string;
  reason: string;
}>;

export function captureFaultNoticeFromEngineEvent(message: unknown): CaptureFaultNotice | null {
  if (!message || typeof message !== 'object') return null;
  const candidate = message as { event?: unknown; payload?: unknown };
  if (candidate.event !== 'meter' || !candidate.payload || typeof candidate.payload !== 'object') {
    return null;
  }

  const payload = candidate.payload as {
    faulted?: unknown;
    fault_kind?: unknown;
    fault_reason?: unknown;
  };
  if (payload.faulted !== true) return null;

  const kind = typeof payload.fault_kind === 'string' && payload.fault_kind.trim()
    ? payload.fault_kind.trim()
    : 'unknown';
  const title = ({
    device_unavailable: '所选声卡已断开或不可用',
    device_stalled: '声卡已停止输送音频',
    input_discontinuity: '音频输入出现不连续',
    input_stream_error: '音频输入流故障',
  } as Record<string, string>)[kind] ?? '音频采集已触发数据保护';
  const reason = typeof payload.fault_reason === 'string' ? payload.fault_reason.trim() : '';
  return { kind, title, reason };
}
