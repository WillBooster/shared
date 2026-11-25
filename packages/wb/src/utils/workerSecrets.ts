import type { EnvReaderOptions } from '@willbooster/shared-lib-node/src';
import { readEnvironmentVariables } from '@willbooster/shared-lib-node/src';

import type { Project } from '../project.js';
import { selectFnoxSourcedKeys } from './envSources.js';

export interface DeclaredSecrets {
  /** The value of every declared secret that has one; an empty string is a value. */
  secrets: Record<string, string>;
  /** Declared secrets with no value in fnox or the environment. */
  missingSecretNames: string[];
  /** fnox keys the config does not declare as secrets, which therefore never reach the Worker as such. */
  undeclaredFnoxKeys: string[];
}

/**
 * Resolve the values of the secrets `cloudflare.config.ts` declares with `bindings.secret()`.
 * `wb deploy` pushes exactly this set and `wb gen-dev-vars` writes exactly this set, so the
 * deployed Worker and the locally served one receive the same secrets.
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
 * Select the values of the declared secrets. An explicitly exported environment variable wins
 * over the fnox value (so `AUTH_SECRET=... wb deploy` does not push the stale configured value)
 * and may supply a secret fnox does not hold (e.g. a CI workflow env). Empty strings are values:
 * pushing one clears a stale remote secret.
 */
export function selectDeclaredSecrets(
  secretNames: readonly string[],
  fnoxValues: Record<string, string>,
  exportedEnv: Record<string, string | undefined>
): Pick<DeclaredSecrets, 'missingSecretNames' | 'secrets'> {
  const secrets: Record<string, string> = {};
  const missingSecretNames: string[] = [];
  for (const name of secretNames) {
    const value = exportedEnv[name] ?? fnoxValues[name];
    if (value === undefined) {
      missingSecretNames.push(name);
    } else {
      secrets[name] = value;
    }
  }
  return { missingSecretNames, secrets };
}
