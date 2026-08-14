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
  fs.writeFileSync(path.join(OUT_DIR, '使用说明.txt'), `DataBaker 授权注册机

把正式私钥 license-2026a.pem 放到本程序同一目录后再打开。
不要把私钥打进采集安装包，也不要提交 git。

窗口：双击打开，输入机器码和客户/工位名，生成授权码。
命令行：
  ${packagedName()} --machine A7K2-9M3P-Q4WX --subject 客户A-工位3 --days 365

可选环境变量：
  DATABAKER_LICENSE_PRIVATE_KEY_FILE   私钥路径
  DATABAKER_LICENSE_ISSUER_PASSWORD    打开注册机前的口令
`, 'utf8');

  const stats = fs.statSync(target);
  console.log(`packed ${target} (${Math.ceil(stats.size / 1024)} KB)`);
}

main();
