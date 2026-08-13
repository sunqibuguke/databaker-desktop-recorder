// Production verification keys only. Test-only keypairs stay in scripts/fixtures
// and are injected by unit tests — they must never be accepted by a shipped build.
export const DEFAULT_LICENSE_KID = '2026a';

export const LICENSE_PUBLIC_KEYS: Readonly<Record<string, string>> = {
  '2026a': `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAP0lUK/EI4SsAx//cShSNQcUg3fTMHSu49d0Gr516rVI=
-----END PUBLIC KEY-----
`,
};
