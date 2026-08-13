export const EXCLUSIVE_PROBE_TARGET_RATE = 48_000;

export type ExclusiveProbeKind =
  | 'exclusive_probe_error'
  | 'exclusive_empty'
  | 'exclusive_missing_48k';

export type ExclusiveProbeIssue = {
  kind: ExclusiveProbeKind;
  deviceName: string;
  isDefault: boolean;
  exclusiveRates: number[];
  exclusiveChannels: number[];
  exclusiveFormats: string[];
  sharedRates: number[];
  sharedChannels: number[];
  probeError: string | null;
  supports48000Exclusive: boolean;
};

type DeviceLike = {
  name?: unknown;
  is_default?: unknown;
  exclusive_available?: unknown;
  exclusive_sample_rates?: unknown;
  exclusive_input_channels?: unknown;
  exclusive_formats?: unknown;
  exclusive_probe_error?: unknown;
  shared_sample_rates?: unknown;
  shared_input_channels?: unknown;
  configurations?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asFiniteNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function exclusiveConfigurations(device: DeviceLike): Array<Record<string, unknown>> {
  if (!Array.isArray(device.configurations)) return [];
  return device.configurations.filter((configuration): configuration is Record<string, unknown> => (
    isRecord(configuration) && configuration.share_mode === 'exclusive'
  ));
}

function exclusiveFormatsFromDevice(device: DeviceLike): string[] {
  const tagged = asStrings(device.exclusive_formats);
  if (tagged.length) return [...new Set(tagged)];
  const formats = exclusiveConfigurations(device)
    .map((configuration) => configuration.sample_format)
    .filter((format): format is string => typeof format === 'string' && format.trim() !== '');
  return [...new Set(formats)];
}

export function exclusiveSupportsRate(device: DeviceLike, rate: number): boolean {
  const rates = asFiniteNumbers(device.exclusive_sample_rates);
  if (rates.includes(rate)) return true;
  return exclusiveConfigurations(device).some((configuration) => {
    const minimum = configuration.min_sample_rate;
    const maximum = configuration.max_sample_rate;
    return typeof minimum === 'number'
      && typeof maximum === 'number'
      && rate >= minimum
      && rate <= maximum;
  });
}

export function collectExclusiveProbeIssues(inventory: unknown): ExclusiveProbeIssue[] {
  const devices = isRecord(inventory) && Array.isArray(inventory.devices)
    ? inventory.devices
    : Array.isArray(inventory)
      ? inventory
      : [];
  const issues: ExclusiveProbeIssue[] = [];
  for (const candidate of devices) {
    if (!isRecord(candidate)) continue;
    const device = candidate as DeviceLike;
    const name = typeof device.name === 'string' ? device.name.trim() : '';
    if (!name) continue;
    const probeError = typeof device.exclusive_probe_error === 'string' && device.exclusive_probe_error.trim()
      ? device.exclusive_probe_error.trim()
      : null;
    const exclusiveRates = asFiniteNumbers(device.exclusive_sample_rates);
    const supports48000Exclusive = exclusiveSupportsRate(device, EXCLUSIVE_PROBE_TARGET_RATE);
    const exclusiveAvailable = device.exclusive_available === true || exclusiveRates.length > 0;
    const kind: ExclusiveProbeKind | null = probeError
      ? 'exclusive_probe_error'
      : exclusiveAvailable
        ? (supports48000Exclusive ? null : 'exclusive_missing_48k')
        : 'exclusive_empty';
    if (!kind) continue;
    issues.push({
      kind,
      deviceName: name,
      isDefault: device.is_default === true,
      exclusiveRates,
      exclusiveChannels: asFiniteNumbers(device.exclusive_input_channels),
      exclusiveFormats: exclusiveFormatsFromDevice(device),
      sharedRates: asFiniteNumbers(device.shared_sample_rates),
      sharedChannels: asFiniteNumbers(device.shared_input_channels),
      probeError,
      supports48000Exclusive,
    });
  }
  return issues;
}

export function exclusiveProbeIssueKey(issue: ExclusiveProbeIssue): string {
  return [
    issue.kind,
    issue.deviceName,
    issue.exclusiveRates.join(','),
    issue.probeError ?? '',
  ].join('|');
}

export function exclusiveProbeIssueAttributes(
  issue: ExclusiveProbeIssue,
): Record<string, string | number | boolean> {
  return {
    kind: issue.kind,
    device_name: issue.deviceName,
    is_default: issue.isDefault,
    exclusive_rates: issue.exclusiveRates.join(',') || 'none',
    exclusive_channels: issue.exclusiveChannels.join(',') || 'none',
    exclusive_formats: issue.exclusiveFormats.join(',') || 'none',
    shared_rates: issue.sharedRates.join(',') || 'none',
    shared_channels: issue.sharedChannels.join(',') || 'none',
    probe_error: issue.probeError ?? '',
    supports_48000_exclusive: issue.supports48000Exclusive,
  };
}
