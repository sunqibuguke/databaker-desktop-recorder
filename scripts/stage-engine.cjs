const fs = require('node:fs');
const path = require('node:path');

const executable = process.platform === 'win32' ? 'recorder-engine.exe' : 'recorder-engine';
const source = path.join(__dirname, '..', 'engine', 'target', 'release', executable);
const targetDir = path.join(__dirname, '..', 'build', 'bin');
const target = path.join(targetDir, executable);

if (!fs.existsSync(source)) {
  throw new Error(`Rust engine was not built: ${source}`);
}
fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(source, target);
if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
console.log(`Staged recorder engine: ${target}`);
