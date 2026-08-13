'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

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

ipcMain.handle('issuer:issue', (_event, payload) => {
  const { issueLicense } = licenseModule();
  const keyPath = defaultKeyPath();
  if (!fs.existsSync(keyPath)) {
    throw new Error(`读不到签发私钥：${keyPath}`);
  }
  const expectedPassword = process.env.DATABAKER_LICENSE_ISSUER_PASSWORD;
  if (expectedPassword && payload?.password !== expectedPassword) {
    throw new Error('注册机口令不正确');
  }
  return issueLicense({
    privateKeyPem: fs.readFileSync(keyPath, 'utf8'),
    kid: typeof payload?.kid === 'string' && payload.kid.trim() ? payload.kid.trim() : '2026a',
    subject: String(payload?.subject ?? ''),
    machineCode: String(payload?.machineCode ?? ''),
    days: payload?.perpetual ? undefined : Number(payload?.days || 365),
    perpetual: Boolean(payload?.perpetual),
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
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
