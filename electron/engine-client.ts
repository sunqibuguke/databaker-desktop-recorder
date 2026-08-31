import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  command: string;
};

const GRACEFUL_STOP_TIMEOUT_MS = 90_000;
const SHUTDOWN_REQUEST_TIMEOUT_MS = 80_000;
const FORCED_EXIT_WAIT_MS = 10_000;

export type InputAuditionCommand =
  | 'begin_input_audition'
  | 'finish_input_audition'
  | 'confirm_input_audition'
  | 'skip_input_audition'
  | 'cancel_input_audition';

const INPUT_AUDITION_FINISH_TIMEOUT_MS = 60_000;
const INPUT_AUDITION_COMMAND_TIMEOUT_MS = 20_000;

type EngineClientOptions = Readonly<{
  args?: readonly string[];
  gracefulStopTimeoutMs?: number;
  shutdownRequestTimeoutMs?: number;
  forcedExitWaitMs?: number;
}>;

export type EngineStoppedOutcome = Readonly<{
  safe: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

type EngineMessage = {
  protocol_version: number;
  request_id?: string;
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
  event?: string;
  payload?: unknown;
};

export class EngineRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly command: string,
    readonly requestId: string,
  ) {
    super(message);
    this.name = 'EngineRequestError';
  }
}

export class EngineRequestTimeoutError extends Error {
  constructor(
    readonly command: string,
    readonly requestId: string,
    readonly timeoutMs: number,
  ) {
    super(`录音引擎响应超时：${command}`);
    this.name = 'EngineRequestTimeoutError';
  }
}

export class EngineSafeStopTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`录音引擎超过 ${Math.round(timeoutMs / 1_000)} 秒仍未完成安全封存`);
    this.name = 'EngineSafeStopTimeoutError';
  }
}

export class EngineUnsafeStopError extends Error {
  constructor(
    readonly outcome: EngineStoppedOutcome,
    readonly shutdownConfirmed: boolean,
    readonly shutdownError: unknown,
  ) {
    const shutdownDetail = shutdownConfirmed
      ? '引擎已确认封存，但进程未正常退出'
      : shutdownError instanceof Error
        ? shutdownError.message
        : shutdownError === null
          ? '引擎未返回安全停止确认'
          : String(shutdownError);
    const exitDetail = outcome.signal
      ? `signal=${outcome.signal}`
      : `code=${outcome.code ?? '-'}`;
    super(`录音引擎已退出，但安全封存未获确认（${exitDetail}）：${shutdownDetail}`);
    this.name = 'EngineUnsafeStopError';
  }
}

export class EngineClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<string, PendingRequest>();
  private sequence = 0;
  private childGeneration = 0;
  private stoppingChild: ChildProcessWithoutNullStreams | undefined;
  private stopPromise: Promise<void> | undefined;
  private readonly shutdownConfirmedChildren = new WeakSet<ChildProcessWithoutNullStreams>();
  private readonly stoppedOutcomes = new WeakMap<ChildProcessWithoutNullStreams, EngineStoppedOutcome>();

  constructor(
    private readonly executable: string,
    private readonly options: EngineClientOptions = {},
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.stopPromise) await this.stopPromise;
    if (this.child && this.child.exitCode === null && !this.child.killed) return;
    this.child = undefined;
    const child = spawn(this.executable, [...(this.options.args ?? [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const generation = ++this.childGeneration;
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => this.handleLine(child, generation, line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (this.child === child && this.childGeneration === generation) {
        this.emit('log', chunk.trim());
      }
    });
    child.stdin.on('error', (error) => {
      if (this.child === child && this.stoppingChild !== child) {
        this.emit('log', `录音引擎输入通道异常：${error.message}`);
      }
    });
    child.once('error', (error) => this.handleExit(
      child,
      error,
      child.exitCode,
      child.signalCode,
    ));
    child.once('exit', (code, signal) => {
      this.handleExit(
        child,
        new Error(`录音引擎已退出（code=${code ?? '-'}, signal=${signal ?? '-'}）`),
        code,
        signal,
      );
    });
    await this.request('hello', {}, 8_000);
  }

  get running(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  request(command: string, payload: unknown = {}, timeoutMs = 15_000): Promise<unknown> {
    const child = this.child;
    if (!child || child.killed || child.exitCode !== null || !child.stdin.writable) {
      return Promise.reject(new Error('录音引擎未启动'));
    }
    const requestId = `${Date.now()}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new EngineRequestTimeoutError(command, requestId, timeoutMs));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, command });
      const line = `${JSON.stringify({
        protocol_version: 1,
        request_id: requestId,
        command,
        payload,
      })}\n`;
      child.stdin.write(line, (error) => {
        if (!error) return;
        const request = this.pending.get(requestId);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(requestId);
        request.reject(new Error(`无法向录音引擎发送 ${command}：${error.message}`));
      });
    });
  }

  requestInputAudition(
    command: InputAuditionCommand,
    payload: unknown = {},
  ): Promise<unknown> {
    return this.request(
      command,
      payload,
      command === 'finish_input_audition'
        ? INPUT_AUDITION_FINISH_TIMEOUT_MS
        : INPUT_AUDITION_COMMAND_TIMEOUT_MS,
    );
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    if (!child) return Promise.resolve();
    this.stoppingChild = child;
    const operation = this.stopChild(child).finally(() => {
      // A safe-stop timeout deliberately leaves the child alive and keeps it
      // marked as stopping. If it exits later, handleExit emits a structured
      // outcome instead of treating the expected exit as a fresh engine crash.
      if (this.stoppingChild === child && this.hasExited(child)) {
        this.stoppingChild = undefined;
      }
      if (this.stopPromise === operation) this.stopPromise = undefined;
    });
    this.stopPromise = operation;
    return operation;
  }

  async forceStop(): Promise<void> {
    if (this.stopPromise) {
      try {
        await this.stopPromise;
        return;
      } catch {
        // The safe-stop deadline expired. A caller may proceed only after an
        // explicit user confirmation; this method is never called implicitly.
      }
    }
    const child = this.child;
    if (!child || this.hasExited(child)) return;
    this.stoppingChild = child;
    child.kill();
    const timeoutMs = this.options.forcedExitWaitMs ?? FORCED_EXIT_WAIT_MS;
    if (!(await this.waitForExit(child, timeoutMs))) {
      throw new Error('录音引擎强制结束后仍未退出');
    }
  }

  private handleLine(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    line: string,
  ): void {
    if (this.child !== child || this.childGeneration !== generation) return;
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
    if (message.ok === true) {
      if (request.command === 'shutdown' && this.stoppingChild === child) {
        // Mark the acknowledgement before resolving the request promise. The
        // process can exit immediately after writing this protocol response.
        this.shutdownConfirmedChildren.add(child);
      }
      request.resolve(message.result);
    } else {
      request.reject(new EngineRequestError(
        message.error?.message || message.error?.code || '录音引擎调用失败',
        message.error?.code || 'ENGINE_REQUEST_FAILED',
        request.command,
        message.request_id,
      ));
    }
  }

  private async stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    const gracefulTimeoutMs = this.options.gracefulStopTimeoutMs ?? GRACEFUL_STOP_TIMEOUT_MS;
    const shutdownTimeoutMs = Math.min(
      gracefulTimeoutMs,
      this.options.shutdownRequestTimeoutMs ?? SHUTDOWN_REQUEST_TIMEOUT_MS,
    );
    const deadline = Date.now() + gracefulTimeoutMs;
    let shutdownError: unknown = null;
    let confirmedInactive = false;
    while (!this.hasExited(child) && Date.now() < deadline) {
      const remainingBeforeShutdown = Math.max(1, deadline - Date.now());
      const requestTimeoutMs = Math.max(
        1,
        Math.min(shutdownTimeoutMs, remainingBeforeShutdown),
      );
      try {
        await this.request('shutdown', {}, requestTimeoutMs);
        shutdownError = null;
        break;
      } catch (error) {
        shutdownError = error;
        if (this.hasExited(child)) break;
        if (error instanceof EngineRequestTimeoutError) {
          this.emit('log', `录音引擎未在 ${requestTimeoutMs / 1_000} 秒内完成本次安全收尾，正在对账引擎状态。`);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          this.emit('log', `录音引擎安全收尾尚未完成，正在对账引擎状态：${message}`);
        }

        const remainingBeforeReconciliation = deadline - Date.now();
        if (remainingBeforeReconciliation <= 0) break;
        try {
          const state = await this.request(
            'get_state_optional',
            {},
            Math.max(1, Math.min(5_000, remainingBeforeReconciliation)),
          );
          if (state && typeof state === 'object' && (state as { active?: unknown }).active === false) {
            // Capture resources are no longer live. Preserve the failed
            // shutdown acknowledgement as a terminal error, but EOF is now
            // safe to deliver so the sidecar can exit non-zero.
            confirmedInactive = true;
            break;
          }
          if (state && typeof state === 'object' && (state as { active?: unknown }).active === true) {
            this.emit('log', '录音引擎仍在安全封存，将在总时限内继续重试。');
          } else {
            this.emit('log', '录音引擎返回了无法确认的状态，已保持输入通道并继续重试。');
          }
        } catch (reconciliationError) {
          if (this.hasExited(child)) break;
          const message = reconciliationError instanceof Error
            ? reconciliationError.message
            : String(reconciliationError);
          this.emit('log', `无法确认录音引擎已停止，已保持输入通道：${message}`);
        }

        const retryDelayMs = Math.min(50, Math.max(0, deadline - Date.now()));
        if (retryDelayMs > 0 && await this.waitForExit(child, retryDelayMs)) break;
      }
    }

    const shutdownConfirmed = this.shutdownConfirmedChildren.has(child);
    // Closing stdin is itself a shutdown command. Do it only after the engine
    // acknowledged a complete seal, or after state reconciliation proved that
    // no capture session remains. An active/unknown session keeps the pipe and
    // process alive beyond the UI deadline so accepted audio can still drain.
    if ((shutdownConfirmed || confirmedInactive)
      && !this.hasExited(child)
      && child.stdin.writable) {
      child.stdin.end();
    }
    const remaining = Math.max(0, deadline - Date.now());
    if (!(await this.waitForExit(child, remaining))) {
      this.emit('log', `录音引擎安全收尾超过 ${gracefulTimeoutMs / 1_000} 秒，已保留子进程继续封存，不会自动强制结束。`);
      throw new EngineSafeStopTimeoutError(gracefulTimeoutMs);
    }

    const outcome = this.stoppedOutcomes.get(child) ?? {
      safe: false,
      code: child.exitCode,
      signal: child.signalCode,
    };
    if (!shutdownConfirmed || !outcome.safe) {
      throw new EngineUnsafeStopError(outcome, shutdownConfirmed, shutdownError);
    }
  }

  private hasExited(child: ChildProcessWithoutNullStreams): boolean {
    return this.child !== child || child.exitCode !== null || child.signalCode !== null;
  }

  private waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (this.hasExited(child)) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onSettled = () => {
        clearTimeout(timer);
        child.removeListener('exit', onSettled);
        child.removeListener('error', onSettled);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.removeListener('exit', onSettled);
        child.removeListener('error', onSettled);
        resolve(this.hasExited(child));
      }, timeoutMs);
      child.once('exit', onSettled);
      child.once('error', onSettled);
    });
  }

  private handleExit(
    child: ChildProcessWithoutNullStreams,
    error: Error,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.child !== child) return;
    const expected = this.stoppingChild === child;
    const outcome: EngineStoppedOutcome = {
      safe: expected
        && this.shutdownConfirmedChildren.has(child)
        && code === 0
        && signal === null,
      code,
      signal,
    };
    this.stoppedOutcomes.set(child, outcome);
    this.child = undefined;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    if (expected) {
      this.stoppingChild = undefined;
      this.emit('stopped', outcome);
    } else {
      this.emit('offline', error.message);
    }
  }
}
