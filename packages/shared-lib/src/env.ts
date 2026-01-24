type EnvSource = Record<string, string | undefined>;

export const readEnvVar = (key: string, env: EnvSource = process.env): string | undefined => env[key];

export const readRequiredEnvVar = (key: string, env: EnvSource = process.env): string => {
  const value = readEnvVar(key, env);
  if (value === undefined || value === '') {
    throw new Error(`${key} environment variable is required.`);
  }
  return value;
};
