import childProcess from 'node:child_process';

import { beforeAll, describe, expect, it } from 'vitest';

// Bundlers (build-ts/rolldown) replace the `process.env.NODE_ENV` member expression with the
// literal 'production' at build time, which constant-folds the auto-cascade default
// `WB_ENV || NODE_ENV || 'development'` into 'production' (this shipped in wb 14.0.0 and made
// every wb command select the production profile when WB_ENV was unset). The source avoids the
// foldable expression via an alias of `process.env`, but only the built artifact can prove the
// workaround still defeats the bundler, so this suite exercises dist/env.js in a child process.
describe('bundled env cascade', () => {
  beforeAll(() => {
    const result = childProcess.spawnSync('bun', ['run', 'build'], { encoding: 'utf8', stdio: 'inherit' });
    expect(result.status).toBe(0);
  }, 120_000);

  it('defaults --auto-cascade-env to development in the built artifact when WB_ENV and NODE_ENV are unset', () => {
    const script = `
      import { readEnvironmentVariables } from './dist/env.js';
      const [envVars] = readEnvironmentVariables({ autoCascadeEnv: true, quietEnv: true }, 'test/fixtures/app1');
      console.log(JSON.stringify(envVars));
    `;
    const env = { ...process.env };
    delete env.WB_ENV;
    delete env.NODE_ENV;
    const result = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ENV: 'development1' });
  });
});
