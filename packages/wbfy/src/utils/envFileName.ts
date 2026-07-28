/**
 * Whether wb's .env cascade could read a file named `fileName` (`.env`, `.env.local`,
 * `.env.<mode>`, `.env.<mode>.local`, ...), `.env.example` included — it signals developer-local
 * cascade files a fresh checkout cannot see. Only the exact `.env.cloudflare` name is excluded:
 * wb's deploy reads that sidecar directly regardless of fnox (readCloudflareEnvFiles), while a
 * `.env.cloudflare.*` variant is NOT the sidecar and conservatively counts as cascade usage
 * (wb 18's `--cascade-env` accepts arbitrary names, so e.g. `.env.cloudflare.local` is loadable).
 */
export function isEnvCascadeFileName(fileName: string): boolean {
  return /^\.env(?:\.|$)/u.test(fileName) && fileName !== '.env.cloudflare';
}

/**
 * Whether removeEnvFiles may delete a file named `fileName` from a fnox-migrated repository.
 * Unlike isEnvCascadeFileName, the whole `.env.cloudflare*` family is kept: `.env.cloudflare` is
 * the deployment-credential sidecar that untrackCloudflareEnv unlinks from git while keeping it
 * on disk (a local `wb deploy` still needs the real token in it), and deleting a sibling local
 * variant would likewise destroy a developer-local credential file.
 */
export function isRemovableEnvFileName(fileName: string): boolean {
  return /^\.env(?:\.|$)/u.test(fileName) && !/^\.env\.cloudflare(?:\.|$)/u.test(fileName);
}
