export type AppEnv = 'development' | 'test' | 'staging' | 'production';

/**
 * The runtime `WB_ENV` widened to the full domain wb standardizes.
 *
 * Generated Worker types may narrow `process.env.WB_ENV` to the literal values the Worker
 * configuration declares, while wb also runs the app as `development` and `test`. This accessor
 * widens the generated type back to the real runtime domain so environment detection stays in
 * one place.
 *
 * Exposed as a function rather than a constant because Cloudflare Workers may not provide
 * environment variables during module evaluation; callers choose when to read. Returns undefined
 * where `process` does not exist (e.g. browsers).
 */
export function getAppEnv(): AppEnv | undefined {
  return typeof process === 'undefined' ? undefined : (process.env.WB_ENV as AppEnv | undefined);
}
