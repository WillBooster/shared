import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { fixChakraToaster } from '../../src/fixers/chakraToaster.js';
import { fsUtil } from '../../src/utils/fsUtil.js';
import { createConfig } from '../helpers/testConfig.js';

test('makes the Chakra toaster inferred type portable under Bun isolated installs', async () => {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-chakra-toaster-'));
  const filePath = path.join(dirPath, 'src', 'components', 'ui', 'toaster.tsx');
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      `import { createToaster } from '@chakra-ui/react';

export const toaster = createToaster({ placement: 'bottom-end' });
`
    );
    fsUtil.setRootDirPath(dirPath);

    await fixChakraToaster(createConfig({ dirPath, depending: { ...createConfig().depending, chakra: true } }));
    await fixChakraToaster(createConfig({ dirPath, depending: { ...createConfig().depending, chakra: true } }));

    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(`import { createToaster } from '@chakra-ui/react';
import type { CreateToasterReturn } from '@chakra-ui/react';

export const toaster: CreateToasterReturn = createToaster({ placement: 'bottom-end' });
`);
  } finally {
    fsUtil.setRootDirPath(undefined);
    await fs.rm(dirPath, { recursive: true, force: true });
  }
});
