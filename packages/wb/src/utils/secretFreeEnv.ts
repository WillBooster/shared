import type { Project } from '../project.js';
import { collectPlaintextFnoxValues } from './fnoxToml.js';

const HOST_KEYS = ['CI', 'FORCE_COLOR', 'HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'PATH', 'TERM', 'TMPDIR', 'USER'];
const WB_DERIVED_KEYS = ['NEXT_PUBLIC_WB_ENV', 'NEXT_PUBLIC_WB_VERSION', 'WB_ENV', 'WB_VERSION'];

/**
 * The environment for a build whose output ships (e.g. Worker assets or a Docker image): host
 * basics plus fnox.toml's plaintext values for `envName`, so neither a decrypted secret nor a
 * deploy credential (e.g. CLOUDFLARE_API_TOKEN) can be inlined into the output.
 */
export function createSecretFreeBuildEnv(project: Project, envName: string): Record<string, string> {
  const env: Record<string, string> = {
    ...collectPlaintextFnoxValues(project.dirPath, project.rootDirPath, envName),
    // A nested `wb` (e.g. in gen-code) would otherwise decrypt with an identity file that fnox
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
