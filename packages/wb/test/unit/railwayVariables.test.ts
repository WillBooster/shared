import { afterEach, describe, expect, it } from 'bun:test';

import { railwayVariables } from '../../bin/railway.js';

const preserve = (): { type: string } => ({ type: 'preserve' });

describe('railwayVariables', () => {
  afterEach(() => {
    delete process.env.WB_RAILWAY_VARIABLE_NAMES;
  });

  it('preserves the names wb passes and adds the Railway-only values', () => {
    process.env.WB_RAILWAY_VARIABLE_NAMES = JSON.stringify(['API_KEY', 'WB_ENV']);

    expect(railwayVariables(preserve, { ARCH: 'x86_64' })).toEqual({
      API_KEY: { type: 'preserve' },
      WB_ENV: { type: 'preserve' },
      ARCH: 'x86_64',
    });
  });

  it('rejects a key declared in both fnox and railway.ts', () => {
    process.env.WB_RAILWAY_VARIABLE_NAMES = JSON.stringify(['DATABASE_URL', 'PORT']);

    expect(() => railwayVariables(preserve, { DATABASE_URL: 'reference', PORT: '8080' })).toThrow(
      'not both: DATABASE_URL, PORT'
    );
  });

  it('rejects an evaluation that wb deploy did not start', () => {
    expect(() => railwayVariables(preserve)).toThrow('inside the function passed to defineRailway');
  });
});
