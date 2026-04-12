import fs from 'node:fs';
import path from 'node:path';

import { distance } from 'fastest-levenshtein';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

const packageManagerRunPlaceholder = '__PM_RUN__';

const templates = {
  'pull_request_template.md': `
Close #<IssueNumber>

## Self Check

- [ ] I've confirmed \`All checks have passed\` on this page.
  - PR title follows [Angular's commit message format](https://github.com/angular/angular/blob/main/CONTRIBUTING.md#-commit-message-format).
  - PR title doesn't have \`WIP:\`.
  - The test command (e.g., \`${packageManagerRunPlaceholder} test\`) passed.
  - The lint command (e.g., \`${packageManagerRunPlaceholder} lint\`) passed.
  - You may leave this box unchecked due to long workflows.
- [ ] I've reviewed my changes on the GitHub diff view.
- [ ] I've written the steps to test my changes.
- [ ] I've added screenshots (if the UI changed).
  - You may leave this box unchecked if you didn't modify the UI.

<!-- Please add screenshots if you modify the UI.
| Current                  | In coming                |
| ------------------------ | ------------------------ |
| <img src="" width="400"> | <img src="" width="400"> |
-->

<!-- Please add steps to test your changes.
## Steps to Test

1. Open http://localhost-exercode.willbooster.net:3000/ja-JP/courses/_example/lessons/_example_a_plus_b/problems/_example_a_plus_b after login.
2. Select the language \`C\`.
3. Write the following code:
   \`\`\`c
   #include <stdio.h>

   int main(void) {
     int a, b;

     scanf("%d %d", &a, &b);
     printf("%d", a + b);
     return 0;
   }
   \`\`\`
4. Push \`Submit\` button.
5. ...
-->
`.trim(),
};

export async function generateGitHubTemplates(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateGitHubTemplates', async () => {
    for (const [fileName, newContent] of Object.entries(templates)) {
      const content = applyPackageManagerTemplate(newContent, config);
      const filePath = path.resolve(config.dirPath, '.github', fileName);
      if (fs.existsSync(filePath)) {
        const oldContent = await fs.promises.readFile(filePath, 'utf8');
        if (distance(oldContent, content) > content.length / 2) {
          continue;
        }
      }

      await fs.promises.mkdir(path.resolve(config.dirPath, '.github'), { recursive: true });
      await promisePool.run(() => fsUtil.generateFile(filePath, content));
    }
  });
}

function applyPackageManagerTemplate(template: string, config: PackageConfig): string {
  const packageManagerCommand = config.isBun ? 'bun run' : 'yarn';
  return template.replaceAll(packageManagerRunPlaceholder, packageManagerCommand);
}
