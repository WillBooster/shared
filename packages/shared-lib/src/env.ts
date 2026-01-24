type EnvSource = Record<string, string | undefined>;

const metaEnv: EnvSource | undefined = 'env' in import.meta ? (import.meta as { env?: EnvSource }).env : undefined;
const processEnv: EnvSource | undefined = (globalThis as { process?: { env?: EnvSource } }).process?.env;

export function getEnvValue(key: string): string | undefined {
  return processEnv?.[key] ?? metaEnv?.[key];
}

export function getRequiredEnvValue(key: string): string {
  const value = getEnvValue(key);
  if (!value) {
    throw new Error(`${key} environment variable is required.`);
  }
  return value;
}
