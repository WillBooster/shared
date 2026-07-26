/**
 * The keys actually declared in the project's fnox sources. `mise env` is reported as a
 * pseudo-source that mixes in host/tool variables (PATH, CARGO_HOME, RUSTUP_*, ...); those must
 * never be treated as the project's own variables, so they are excluded here.
 */
export function selectFnoxSourcedKeys(envSources: ReadonlyArray<readonly [string, readonly string[]]>): Set<string> {
  return new Set(envSources.filter(([source]) => !source.startsWith('mise env')).flatMap(([, keys]) => keys));
}
