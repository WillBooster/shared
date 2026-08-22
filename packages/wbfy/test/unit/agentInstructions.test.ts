import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { generateAgentInstructions } from '../../src/generators/agents.js';
import { fsUtil } from '../../src/utils/fsUtil.js';
import { promisePool } from '../../src/utils/promisePool.js';
import { createConfig } from '../helpers/testConfig.js';

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
      await promisePool.promiseAll();
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
      await promisePool.promiseAll();
      expect(await fs.promises.readFile(path.join(dirPath, 'AGENTS.md'), 'utf8'), deployScript).not.toContain(
        expectedSentence
      );
    }
  } finally {
    fsUtil.setRootDirPath(undefined);
    await fs.promises.rm(dirPath, { force: true, recursive: true });
  }
});
