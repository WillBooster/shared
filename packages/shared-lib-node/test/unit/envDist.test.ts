import childProcess from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { isFnoxAvailable } from '../helpers/commandAvailability.js';

// Bundlers (build-ts/rolldown) replace the `process.env.NODE_ENV` member expression with the
// literal 'production' at build time, which constant-folds the auto-cascade default
// `WB_ENV || NODE_ENV || 'development'` into 'production' (this shipped in wb 14.0.0 and made
// every wb command select the production profile when WB_ENV was unset). The source avoids the
// foldable expression via an alias of `process.env`, but only the built artifact can prove the
// workaround still defeats the bundler, so this suite exercises dist/env.js in a child process.
// dist/ is built once for the whole run by the globalSetup in vitest.config.ts.
describe('bundled env cascade', () => {
  it.runIf(isFnoxAvailable())(
    'defaults --auto-cascade-env to development in the built artifact when WB_ENV and NODE_ENV are unset',
    () => {
      const script = `
      import { readEnvironmentVariables } from './dist/env.js';
      const [envVars] = readEnvironmentVariables({ autoCascadeEnv: true, quietEnv: true }, 'test/fixtures/app1');
      console.log(JSON.stringify(envVars));
    `;
      const env = { ...process.env };
      delete env.WB_ENV;
      delete env.NODE_ENV;
      // readEnvironmentVariables skips keys already present in process.env, so ambient values
      // for the fixture's own keys would drop them from the result and fail the assertion.
      delete env.ENV;
      delete env.PORT;
      delete env.NAME;
      const result = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        env,
      });
      // Surface the child's stderr: on failure it carries the whole diagnosis (broken dist, import error).
      expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
      expect(JSON.parse(result.stdout)).toMatchObject({ ENV: 'development1' });
    }
  );
});
