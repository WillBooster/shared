export function isCI(ciEnv: string | undefined): boolean {
  return !!ciEnv && ciEnv !== '0' && ciEnv !== 'false';
}
