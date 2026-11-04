export function createWranglerDeployEnv<Value extends string | undefined>(
  source: Record<string, Value>
): Record<string, Value> {
  const env = { ...source };
  delete env.CLOUDFLARE_ENV;
  return env;
}
