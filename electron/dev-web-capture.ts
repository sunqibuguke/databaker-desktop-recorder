export function isDevWebCaptureEnabled(
  platform: NodeJS.Platform,
  packaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return platform === 'darwin' && !packaged && env.DATABAKER_DEV_WEB_CAPTURE !== '0';
}

export function applyDevWebCaptureEnv(
  platform: NodeJS.Platform,
  packaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const enabled = isDevWebCaptureEnabled(platform, packaged, env);
  if (enabled) env.DATABAKER_DEV_WEB_CAPTURE = '1';
  return enabled;
}
