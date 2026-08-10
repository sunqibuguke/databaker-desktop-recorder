import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type EngineMessage = {
  protocol_version: number;
  request_id?: string;
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
  event?: string;
  payload?: unknown;
};

export class EngineClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<string, PendingRequest>();
  private sequence = 0;

  constructor(private readonly executable: string) {
    super();
  }

  async start(): Promise<void> {
    if (this.child) return;
    const child = spawn(this.executable, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => this.handleLine(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.emit('log', chunk.trim()));
    child.once('error', (error) => this.handleExit(error));
    child.once('exit', (code, signal) => {
      this.handleExit(new Error(`录音引擎已退出（code=${code ?? '-'}, signal=${signal ?? '-'}）`));
    });
    await this.request('hello', {}, 8_000);
  }

  request(command: string, payload: unknown = {}, timeoutMs = 15_000): Promise<unknown> {
    if (!this.child || this.child.killed || !this.child.stdin.writable) {
      return Promise.reject(new Error('录音引擎未启动'));
    }
    const requestId = `${Date.now()}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`录音引擎响应超时：${command}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child?.stdin.write(`${JSON.stringify({
        protocol_version: 1,
        request_id: requestId,
        command,
        payload,
      })}\n`);
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      await this.request('shutdown', {}, 10_000);
    } catch {
      // The OS process is still closed below even if the graceful request failed.
    }
    child.stdin.end();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = undefined;
  }

  private handleLine(line: string): void {
    let message: EngineMessage;
    try {
      message = JSON.parse(line) as EngineMessage;
    } catch {
      this.emit('log', `无法解析录音引擎输出：${line}`);
      return;
    }
    if (message.event) {
      this.emit('event', message);
      return;
    }
    if (!message.request_id) return;
    const request = this.pending.get(message.request_id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(message.request_id);
    if (message.ok) {
      request.resolve(message.result);
    } else {
      request.reject(new Error(message.error?.message || message.error?.code || '录音引擎调用失败'));
    }
  }

  private handleExit(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.emit('offline', error.message);
  }
}
