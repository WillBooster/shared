import { expect, test } from 'bun:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { generateAgentInstructions } from '../../src/generators/agents.js';
import { getPackageConfig } from '../../src/packageConfig.js';
import { fsUtil } from '../../src/utils/fsUtil.js';
import { createConfig } from '../helpers/testConfig.js';

test('uses the repository directory name before the first package.json is generated', async () => {
  const tempRootPath = path.join(process.cwd(), '.tmp');
  await fs.promises.mkdir(tempRootPath, { recursive: true });
  const dirPath = await fs.promises.mkdtemp(path.join(tempRootPath, 'docs-only-project-'));

  try {
    fsUtil.setRootDirPath(dirPath);
    await fs.promises.writeFile(path.join(dirPath, 'CLAUDE.md'), 'old');
    await fs.promises.writeFile(path.join(dirPath, 'GEMINI.md'), 'old');
    await fs.promises.mkdir(path.join(dirPath, '.cursor/rules'), { recursive: true });
    await fs.promises.writeFile(path.join(dirPath, '.cursor/rules/general.mdc'), 'old');
    const config = createConfig({ dirPath, isRoot: true, doesContainPackageJson: false, packageJson: {} });
    await generateAgentInstructions(config, [config]);

    const content = await fs.promises.readFile(path.join(dirPath, 'AGENTS.md'), 'utf8');
    expect(content).toContain(`- Name: \`${path.basename(dirPath)}\``);
    expect(content).not.toContain('- Name: `unknown`');
    expect(fs.existsSync(path.join(dirPath, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(dirPath, 'GEMINI.md'))).toBe(false);
    expect(fs.existsSync(path.join(dirPath, '.cursor/rules/general.mdc'))).toBe(false);
  } finally {
    fsUtil.setRootDirPath(undefined);
    await fs.promises.rm(dirPath, { force: true, recursive: true });
  }
});

test('describes wb deploy only when the package script invokes it', async () => {
  const tempRootPath = path.join(process.cwd(), '.tmp');
  await fs.promises.mkdir(tempRootPath, { recursive: true });
  const dirPath = await fs.promises.mkdtemp(path.join(tempRootPath, 'agent-instructions-'));
  const expectedSentence = 'The `deploy` package script runs `wb deploy`.';
  const invokingScripts: [string, Record<string, string>?][] = [
    ['bun wb deploy -w packages/api'],
    ['echo preparing # comment\nbun wb deploy'],
    ['(bun wb deploy)'],
    ['env WB_ENV=production bun wb deploy'],
    ['env -C packages/api bun wb deploy'],
    ['npm exec -- wb deploy'],
    ['bun x wb deploy'],
    ['cd packages/api && wb deploy'],
    ['pnpm --filter api exec wb deploy'],
    ['if [ -n "$CI" ]; then bun wb deploy; fi'],
  ];
  const nonInvokingScripts: [string, Record<string, string>?][] = [
    ['echo "wb deploy"'],
    ['echo prep # wb deploy'],
    ['wb prisma deploy'],
    ['npm run wb deploy'],
    ['bun run wb -- deploy'],
    ['command -v wb deploy'],
    ['npx -p wb deploy'],
    ["cat <<'EOF'\nwb deploy\nEOF"],
    ['bun dlx wb deploy'],
    ['bun wb deploy', { wb: 'node scripts/wb.js' }],
    ['yarn dlx wb deploy', { dlx: 'echo shadowed' }],
    ['unused() { wb deploy; }; echo ready'],
  ];

  try {
    fsUtil.setRootDirPath(dirPath);
    for (const [deployScript, additionalScripts = {}] of invokingScripts) {
      const config = createConfig({
        dirPath,
        isRoot: true,
        doesContainWranglerConfig: true,
        packageJson: { name: 'example', scripts: { deploy: deployScript, ...additionalScripts } },
      });
      await generateAgentInstructions(config, [config]);
      expect(await fs.promises.readFile(path.join(dirPath, 'AGENTS.md'), 'utf8'), deployScript).toContain(
        expectedSentence
      );
    }

    for (const [deployScript, additionalScripts = {}] of nonInvokingScripts) {
      const config = createConfig({
        dirPath,
        isRoot: true,
        doesContainWranglerConfig: true,
        packageJson: { name: 'example', scripts: { deploy: deployScript, ...additionalScripts } },
      });
      await generateAgentInstructions(config, [config]);
      expect(await fs.promises.readFile(path.join(dirPath, 'AGENTS.md'), 'utf8'), deployScript).not.toContain(
        expectedSentence
      );
    }
  } finally {
    fsUtil.setRootDirPath(undefined);
    await fs.promises.rm(dirPath, { force: true, recursive: true });
  }
});

test('lists the purpose and goals from wbfy.yaml under Project Information', async () => {
  const tempRootPath = path.join(process.cwd(), '.tmp');
  await fs.promises.mkdir(tempRootPath, { recursive: true });
  const dirPath = await fs.promises.mkdtemp(path.join(tempRootPath, 'wbfy-config-'));

  try {
    fsUtil.setRootDirPath(dirPath);
    await fs.promises.writeFile(path.join(dirPath, 'package.json'), '{ "name": "example" }');
    await fs.promises.writeFile(
      path.join(dirPath, 'wbfy.yaml'),
      'purpose: Make reviews faster\ngoals:\n  - Review within an hour\n  - Keep false positives rare\n'
    );
    const config = await getPackageConfig(dirPath, { isRoot: true });
    assert.ok(config);
    await generateAgentInstructions(config, [config]);

    expect(await fs.promises.readFile(path.join(dirPath, 'AGENTS.md'), 'utf8')).toContain(
      `- Package Manager: bun
- Purpose: Make reviews faster
- Goals:
  - Review within an hour
  - Keep false positives rare
- This codebase is yours: how it's built is your call, and you'll keep building on it; what it's for is set by the purpose and goals above and the requester.

## General Instructions`
    );
  } finally {
    fsUtil.setRootDirPath(undefined);
    await fs.promises.rm(dirPath, { force: true, recursive: true });
  }
});

test.each([
  ['a multi-line value', 'purpose: |\n  Line one\n  ## Line two\n'],
  ['an unknown key', 'goal:\n  - Review within an hour\n'],
  ['an empty list', 'goals: []\n'],
  ['broken YAML', 'purpose: Make reviews faster: always\n'],
])(
  'stops before changing anything when wbfy.yaml has %s',
  async (_name, wbfyYaml) => {
    const tempRootPath = path.join(process.cwd(), '.tmp');
    await fs.promises.mkdir(tempRootPath, { recursive: true });
    const dirPath = await fs.promises.mkdtemp(path.join(tempRootPath, 'invalid-wbfy-config-'));

    try {
      await fs.promises.writeFile(path.join(dirPath, 'package.json'), '{ "name": "example" }');
      await fs.promises.writeFile(path.join(dirPath, 'wbfy.yaml'), wbfyYaml);
      const spawned = Bun.spawn(['bun', path.join(import.meta.dir, '../../src/index.ts'), dirPath], {
        stderr: 'pipe',
        stdout: 'pipe',
      });
      const [exitCode, stderr] = await Promise.all([spawned.exited, new Response(spawned.stderr).text()]);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('wbfy.yaml is invalid');
      expect(fs.existsSync(path.join(dirPath, 'AGENTS.md'))).toBe(false);
    } finally {
      await fs.promises.rm(dirPath, { force: true, recursive: true });
    }
  },
  60_000
);
