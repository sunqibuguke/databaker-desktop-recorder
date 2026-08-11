import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type OutputRootPreference = {
  schemaVersion: 2;
  outputRoot: string;
  canonicalRoot: string;
  device: string;
  inode: string;
  birthtimeNs: string;
};

export type OutputRootPreferenceLoadResult = {
  preference: OutputRootPreference | null;
  warning?: string;
};

const MAX_OUTPUT_ROOT_LENGTH = 32_768;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateOutputRoot(value: unknown): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_OUTPUT_ROOT_LENGTH
    || value.includes('\0')
    || !path.isAbsolute(value)) {
    throw new Error('上次录制保存位置无效');
  }
  return path.resolve(value);
}

function validateUnsignedInteger(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`保存位置${label}身份无效`);
  }
  return value;
}

function validatePreference(value: unknown): OutputRootPreference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('保存位置偏好格式无效');
  }
  const preference = value as Record<string, unknown>;
  if (preference.schemaVersion !== 2) throw new Error('保存位置偏好版本无效');
  return {
    schemaVersion: 2,
    outputRoot: validateOutputRoot(preference.outputRoot),
    canonicalRoot: validateOutputRoot(preference.canonicalRoot),
    device: validateUnsignedInteger(preference.device, '卷'),
    inode: validateUnsignedInteger(preference.inode, '目录'),
    birthtimeNs: validateUnsignedInteger(preference.birthtimeNs, '创建时间'),
  };
}

/**
 * Remembers only the operator's most recently selected recording root. Audio
 * and session metadata remain the source of truth; this file is just a durable
 * pointer that makes an external or high-capacity recording volume discoverable
 * again after an application or machine restart.
 */
export class OutputRootPreferenceRepository {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly createToken: () => string = randomUUID,
    private readonly now: () => number = Date.now,
  ) {}

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private token(): string {
    const token = this.createToken().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
    return token || `${this.now()}`;
  }

  private async read(): Promise<OutputRootPreferenceLoadResult> {
    let serialized: string;
    try {
      serialized = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { preference: null };
      throw error;
    }
    try {
      return { preference: validatePreference(JSON.parse(serialized)) };
    } catch (error) {
      const backupPath = `${this.filePath}.corrupt-${this.now()}-${this.token()}`;
      try {
        await fs.rename(this.filePath, backupPath);
      } catch (backupError) {
        throw new Error(
          `保存位置偏好已损坏，且无法创建安全备份：${errorMessage(backupError)}`,
          { cause: backupError },
        );
      }
      return {
        preference: null,
        warning: `保存位置偏好无法读取，已保留为 ${path.basename(backupPath)}：${errorMessage(error)}`,
      };
    }
  }

  async load(): Promise<OutputRootPreferenceLoadResult> {
    return this.runExclusive(() => this.read());
  }

  async save(preference: OutputRootPreference): Promise<OutputRootPreference> {
    return this.runExclusive(async () => {
      const validated = validatePreference(preference);
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp-${process.pid}-${this.token()}`;
      let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
      try {
        handle = await fs.open(temporaryPath, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temporaryPath, this.filePath);
      } catch (error) {
        if (handle) await handle.close().catch(() => undefined);
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
      return validated;
    });
  }
}
