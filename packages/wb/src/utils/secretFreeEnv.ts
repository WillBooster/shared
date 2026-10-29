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
  const plaintextValues = collectPlaintextFnoxValues(project.dirPath, project.rootDirPath, envName);
  const env: Record<string, string> = {
    // A nested `wb` (e.g. in gen-code) would otherwise decrypt with an identity file that fnox
    // finds on the host (~/.config/fnox) even without FNOX_AGE_KEY.
    FNOX_AGE_KEY_FILE: '/nonexistent',
  };
  // project.env applies wb's precedence, so an explicitly exported value wins here as it does in
  // the deployed Worker's variables.
  for (const key of [...Object.keys(plaintextValues), ...HOST_KEYS, ...WB_DERIVED_KEYS]) {
    const value = project.env[key] ?? plaintextValues[key];
    if (value !== undefined) env[key] = value;
  }
  env.WB_ENV = envName;
  return env;
}
