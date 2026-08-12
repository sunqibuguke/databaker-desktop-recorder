'use strict';

const { existsSync, readFileSync, readdirSync, rmSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const SentryCli = require('@sentry/cli');

const projectRoot = path.join(__dirname, '..');
const tokenFile = path.join(projectRoot, '.env.sentry-build-plugin');

if (!process.env.SENTRY_AUTH_TOKEN && existsSync(tokenFile)) {
  const token = readFileSync(tokenFile, 'utf8').match(/^SENTRY_AUTH_TOKEN=(.+)$/m)?.[1]?.trim();
  if (token) process.env.SENTRY_AUTH_TOKEN = token;
}

if (!process.env.SENTRY_AUTH_TOKEN) {
  console.log('Sentry main-process source map upload skipped (SENTRY_AUTH_TOKEN is not set).');
  process.exit(0);
}

const outputDirectory = path.join(projectRoot, 'dist-electron');
const cli = SentryCli.getPath();

function run(args) {
  const result = spawnSync(cli, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['sourcemaps', 'inject', outputDirectory]);
run([
  'sourcemaps',
  'upload',
  '--org', 'vsoul',
  '--project', 'databaker-record-desktop',
  outputDirectory,
]);

for (const file of readdirSync(outputDirectory)) {
  if (file.endsWith('.map')) rmSync(path.join(outputDirectory, file), { force: true });
}
