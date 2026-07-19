import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { PackageJson } from 'type-fest';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCredentialFreeEnv,
  buildHoistedBunfig,
  releasePublishesToNpm,
  restoreWorkspaceRanges,
  rewriteWorkspaceRanges,
} from '../src/commands/release.js';

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

describe('buildCredentialFreeEnv', () => {
  it('empties credential variables and keeps the rest', () => {
    const env = {
      GH_TOKEN: 'gh',
      GITHUB_TOKEN: 'github',
      NPM_TOKEN: 'npm',
      PATH: '/usr/bin',
      VERDACCIO_TOKEN: 'secret',
      WB_ENV: 'production',
    };
    const scrubbedEnv = buildCredentialFreeEnv(env);
    // Emptied (not deleted) so `${VERDACCIO_TOKEN}` references in .npmrc expand to ''.
    expect(scrubbedEnv).toEqual({
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      NPM_TOKEN: '',
      PATH: '/usr/bin',
      VERDACCIO_TOKEN: '',
      WB_ENV: 'production',
    });
    expect(env.VERDACCIO_TOKEN).toBe('secret');
  });
});

describe('releasePublishesToNpm', () => {
  const temporaryDirPaths: string[] = [];

  afterEach(async () => {
    for (const dirPath of temporaryDirPaths.splice(0)) {
      await fs.promises.rm(dirPath, { recursive: true, force: true });
    }
  });

  async function createProject(files: Record<string, object>): Promise<{ dirPath: string; packageJson: PackageJson }> {
    const dirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wb-release-test-'));
    temporaryDirPaths.push(dirPath);
    for (const [relativePath, content] of Object.entries(files)) {
      const filePath = path.join(dirPath, relativePath);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, JSON.stringify(content), 'utf8');
    }
    const packageJson = JSON.parse(
      await fs.promises.readFile(path.join(dirPath, 'package.json'), 'utf8')
    ) as PackageJson;
    return { dirPath, packageJson };
  }

  it('keeps the npm preparation when no plugin list is configured (default plugins include npm)', async () => {
    const project = await createProject({ 'package.json': { name: 'app' } });
    await expect(releasePublishesToNpm(project)).resolves.toBe(true);
  });

  it('skips when .releaserc.json explicitly configures plugins without @semantic-release/npm', async () => {
    const project = await createProject({
      'package.json': { name: 'app' },
      '.releaserc.json': {
        plugins: ['@semantic-release/commit-analyzer', ['@semantic-release/github', { successComment: false }]],
      },
    });
    await expect(releasePublishesToNpm(project)).resolves.toBe(false);
  });

  it('keeps the npm preparation when the plugin list includes @semantic-release/npm in tuple form', async () => {
    const project = await createProject({
      'package.json': { name: 'app' },
      '.releaserc.json': {
        plugins: ['@semantic-release/commit-analyzer', ['@semantic-release/npm', { npmPublish: true }]],
      },
    });
    await expect(releasePublishesToNpm(project)).resolves.toBe(true);
  });

  it('reads the plugin list from package.json#release', async () => {
    const project = await createProject({
      'package.json': { name: 'app', release: { plugins: ['@semantic-release/github'] } },
    });
    await expect(releasePublishesToNpm(project)).resolves.toBe(false);
  });

  it('lets an explicit plugin list win over an extends preset', async () => {
    const project = await createProject({
      'package.json': { name: 'app' },
      '.releaserc.json': { extends: 'some-shared-config', plugins: ['@semantic-release/github'] },
    });
    // `plugins` is explicit, so it wins over the preset per semantic-release's option merging.
    await expect(releasePublishesToNpm(project)).resolves.toBe(false);
  });

  it('keeps the npm preparation for an extends preset without an explicit plugin list', async () => {
    const project = await createProject({
      'package.json': { name: 'app' },
      '.releaserc.json': { extends: 'some-shared-config' },
    });
    await expect(releasePublishesToNpm(project)).resolves.toBe(true);
  });

  it('keeps the npm preparation when a non-JSON configuration file exists', async () => {
    const project = await createProject({ 'package.json': { name: 'app' } });
    await fs.promises.writeFile(path.join(project.dirPath, 'release.config.js'), 'module.exports = {};', 'utf8');
    await expect(releasePublishesToNpm(project)).resolves.toBe(true);
  });

  it('keeps the npm preparation when a workspace package configures @semantic-release/npm', async () => {
    const project = await createProject({
      'package.json': { name: 'root', workspaces: ['packages/*'] },
      '.releaserc.json': { plugins: ['@semantic-release/github'] },
      'packages/app/package.json': { name: 'app' },
      'packages/lib/package.json': { name: 'lib' },
      'packages/lib/.releaserc.json': { plugins: ['@semantic-release/npm'] },
    });
    await expect(releasePublishesToNpm(project)).resolves.toBe(true);
  });

  it('sees a pinned workspace (positive kept despite a matching negation) like Bun does', async () => {
    // globby dropped the pinned packages/lib entirely (issue #1008); Bun keeps it, so its
    // npm-configuring .releaserc.json must trigger the npm preparation.
    const project = await createProject({
      'package.json': { name: 'root', workspaces: ['packages/lib', '!packages/lib'] },
      '.releaserc.json': { plugins: ['@semantic-release/github'] },
      'packages/lib/package.json': { name: 'lib' },
      'packages/lib/.releaserc.json': { plugins: ['@semantic-release/npm'] },
    });
    await expect(releasePublishesToNpm(project)).resolves.toBe(true);
  });

  it('sees workspaces linked by a baseline-seeding negation like Bun does', async () => {
    // `!other/*` seeds Bun's implicit `*/*` baseline, so packages/lib is a workspace even though
    // no positive pattern is declared (issue #1008).
    const project = await createProject({
      'package.json': { name: 'root', workspaces: ['!other/*'] },
      '.releaserc.json': { plugins: ['@semantic-release/github'] },
      'other/x/package.json': { name: 'x' },
      'other/x/.releaserc.json': { plugins: ['@semantic-release/npm'] },
      'packages/lib/package.json': { name: 'lib' },
      'packages/lib/.releaserc.json': { plugins: ['@semantic-release/npm'] },
    });
    await expect(releasePublishesToNpm(project)).resolves.toBe(true);
    // …and the negated other/x alone must NOT trigger it: it is not a workspace to Bun.
    const negatedOnlyProject = await createProject({
      'package.json': { name: 'root', workspaces: ['!other/*'] },
      '.releaserc.json': { plugins: ['@semantic-release/github'] },
      'other/x/package.json': { name: 'x' },
      'other/x/.releaserc.json': { plugins: ['@semantic-release/npm'] },
    });
    await expect(releasePublishesToNpm(negatedOnlyProject)).resolves.toBe(false);
  });

  it('skips when the root and every workspace package configure npm-free plugins', async () => {
    const project = await createProject({
      'package.json': { name: 'root', workspaces: ['packages/*'] },
      '.releaserc.json': { plugins: ['@semantic-release/github'] },
      'packages/app/package.json': { name: 'app' },
      'packages/lib/package.json': { name: 'lib' },
      'packages/lib/.releaserc.json': { plugins: ['@semantic-release/exec'] },
    });
    await expect(releasePublishesToNpm(project)).resolves.toBe(false);
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

  it('restores each section independently for a dependency present in multiple sections', () => {
    // A peer range next to a workspace devDependency must keep its own value, and two workspace
    // ranges of the same package must each get their own specifier back.
    const original = `{
  "peerDependencies": { "@willbooster/shared-lib": ">=1.0.0" },
  "devDependencies": { "@willbooster/shared-lib": "workspace:*" }
}`;
    const currentAfterRelease = `{
  "version": "1.1.0",
  "peerDependencies": { "@willbooster/shared-lib": ">=1.0.0" },
  "devDependencies": { "@willbooster/shared-lib": "1.1.0" }
}`;
    expect(restoreWorkspaceRanges(currentAfterRelease, original)).toBe(`{
  "version": "1.1.0",
  "peerDependencies": { "@willbooster/shared-lib": ">=1.0.0" },
  "devDependencies": { "@willbooster/shared-lib": "workspace:*" }
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
