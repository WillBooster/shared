import path from 'node:path';

// The `/src` entry (a declared export) lets this workspace consumer use the sources without
// building shared-lib first, as every other import of it in this package does.
import {
  BUG_ISSUE_SECTIONS,
  CHANGE_ISSUE_SECTIONS,
  PULL_REQUEST_SECTIONS,
  renderSectionTemplate,
} from '@willbooster/shared-lib/src';

import { getDefaultProseLanguage } from '../generators/agents.js';
import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

const generateTemplates = (languageNote: string): Record<string, string> => ({
  'pull_request_template.md': `
Close #<IssueNumber>

<!-- Write for a reviewer who has not followed the work.${languageNote} Scale each section to the change: a sentence for a small change, numbered subsections for a large one. Delete this comment and the placeholder comments below. -->

${renderSectionTemplate(PULL_REQUEST_SECTIONS)}
`.trim(),
  'ISSUE_TEMPLATE/bug.md': `
---
name: Bug / Problem
about: Something behaves wrongly
title: 'fix: '
labels: 't: fix :bug:'
---

<!-- Keep Problem and Proposal; delete Evidence or Impact when they add nothing.${languageNote} Delete these comments. -->

${renderSectionTemplate(BUG_ISSUE_SECTIONS)}
`.trim(),
  'ISSUE_TEMPLATE/change.md': `
---
name: Change / Feature
about: Propose a change that a third party could implement without asking a question
title: 'feat: '
labels: 't: feat :sparkles:'
---

<!-- Keep the first three sections for any change and add the others as the change grows; a large change fills all of them (spec-booster reviews against this list).${languageNote} Delete these comments. -->

${renderSectionTemplate(CHANGE_ISSUE_SECTIONS)}
`.trim(),
  'ISSUE_TEMPLATE/config.yml': 'blank_issues_enabled: true',
});

export async function generateGitHubTemplates(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateGitHubTemplates', async () => {
    // Templates are repository-level files, so a direct workspace-child invocation must not create them.
    if (!config.isWillBoosterRepo || !config.isRoot) {
      return;
    }

    const languageNote =
      getDefaultProseLanguage(config) === 'Japanese' ? ' Write in Japanese, keeping the headings as they are.' : '';
    await Promise.all(
      Object.entries(generateTemplates(languageNote)).map(([fileName, content]) => {
        const filePath = path.resolve(config.dirPath, '.github', fileName);
        return promisePool.runAndWaitForReturnValue(() => fsUtil.generateFile(filePath, content));
      })
    );
  });
}
