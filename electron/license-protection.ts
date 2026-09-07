import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface LicenseProtection {
  seal(value: string, purpose: string): Promise<string>;
  open(value: string, purpose: string): Promise<string>;
}
export interface SystemSecretStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export async function writeProtectedFile(file: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(value, 'utf8');
    await handle.sync();
    await handle.close();
    await fs.rename(temporary, file);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

// OS-protected key plus authenticated encryption: OS encryption alone does not
// promise integrity on every platform. Purpose binding prevents record swapping.
export class SystemLicenseProtection implements LicenseProtection {
  constructor(private readonly keyFile: string, private readonly storage: SystemSecretStorage) {}

  private async key(create: boolean): Promise<Buffer> {
    if (!this.storage.isEncryptionAvailable()
      || (process.platform === 'linux' && this.storage.getSelectedStorageBackend?.() === 'basic_text')) {
      throw new Error('系统安全存储不可用，无法验证本地授权记录');
    }
    let encrypted: Buffer;
    try {
      encrypted = await fs.readFile(this.keyFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
      const generated = this.storage.encryptString(randomBytes(32).toString('base64'));
      await fs.mkdir(path.dirname(this.keyFile), { recursive: true });
      const handle = await fs.open(this.keyFile, 'wx', 0o600);
      try { await handle.writeFile(generated); await handle.sync(); } finally { await handle.close(); }
      encrypted = generated;
    }
    const key = Buffer.from(this.storage.decryptString(encrypted), 'base64');
    if (key.length !== 32) throw new Error('本地授权保护密钥无效');
    return key;
  }

  async seal(value: string, purpose: string): Promise<string> {
    const key = await this.key(true);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(purpose));
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }

  async open(value: string, purpose: string): Promise<string> {
    const key = await this.key(false);
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length < 28) throw new Error('本地授权记录无效');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  }
}
