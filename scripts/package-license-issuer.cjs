'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join('tools', 'license-issuer-exe', 'Cargo.toml');
const OUT_DIR = path.join(ROOT, 'release', 'issuer');

function cargo(args) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-cargo.cjs'), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function binName() {
  return process.platform === 'win32'
    ? 'databaker-license-issuer.exe'
    : 'databaker-license-issuer';
}

function packagedName() {
  if (process.platform === 'win32') return 'DataBaker-License-Issuer.exe';
  if (process.platform === 'darwin') return 'DataBaker-License-Issuer';
  return 'DataBaker-License-Issuer';
}

function defaultKeyPath() {
  return process.env.DATABAKER_LICENSE_PRIVATE_KEY_FILE
    || path.join(ROOT, 'tools', 'license-issuer', 'keys', 'license-2026a.pem');
}

function stagePrivateKey() {
  const dest = path.join(OUT_DIR, 'license-2026a.pem');
  const source = defaultKeyPath();
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, dest);
    fs.chmodSync(dest, 0o600);
    return dest;
  }

  const inline = process.env.DATABAKER_LICENSE_PRIVATE_KEY;
  if (inline && /BEGIN [A-Z ]*PRIVATE KEY/.test(inline)) {
    fs.writeFileSync(dest, `${inline.replace(/\r\n/g, '\n').trim()}\n`, { mode: 0o600 });
    return dest;
  }

  throw new Error(
    `找不到签发私钥：${source}。本地请放好 PEM；GitHub Actions 请在仓库 secret 里配置 DATABAKER_LICENSE_PRIVATE_KEY（PEM 全文）`,
  );
}

function main() {
  cargo(['build', '--release', '--manifest-path', MANIFEST]);
  const source = path.join(ROOT, 'tools', 'license-issuer-exe', 'target', 'release', binName());
  if (!fs.existsSync(source)) {
    throw new Error(`找不到编译产物：${source}`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const target = path.join(OUT_DIR, packagedName());
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o755);
  const key = stagePrivateKey();
  fs.writeFileSync(path.join(OUT_DIR, '使用说明.txt'), `DataBaker 授权注册机

双击打开，输入机器码和客户/工位名即可生成授权码。私钥已随程序打包。
底部「清空本机授权」会删除本机采集软件已激活的授权，请先退出采集软件。
不要把本目录随采集安装包分发，也不要提交 git。

命令行：
  ${packagedName()} --machine A7K2-9M3P-Q4WX --subject 客户A-工位3 --days 365
  ${packagedName()} --clear-local
`, 'utf8');

  const stats = fs.statSync(target);
  const keyNote = key ? ` + ${path.basename(key)}` : '';
  console.log(`packed ${target} (${Math.ceil(stats.size / 1024)} KB${keyNote})`);
}

main();
