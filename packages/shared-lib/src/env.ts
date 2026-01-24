type EnvSource = Record<string, string | undefined>;

const metaEnv: EnvSource | undefined = 'env' in import.meta ? (import.meta as { env?: EnvSource }).env : undefined;
const processEnv: EnvSource | undefined = (globalThis as { process?: { env?: EnvSource } }).process?.env;

const readEnvValue = (key: string): string | undefined => {
  const processValue = processEnv?.[key];
  if (processValue !== undefined) {
    return processValue;
  }
  return metaEnv ? metaEnv[key] : undefined;
};

export const readEnvVar = (key: string): string | undefined => readEnvValue(key);

export const readRequiredEnvVar = (key: string, env?: EnvSource): string => {
  const value = env ? env[key] : readEnvVar(key);
  if (value === undefined || value === '') {
    throw new Error(`${key} environment variable is required.`);
  }
  return value;
};
