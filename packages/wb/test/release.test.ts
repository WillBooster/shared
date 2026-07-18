import { describe, expect, it } from 'vitest';

import { buildHoistedBunfig, rewriteWorkspaceRanges } from '../src/commands/release.js';

describe('buildHoistedBunfig', () => {
  it('switches the isolated linker to hoisted and drops globalStore', () => {
    const bunfig = `[install]
exact = true
globalStore = true
linker = "isolated"
publicHoistPattern = ["tsx"]
`;
    expect(buildHoistedBunfig(bunfig)).toBe(`[install]
exact = true
linker = "hoisted"
publicHoistPattern = ["tsx"]
`);
  });

  it('keeps a hoisted bunfig unchanged', () => {
    const bunfig = `[install]\nlinker = "hoisted"\n`;
    expect(buildHoistedBunfig(bunfig)).toBe(bunfig);
  });
});

describe('rewriteWorkspaceRanges', () => {
  it('rewrites workspace: specifiers to *', () => {
    const packageJson = `{
  "dependencies": { "@willbooster/shared-lib": "workspace:*", "chalk": "5.6.2" },
  "devDependencies": { "@willbooster/wb": "workspace:^1.0.0" }
}`;
    expect(rewriteWorkspaceRanges(packageJson)).toBe(`{
  "dependencies": { "@willbooster/shared-lib": "*", "chalk": "5.6.2" },
  "devDependencies": { "@willbooster/wb": "*" }
}`);
  });
});
