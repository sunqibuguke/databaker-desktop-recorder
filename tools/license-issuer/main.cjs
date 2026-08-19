'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');

const ISSUER_SUNSET_UNIX = 1_830_268_800;
const ISSUER_DISABLED_MESSAGE = '授权注册机已停用：2027 年之后无法打开。';
const MAX_LICENSE_DAYS = 365;
const MAX_LICENSE_MESSAGE = '最长授权一年';
const NO_PERPETUAL_MESSAGE = '不支持永久授权，最长授权一年';

function licenseModule() {
  const compiled = path.join(__dirname, '..', '..', 'dist-electron', 'license.js');
  if (!fs.existsSync(compiled)) {
    throw new Error('找不到 dist-electron/license.js，请先运行 npm run build:electron');
  }
  return require(compiled);
}

function defaultKeyPath() {
  return process.env.DATABAKER_LICENSE_PRIVATE_KEY_FILE
    || path.join(__dirname, 'keys', 'license-2026a.pem');
}

function createWindow() {
  const window = new BrowserWindow({
    width: 560,
    height: 640,
    minWidth: 480,
    minHeight: 560,
    title: 'DataBaker 授权注册机',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.removeMenu();
  void window.loadFile(path.join(__dirname, 'index.html'));
}

function issuerExpiresAt(value) {
  if (value == null) return value;
  if (typeof value === 'string') return licenseModule().parseExpiryDate(value);
  return value;
}

ipcMain.handle('issuer:issue', (_event, payload) => {
  const { issueLicense } = licenseModule();
  const now = Math.floor(Date.now() / 1000);
  if (now >= ISSUER_SUNSET_UNIX) {
    throw new Error(ISSUER_DISABLED_MESSAGE);
  }
  if (payload?.perpetual) {
    throw new Error(NO_PERPETUAL_MESSAGE);
  }
  const days = payload?.expiresAt ? undefined : Number(payload?.days || MAX_LICENSE_DAYS);
  if (days !== undefined && (!Number.isSafeInteger(days) || days < 1 || days > MAX_LICENSE_DAYS)) {
    throw new Error(MAX_LICENSE_MESSAGE);
  }
  const expiresAt = issuerExpiresAt(payload?.expiresAt);
  if (typeof expiresAt === 'number') {
    const todayStart = Math.floor(now / 86_400) * 86_400;
    const maxExpiry = todayStart + (MAX_LICENSE_DAYS + 1) * 86_400;
    if (expiresAt <= now) throw new Error('授权日期必须晚于今天');
    if (expiresAt > maxExpiry) throw new Error(MAX_LICENSE_MESSAGE);
  }
  const keyPath = defaultKeyPath();
  if (!fs.existsSync(keyPath)) {
    throw new Error(`读不到签发私钥：${keyPath}`);
  }
  return issueLicense({
    privateKeyPem: fs.readFileSync(keyPath, 'utf8'),
    kid: typeof payload?.kid === 'string' && payload.kid.trim() ? payload.kid.trim() : '2026a',
    subject: String(payload?.subject ?? ''),
    machineCode: String(payload?.machineCode ?? ''),
    days,
    perpetual: false,
    expiresAt,
  });
});

ipcMain.handle('issuer:verify', (_event, ticket) => {
  const { inspectLicenseTicket, verifyLicenseTicket } = licenseModule();
  const claims = inspectLicenseTicket(String(ticket ?? ''));
  const verified = verifyLicenseTicket(String(ticket ?? ''));
  return {
    claims,
    valid: !('reason' in verified),
    reason: 'reason' in verified ? verified.reason : null,
  };
});

app.whenReady().then(() => {
  if (Math.floor(Date.now() / 1000) >= ISSUER_SUNSET_UNIX) {
    dialog.showErrorBox('DataBaker 授权注册机', ISSUER_DISABLED_MESSAGE);
    app.quit();
    return;
  }
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
