import { describe, expect, it } from 'vitest';

import { selectRailwayVariables } from '../src/commands/railwayEnv.js';

describe('selectRailwayVariables', () => {
  it('keeps declared app variables (incl. DATABASE_URL/PORT), drops empty and Railway-managed keys, and sorts', () => {
    expect(
      selectRailwayVariables({
        DISCORD_BOT_TOKEN: 'secret',
        DATABASE_URL: 'file:/data/app.sqlite',
        PORT: '8080',
        NEXT_PUBLIC_BASE_URL: 'https://example.com',
        // fnox is the source of truth, so app values win — but blanks and Railway/system keys never push.
        EMPTY_PLACEHOLDER: '',
        UNRESOLVED: undefined,
        CI: 'true',
        RAILWAY_PROJECT_ID: 'proj-1',
        RAILWAY_SERVICE_ID: 'svc-1',
        NIXPACKS_NODE_VERSION: '24',
        WB_ENV: 'production',
      })
    ).toEqual([
      ['DATABASE_URL', 'file:/data/app.sqlite'],
      ['DISCORD_BOT_TOKEN', 'secret'],
      ['NEXT_PUBLIC_BASE_URL', 'https://example.com'],
      ['PORT', '8080'],
      ['WB_ENV', 'production'],
    ]);
  });

  it('returns nothing when every value is empty, missing, or Railway-managed', () => {
    expect(
      selectRailwayVariables({ EMPTY: '', MISSING: undefined, RAILWAY_ENVIRONMENT: 'production', CI: '1' })
    ).toEqual([]);
  });
});
