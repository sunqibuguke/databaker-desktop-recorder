const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const executable = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const home = os.homedir();
const candidates = [
  process.env.CARGO,
  process.env.CARGO_HOME && path.join(process.env.CARGO_HOME, 'bin', executable),
  path.join(home, '.cargo', 'bin', executable),
  path.join(home, '.cache', 'databaker-rust', 'cargo', 'bin', executable),
].filter(Boolean);

const cargo = candidates.find((candidate) => fs.existsSync(candidate)) ?? executable;
const environment = { ...process.env };
const localCacheCargo = path.join(home, '.cache', 'databaker-rust', 'cargo', 'bin', executable);
if (cargo === localCacheCargo) {
  environment.CARGO_HOME ??= path.join(home, '.cache', 'databaker-rust', 'cargo');
  environment.RUSTUP_HOME ??= path.join(home, '.cache', 'databaker-rust', 'rustup');
}

const result = spawnSync(cargo, process.argv.slice(2), {
  cwd: path.join(__dirname, '..'),
  env: environment,
  stdio: 'inherit',
});

if (result.error) {
  console.error('未找到可用的 Rust/Cargo。请先按 README 安装 Rust stable。');
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
