import type { Project } from '../project.js';
import { collectPlaintextFnoxValues } from './fnoxToml.js';

const HOST_KEYS = [
  'CI',
  'FORCE_COLOR',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'NO_COLOR',
  'NO_PROXY',
  'PATH',
  'TERM',
  'TMPDIR',
  'USER',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];
const WB_DERIVED_KEYS = ['NEXT_PUBLIC_WB_ENV', 'NEXT_PUBLIC_WB_VERSION', 'WB_ENV', 'WB_VERSION'];

/**
 * The environment for a build whose output ships (e.g. Worker assets): host basics plus
 * fnox.toml's plaintext values for `envName`, so neither a decrypted secret nor a credential
 * supplied from outside fnox.toml (e.g. `.env.cloudflare`'s CLOUDFLARE_API_TOKEN) can be inlined
 * into the output.
 */
export function createSecretFreeBuildEnv(project: Project, envName: string): Record<string, string> {
  const env: Record<string, string> = {
    // Not project.env's values: an exported value of a key with a plaintext placeholder (e.g.
    // `OPENAI_API_KEY = { default = "" }`) is a real secret.
    ...collectPlaintextFnoxValues(project.dirPath, project.rootDirPath, envName),
    // A `wb` or fnox run inside the build would otherwise decrypt with an identity file that fnox
    // finds on the host (~/.config/fnox) even without FNOX_AGE_KEY.
    FNOX_AGE_KEY_FILE: '/nonexistent',
  };
  for (const key of [...HOST_KEYS, ...WB_DERIVED_KEYS]) {
    const value = project.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.WB_ENV = envName;
  return env;
}
