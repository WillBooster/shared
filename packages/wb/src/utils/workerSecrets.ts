import type { EnvReaderOptions } from '@willbooster/shared-lib-node/src';
import { readEnvironmentVariables } from '@willbooster/shared-lib-node/src';

import type { Project } from '../project.js';
import { selectFnoxSourcedKeys } from './envSources.js';

export interface DeclaredSecrets {
  /** The value of every declared secret that has one; an empty string is a value. */
  secrets: Record<string, string>;
  /** Declared secrets with no value in fnox or the environment. */
  missingSecretNames: string[];
  /** fnox keys the config does not declare as secrets, which wb therefore does not supply as such. */
  undeclaredFnoxKeys: string[];
}

/**
 * Resolve the values of the secrets `cloudflare.config.ts` declares with `bindings.secret()`.
 * `wb deploy` uploads exactly this set and `wb gen-dev-vars` writes exactly this set, so wb
 * supplies the same secrets to the deployed Worker and the locally served one (Cloudflare
 * additionally keeps a previous version's secrets that an upload does not name). A value comes from wb's
 * effective environment (`project.env`, which already applies wb's precedence between exported
 * values and the selected fnox profile), else from fnox.
 */
export function resolveDeclaredSecrets(
  argv: EnvReaderOptions,
  project: Pick<Project, 'dirPath' | 'env'>,
  secretNames: readonly string[]
): DeclaredSecrets {
  // Ignore process.env because the parent wb process injects the fnox values into it, which
  // would otherwise suppress loading them here.
  const [envVars, envSources] = readEnvironmentVariables(argv, project.dirPath, { ignoreProcessEnv: true });
  const fnoxKeys = selectFnoxSourcedKeys(envSources);
  const fnoxValues = Object.fromEntries(Object.entries(envVars).filter(([key]) => fnoxKeys.has(key)));
  return {
    ...selectDeclaredSecrets(secretNames, fnoxValues, project.env),
    undeclaredFnoxKeys: [...fnoxKeys].filter((key) => !secretNames.includes(key)),
  };
}

/**
 * Select the values of the declared secrets: the effective environment's value, which may be one
 * fnox does not hold (e.g. a CI workflow env), else the fnox value. Empty strings are values:
 * pushing one clears a stale remote secret.
 */
export function selectDeclaredSecrets(
  secretNames: readonly string[],
  fnoxValues: Record<string, string>,
  effectiveEnv: Record<string, string | undefined>
): Pick<DeclaredSecrets, 'missingSecretNames' | 'secrets'> {
  const secrets: Record<string, string> = {};
  const missingSecretNames: string[] = [];
  for (const name of secretNames) {
    // Own entries only: a secret may be named like an Object.prototype member (e.g. toString).
    const value = getOwnValue(effectiveEnv, name) ?? getOwnValue(fnoxValues, name);
    if (value === undefined) {
      missingSecretNames.push(name);
    } else {
      secrets[name] = value;
    }
  }
  return { missingSecretNames, secrets };
}

function getOwnValue(values: Record<string, string | undefined>, name: string): string | undefined {
  return Object.hasOwn(values, name) ? values[name] : undefined;
}
