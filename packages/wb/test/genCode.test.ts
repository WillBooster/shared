import { describe, expect, it } from 'vitest';

import { getGenCodeScripts } from '../src/commands/genCode.js';
import type { Project } from '../src/project.js';

describe('getGenCodeScripts', () => {
  it('runs gen-i18n-ts through wb gen-code when the project defines the script', () => {
    const project = {
      hasDrizzle: false,
      hasOwnDependency: (packageName: string) => packageName === 'gen-i18n-ts',
      hasPrisma: false,
      packageJson: {
        scripts: {
          'gen-i18n-ts': 'gen-i18n-ts -i i18n -o src/__generated__/i18n.ts -d ja-JP',
        },
      },
    } as Project;

    expect(getGenCodeScripts(project)).toEqual(['YARN run gen-i18n-ts']);
  });
});
