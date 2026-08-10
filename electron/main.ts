import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EngineClient } from './engine-client';

let mainWindow: BrowserWindow | null = null;
let prompterWindow: BrowserWindow | null = null;
let latestPrompterState: unknown = null;
let engine: EngineClient | null = null;
let quitting = false;
let activeSessionDir: string | null = null;
const allowedOutputRoots = new Set<string>();
const canonicalOutputRoots = new Map<string, string>();
const knownSessionDirs = new Set<string>();

const allowedCommands = new Set([
  'hello',
  'list_devices',
  'start_session',
  'check_noise',
  'start_attempt',
  'stop_attempt',
  'accept_attempt',
  'skip_item',
  'render_attempt',
  'get_state',
  'stop_session',
  'export_session',
]);

function engineExecutable(): string {
  const executable = process.platform === 'win32' ? 'recorder-engine.exe' : 'recorder-engine';
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', executable);
  return path.join(app.getAppPath(), 'engine', 'target', 'debug', executable);
}

function defaultOutputRoot(): string {
  return process.env.DATABAKER_DEFAULT_OUTPUT
    ? path.resolve(process.env.DATABAKER_DEFAULT_OUTPUT)
    : path.join(app.getPath('documents'), 'DataBaker Recordings');
}

function isWithin(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isAllowedOutputRoot(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return allowedOutputRoots.has(resolved);
}

function isAllowedNewSession(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return Array.from(allowedOutputRoots).some((root) => path.dirname(resolved) === root);
}

async function resolveAuthorizedOutputRoot(candidate: string, create: boolean): Promise<string> {
  const lexical = path.resolve(candidate);
  if (!allowedOutputRoots.has(lexical)) throw new Error('只能使用已授权的录制保存目录');
  if (create) await fs.mkdir(lexical, { recursive: true });
  const canonical = await fs.realpath(lexical);
  const remembered = canonicalOutputRoots.get(lexical);
  if (remembered && remembered !== canonical) {
    throw new Error('录制保存目录已发生变化，请重新选择保存位置');
  }
  canonicalOutputRoots.set(lexical, canonical);
  return canonical;
}

async function isInsideKnownSession(candidate: string): Promise<boolean> {
  let target: string;
  try {
    target = await fs.realpath(path.resolve(candidate));
  } catch {
    return false;
  }
  for (const known of knownSessionDirs) {
    if (isWithin(known, target)) return true;
  }
  return false;
}

async function resolveKnownSession(candidate: string): Promise<string | null> {
  try {
    const canonical = await fs.realpath(path.resolve(candidate));
    return knownSessionDirs.has(canonical) ? canonical : null;
  } catch {
    return null;
  }
}

function countItems(items: unknown[], status: string): number {
  return items.filter((item) => {
    if (!item || typeof item !== 'object') return false;
    return (item as { status?: unknown }).status === status;
  }).length;
}

async function listRecordings(root: string): Promise<unknown[]> {
  const resolvedRoot = path.resolve(root);
  if (!isAllowedOutputRoot(resolvedRoot)) throw new Error('只能读取已授权的录制保存目录');
  let canonicalRoot: string;
  try {
    canonicalRoot = await resolveAuthorizedOutputRoot(resolvedRoot, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let children: import('node:fs').Dirent[];
  try {
    children = await fs.readdir(canonicalRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const candidates: Array<{ sessionDir: string; snapshotPath: string; modifiedAtMs: number }> = [];
  for (const entry of children) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const lexicalSessionDir = path.join(canonicalRoot, entry.name);
    try {
      const entryStat = await fs.lstat(lexicalSessionDir);
      if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) continue;
      const sessionDir = await fs.realpath(lexicalSessionDir);
      if (path.dirname(sessionDir) !== canonicalRoot) continue;
      const metadataDir = path.join(sessionDir, 'metadata');
      const metadataStat = await fs.lstat(metadataDir);
      if (metadataStat.isSymbolicLink() || !metadataStat.isDirectory()) continue;
      if (await fs.realpath(metadataDir) !== metadataDir) continue;
      const snapshotPath = path.join(metadataDir, 'items.snapshot.json');
      const snapshotStat = await fs.lstat(snapshotPath);
      if (snapshotStat.isSymbolicLink() || !snapshotStat.isFile() || snapshotStat.size > 16 * 1024 * 1024) continue;
      candidates.push({ sessionDir, snapshotPath, modifiedAtMs: snapshotStat.mtimeMs });
    } catch {
      // Ignore incomplete or concurrently moved directories.
    }
  }
  candidates.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
  const rows: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    if (rows.length >= 500) break;
    try {
      const snapshot = JSON.parse(await fs.readFile(candidate.snapshotPath, 'utf8')) as Record<string, unknown>;
      if (snapshot.schema_version !== 1 || typeof snapshot.session_id !== 'string') continue;
      const items = Array.isArray(snapshot.items) ? snapshot.items : [];
      const audioFormat = snapshot.audio_format && typeof snapshot.audio_format === 'object'
        ? snapshot.audio_format as Record<string, unknown>
        : {};
      const exportDir = path.join(candidate.sessionDir, 'export');
      const exportExists = await fs.lstat(exportDir)
        .then(async (directory) => directory.isDirectory() && !directory.isSymbolicLink()
          && await fs.realpath(exportDir) === exportDir
          && await fs.lstat(path.join(exportDir, 'metadata.json'))
            .then((value) => value.isFile() && !value.isSymbolicLink())
            .catch(() => false))
        .catch(() => false);
      knownSessionDirs.add(candidate.sessionDir);
      rows.push({
        session_id: snapshot.session_id,
        session_dir: candidate.sessionDir,
        script_name: typeof snapshot.script_name === 'string' && snapshot.script_name
          ? snapshot.script_name
          : '未记录源文件',
        status: typeof snapshot.status === 'string' ? snapshot.status : 'unknown',
        is_active: activeSessionDir === candidate.sessionDir,
        started_at: typeof snapshot.started_at === 'string' ? snapshot.started_at : '',
        updated_at: typeof snapshot.updated_at === 'string' ? snapshot.updated_at : '',
        device_name: typeof snapshot.device_name === 'string' ? snapshot.device_name : '',
        sample_rate: typeof audioFormat.sample_rate === 'number' ? audioFormat.sample_rate : 0,
        bit_depth: typeof audioFormat.bit_depth === 'number' ? audioFormat.bit_depth : 16,
        encoding: typeof audioFormat.encoding === 'string' ? audioFormat.encoding : 'pcm',
        input_channel: typeof audioFormat.input_channel === 'number' ? audioFormat.input_channel : 1,
        captured_samples: typeof snapshot.captured_samples === 'number' ? snapshot.captured_samples : 0,
        overflow_samples: typeof snapshot.overflow_samples === 'number' ? snapshot.overflow_samples : 0,
        total_items: items.length,
        accepted_items: countItems(items, 'accepted'),
        skipped_items: countItems(items, 'skipped'),
        review_items: countItems(items, 'review'),
        pending_items: countItems(items, 'pending'),
        noise_check: snapshot.noise_check ?? null,
        export_exists: exportExists,
      });
    } catch {
      // Ignore invalid snapshots without hiding the other recordings.
    }
  }
  return rows
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
    .slice(0, 200);
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#0a0d14',
    title: 'DataBaker 音频采集',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.on('closed', () => {
    mainWindow = null;
    prompterWindow?.close();
  });
  const developmentUrl = process.env.VITE_DEV_SERVER_URL;
  if (developmentUrl) {
    await mainWindow.loadURL(developmentUrl);
  } else {
    await mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
  }
}

async function createPrompterWindow(): Promise<BrowserWindow> {
  if (prompterWindow && !prompterWindow.isDestroyed()) {
    prompterWindow.show();
    prompterWindow.focus();
    return prompterWindow;
  }
  const primaryDisplay = screen.getPrimaryDisplay();
  const targetDisplay = screen.getAllDisplays().find((display) => display.id !== primaryDisplay.id)
    ?? primaryDisplay;
  prompterWindow = new BrowserWindow({
    ...targetDisplay.workArea,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#111315',
    title: '领读面板',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  prompterWindow.removeMenu();
  prompterWindow.on('closed', () => {
    prompterWindow = null;
  });
  prompterWindow.webContents.on('did-finish-load', () => {
    if (latestPrompterState !== null) {
      prompterWindow?.webContents.send('prompter:state', latestPrompterState);
    }
  });
  const developmentUrl = process.env.VITE_DEV_SERVER_URL;
  if (developmentUrl) {
    const url = new URL(developmentUrl);
    url.searchParams.set('view', 'prompter');
    await prompterWindow.loadURL(url.toString());
  } else {
    await prompterWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'), {
      query: { view: 'prompter' },
    });
  }
  return prompterWindow;
}

function assertMainRenderer(sender: Electron.WebContents): void {
  if (!mainWindow || mainWindow.isDestroyed() || sender !== mainWindow.webContents) {
    throw new Error('只能从主录制面板操作领读窗口');
  }
}

function registerIpc(): void {
  allowedOutputRoots.add(path.resolve(defaultOutputRoot()));
  ipcMain.handle('engine:request', async (_event, command: string, payload: unknown) => {
    if (!allowedCommands.has(command)) throw new Error(`不允许的录音引擎命令：${command}`);
    if (!engine) throw new Error('录音引擎不可用');
    if (command === 'start_session') {
      const sessionDir = (payload as { session_dir?: unknown })?.session_dir;
      if (typeof sessionDir !== 'string') throw new Error('录制目录无效');
      const resolved = path.resolve(sessionDir);
      if (!isAllowedNewSession(resolved)) throw new Error('新录制必须保存在已授权目录的直接子目录中');
      const canonicalRoot = await resolveAuthorizedOutputRoot(path.dirname(resolved), true);
      const canonicalTarget = path.join(canonicalRoot, path.basename(resolved));
      const existing = await fs.lstat(canonicalTarget).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (existing) throw new Error('同名录制目录已存在，请更换录制名称后重试');
      const safePayload = { ...(payload as Record<string, unknown>), session_dir: canonicalTarget };
      const result = await engine.request(command, safePayload, 20_000);
      let canonical: string;
      try {
        canonical = await fs.realpath(canonicalTarget);
        if (path.dirname(canonical) !== canonicalRoot) {
          throw new Error('新录制目录越过了已授权的保存位置');
        }
      } catch (error) {
        await engine.request('stop_session', {}, 120_000).catch(() => undefined);
        throw error;
      }
      activeSessionDir = canonical;
      knownSessionDirs.add(canonical);
      return result;
    }
    let safePayload = payload;
    if (command === 'export_session') {
      const sessionDir = (payload as { session_dir?: unknown })?.session_dir;
      const canonical = typeof sessionDir === 'string' ? await resolveKnownSession(sessionDir) : null;
      if (!canonical) {
        throw new Error('只能导出当前或历史录制目录');
      }
      safePayload = { ...(payload as Record<string, unknown>), session_dir: canonical };
    }
    const timeout = command === 'export_session' || command === 'stop_session' ? 120_000 : 20_000;
    const result = await engine.request(command, safePayload, timeout);
    if (command === 'stop_session') activeSessionDir = null;
    return result;
  });

  ipcMain.handle('dialog:open-script', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择录音脚本',
      properties: ['openFile'],
      filters: [
        { name: '脚本文件', extensions: ['csv', 'tsv', 'txt'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    const content = (await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
    return { filePath, name: path.basename(filePath), content };
  });

  ipcMain.handle('dialog:choose-output', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择录制保存目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    const selected = result.canceled ? null : result.filePaths[0] ?? null;
    if (selected) {
      const lexical = path.resolve(selected);
      allowedOutputRoots.add(lexical);
      await resolveAuthorizedOutputRoot(lexical, false);
    }
    return selected;
  });

  ipcMain.handle('app:default-output', () => defaultOutputRoot());
  ipcMain.handle('prompter:open', async (event) => {
    assertMainRenderer(event.sender);
    await createPrompterWindow();
    return true;
  });
  ipcMain.handle('prompter:close', (event) => {
    const fromMain = mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
    const fromPrompter = prompterWindow && !prompterWindow.isDestroyed() && event.sender === prompterWindow.webContents;
    if (!fromMain && !fromPrompter) throw new Error('领读窗口不可用');
    prompterWindow?.close();
  });
  ipcMain.handle('prompter:toggle-fullscreen', (event) => {
    if (!prompterWindow || event.sender !== prompterWindow.webContents) {
      throw new Error('领读窗口不可用');
    }
    prompterWindow.setFullScreen(!prompterWindow.isFullScreen());
    return prompterWindow.isFullScreen();
  });
  ipcMain.handle('prompter:get-state', (event) => {
    if (!prompterWindow || event.sender !== prompterWindow.webContents) {
      throw new Error('领读窗口不可用');
    }
    return latestPrompterState;
  });
  ipcMain.on('prompter:update', (event, state: unknown) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
    latestPrompterState = state;
    prompterWindow?.webContents.send('prompter:state', state);
  });
  ipcMain.handle('recordings:list', (_event, root: string) => listRecordings(root));
  ipcMain.handle('path:join', (_event, ...parts: string[]) => path.join(...parts));
  ipcMain.handle('audio:read', async (_event, filePath: string) => {
    if (!(await isInsideKnownSession(filePath)) || path.extname(filePath).toLowerCase() !== '.wav') {
      throw new Error('只能试听录制目录内的 WAV 文件');
    }
    const data = await fs.readFile(filePath);
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  });
  ipcMain.handle('shell:open-path', async (_event, target: string) => {
    if (!(await isInsideKnownSession(target))) throw new Error('只能打开已识别的录制目录');
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
  });
}

app.whenReady().then(async () => {
  registerIpc();
  engine = new EngineClient(engineExecutable());
  engine.on('event', (message) => mainWindow?.webContents.send('engine:event', message));
  engine.on('offline', (message) => {
    activeSessionDir = null;
    mainWindow?.webContents.send('engine:offline', message);
  });
  engine.on('log', (message) => console.error(`[engine] ${message}`));
  try {
    await engine.start();
  } catch (error) {
    console.error('Unable to start recorder engine:', error);
  }
  await createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (quitting || !engine) return;
  event.preventDefault();
  quitting = true;
  void engine.stop().finally(() => app.quit());
});
