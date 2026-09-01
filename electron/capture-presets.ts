import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type CaptureShareMode = 'exclusive' | 'shared';

export type CapturePreset = {
  id: string;
  name: string;
  deviceId: string;
  deviceName: string;
  sampleRate: number;
  bitDepth: 8 | 16 | 24 | 32;
  inputSampleFormat: 'i16' | 'i24' | 'i32' | 'f32';
  inputChannel: number;
  captureShareMode: CaptureShareMode;
  silenceDurationMs: number;
  silenceThresholdDbfs: number;
};

export type CapturePresetDraft = Omit<CapturePreset, 'id'> & { id?: string };

export type CapturePresetStore = {
  schemaVersion: 1;
  lastSelectedPresetId: string | null;
  presets: CapturePreset[];
};

export type CapturePresetLoadResult = {
  store: CapturePresetStore;
  warning?: string;
};

const emptyStore = (): CapturePresetStore => ({
  schemaVersion: 1,
  lastSelectedPresetId: null,
  presets: [],
});

const MAX_PRESET_COUNT = 256;
const MAX_PRESET_ID_LENGTH = 128;
const MAX_DEVICE_ID_LENGTH = 8_192;
const MAX_DEVICE_NAME_LENGTH = 1_024;
const MAX_INPUT_CHANNEL = 65_535;

function normalizedNameKey(name: string): string {
  return name.normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function inferredInputSampleFormat(bitDepth: number, value: unknown): 'i16' | 'i24' | 'i32' | 'f32' {
  if (value === undefined || value === null || value === '') {
    if (bitDepth === 8) return 'i16';
    if (bitDepth === 16) return 'i16';
    if (bitDepth === 32) return 'f32';
    return 'i24';
  }
  if (value !== 'i16' && value !== 'i24' && value !== 'i32' && value !== 'f32') {
    throw new Error('预设采集格式无效');
  }
  return value;
}

function validatePreset(value: unknown): CapturePreset {
  if (!isPlainObject(value)) throw new Error('采集预设格式无效');
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const deviceId = typeof value.deviceId === 'string' ? value.deviceId.trim() : '';
  const deviceName = typeof value.deviceName === 'string' ? value.deviceName.trim() : '';
  if (!id || id.length > MAX_PRESET_ID_LENGTH) throw new Error('采集预设 ID 无效');
  if (!name || name.length > 40) throw new Error('预设名称应为 1–40 个字符');
  if (!deviceId || deviceId.length > MAX_DEVICE_ID_LENGTH) throw new Error('预设输入设备无效');
  if (!deviceName || deviceName.length > MAX_DEVICE_NAME_LENGTH) throw new Error('预设设备名称无效');
  if (!Number.isSafeInteger(value.sampleRate) || Number(value.sampleRate) < 8_000 || Number(value.sampleRate) > 384_000) {
    throw new Error('预设采样率无效');
  }
  if (value.bitDepth !== 8 && value.bitDepth !== 16 && value.bitDepth !== 24 && value.bitDepth !== 32) throw new Error('预设位深无效');
  const inputSampleFormat = inferredInputSampleFormat(Number(value.bitDepth), value.inputSampleFormat);
  if (!Number.isSafeInteger(value.inputChannel) || Number(value.inputChannel) < 1 || Number(value.inputChannel) > MAX_INPUT_CHANNEL) {
    throw new Error('预设输入通道无效');
  }
  if (!Number.isSafeInteger(value.silenceDurationMs) || Number(value.silenceDurationMs) < 200 || Number(value.silenceDurationMs) > 5_000) {
    throw new Error('预设静音时长无效');
  }
  if (typeof value.silenceThresholdDbfs !== 'number'
    || !Number.isFinite(value.silenceThresholdDbfs)
    || value.silenceThresholdDbfs < -96
    || value.silenceThresholdDbfs > -6) {
    throw new Error('预设静音阈值无效');
  }
  const captureShareMode = value.captureShareMode === undefined
    ? 'exclusive'
    : value.captureShareMode;
  if (captureShareMode !== 'exclusive' && captureShareMode !== 'shared') {
    throw new Error('预设采集模式无效');
  }
  return {
    id,
    name,
    deviceId,
    deviceName,
    sampleRate: Number(value.sampleRate),
    bitDepth: Number(value.bitDepth) as 8 | 16 | 24 | 32,
    inputSampleFormat,
    inputChannel: Number(value.inputChannel),
    captureShareMode,
    silenceDurationMs: Number(value.silenceDurationMs),
    silenceThresholdDbfs: value.silenceThresholdDbfs,
  };
}

function validateStore(value: unknown): CapturePresetStore {
  if (!isPlainObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.presets)) {
    throw new Error('采集预设文件版本无效');
  }
  if (value.presets.length > MAX_PRESET_COUNT) throw new Error(`采集预设不能超过 ${MAX_PRESET_COUNT} 个`);
  const presets = value.presets.map(validatePreset);
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const preset of presets) {
    const normalizedName = normalizedNameKey(preset.name);
    if (names.has(normalizedName)) throw new Error(`采集预设名称重复：${preset.name}`);
    if (ids.has(preset.id)) throw new Error('采集预设 ID 重复');
    names.add(normalizedName);
    ids.add(preset.id);
  }
  const selected = typeof value.lastSelectedPresetId === 'string'
    && ids.has(value.lastSelectedPresetId)
    ? value.lastSelectedPresetId
    : null;
  return { schemaVersion: 1, lastSelectedPresetId: selected, presets };
}

export class CapturePresetRepository {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => number = Date.now,
  ) {}

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private temporaryToken(): string {
    const token = this.createId().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_PRESET_ID_LENGTH);
    return token || `${this.now()}`;
  }

  private createUniquePresetId(store: CapturePresetStore): string {
    const existing = new Set(store.presets.map((preset) => preset.id));
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = this.createId().trim();
      if (id && id.length <= MAX_PRESET_ID_LENGTH && !existing.has(id)) return id;
    }
    throw new Error('无法生成唯一的采集预设 ID');
  }

  private async write(store: CapturePresetStore): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${this.temporaryToken()}`;
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async read(): Promise<CapturePresetLoadResult> {
    let serialized: string;
    try {
      serialized = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { store: emptyStore() };
      throw error;
    }
    try {
      return { store: validateStore(JSON.parse(serialized)) };
    } catch (error) {
      const backupPath = `${this.filePath}.corrupt-${this.now()}-${this.temporaryToken()}`;
      try {
        await fs.rename(this.filePath, backupPath);
      } catch (backupError) {
        throw new Error(
          `采集预设文件已损坏，且无法创建安全备份；原文件未修改。请检查目录权限或磁盘状态后重试：${errorMessage(backupError)}`,
          { cause: backupError },
        );
      }
      return {
        store: emptyStore(),
        warning: `采集预设文件无法读取，已保留为 ${path.basename(backupPath)}：${errorMessage(error)}`,
      };
    }
  }

  async load(): Promise<CapturePresetLoadResult> {
    return this.runExclusive(() => this.read());
  }

  async save(draft: CapturePresetDraft): Promise<CapturePresetStore> {
    return this.runExclusive(() => this.saveUnlocked(draft));
  }

  private async saveUnlocked(draft: CapturePresetDraft): Promise<CapturePresetStore> {
    if (!isPlainObject(draft)) throw new Error('采集预设格式无效');
    const current = (await this.read()).store;
    const draftId = typeof draft.id === 'string' ? draft.id.trim() : '';
    if (draftId && !current.presets.some((preset) => preset.id === draftId)) {
      throw new Error('要更新的采集预设不存在');
    }
    if (!draftId && current.presets.length >= MAX_PRESET_COUNT) {
      throw new Error(`采集预设不能超过 ${MAX_PRESET_COUNT} 个`);
    }
    const preset = validatePreset({
      ...draft,
      id: draftId || this.createUniquePresetId(current),
    });
    const duplicate = current.presets.find((candidate) => (
      candidate.id !== preset.id
      && normalizedNameKey(candidate.name) === normalizedNameKey(preset.name)
    ));
    if (duplicate) throw new Error(`已存在名为“${preset.name}”的采集预设`);
    const index = current.presets.findIndex((candidate) => candidate.id === preset.id);
    const presets = [...current.presets];
    if (index >= 0) presets[index] = preset;
    else presets.push(preset);
    const next: CapturePresetStore = { schemaVersion: 1, lastSelectedPresetId: preset.id, presets };
    await this.write(next);
    return next;
  }

  async delete(id: string): Promise<CapturePresetStore> {
    return this.runExclusive(() => this.deleteUnlocked(id));
  }

  private async deleteUnlocked(id: string): Promise<CapturePresetStore> {
    const current = (await this.read()).store;
    const presets = current.presets.filter((preset) => preset.id !== id);
    const next: CapturePresetStore = {
      schemaVersion: 1,
      lastSelectedPresetId: current.lastSelectedPresetId === id ? null : current.lastSelectedPresetId,
      presets,
    };
    await this.write(next);
    return next;
  }

  async select(id: string | null): Promise<CapturePresetStore> {
    return this.runExclusive(() => this.selectUnlocked(id));
  }

  private async selectUnlocked(id: string | null): Promise<CapturePresetStore> {
    const current = (await this.read()).store;
    if (id !== null && !current.presets.some((preset) => preset.id === id)) {
      throw new Error('所选采集预设不存在');
    }
    const next: CapturePresetStore = { ...current, lastSelectedPresetId: id };
    await this.write(next);
    return next;
  }
}
