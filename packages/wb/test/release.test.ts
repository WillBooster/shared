import { describe, expect, it } from 'vitest';

import { buildHoistedBunfig, restoreWorkspaceRanges, rewriteWorkspaceRanges } from '../src/commands/release.js';

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

  it('leaves non-dependency strings starting with workspace: untouched', () => {
    const packageJson = `{
  "description": "workspace: utilities",
  "dependencies": { "@willbooster/shared-lib": "workspace:*" }
}`;
    expect(rewriteWorkspaceRanges(packageJson)).toBe(`{
  "description": "workspace: utilities",
  "dependencies": { "@willbooster/shared-lib": "*" }
}`);
  });
});

describe('restoreWorkspaceRanges', () => {
  it('restores workspace: specifiers into content changed during the release (e.g. a version bump)', () => {
    const original = `{
  "version": "1.0.0",
  "dependencies": { "@willbooster/shared-lib": "workspace:^1.0.0" }
}`;
    const currentAfterRelease = `{
  "version": "1.1.0",
  "dependencies": { "@willbooster/shared-lib": "*" }
}`;
    expect(restoreWorkspaceRanges(currentAfterRelease, original)).toBe(`{
  "version": "1.1.0",
  "dependencies": { "@willbooster/shared-lib": "workspace:^1.0.0" }
}`);
  });

  it('restores specifiers multi-semantic-release overwrote with concrete versions', () => {
    // multi-semantic-release's prepare step overwrites local dependency specifiers (e.g. the
    // temporary "*" becomes "^1.1.0"); the committed manifest must still get workspace: back.
    const original = `{
  "version": "1.0.0",
  "dependencies": { "@willbooster/shared-lib": "workspace:^1.0.0" }
}`;
    const currentAfterRelease = `{
  "version": "1.1.0",
  "dependencies": { "@willbooster/shared-lib": "^1.1.0" }
}`;
    expect(restoreWorkspaceRanges(currentAfterRelease, original)).toBe(`{
  "version": "1.1.0",
  "dependencies": { "@willbooster/shared-lib": "workspace:^1.0.0" }
}`);
  });

  it('leaves same-named keys outside dependency sections untouched', () => {
    const original = `{
  "dependencies": { "foo": "workspace:*" },
  "overrides": { "foo": "*" }
}`;
    const currentAfterRelease = `{
  "dependencies": { "foo": "*" },
  "overrides": { "foo": "*" }
}`;
    expect(restoreWorkspaceRanges(currentAfterRelease, original)).toBe(`{
  "dependencies": { "foo": "workspace:*" },
  "overrides": { "foo": "*" }
}`);
  });
});
