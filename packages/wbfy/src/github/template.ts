import path from 'node:path';

import {
  BUG_ISSUE_SECTIONS,
  CHANGE_ISSUE_SECTIONS,
  PULL_REQUEST_SECTIONS,
  renderSectionTemplate,
} from '@willbooster/shared-lib/src';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

const templates = {
  'pull_request_template.md': `
Close #<IssueNumber>

<!-- Write for a reviewer who has not followed the work. Scale each section to the change: a sentence for a small change, numbered subsections for a large one. Delete this comment and the placeholder comments below. -->

${renderSectionTemplate(PULL_REQUEST_SECTIONS)}
`.trim(),
  'ISSUE_TEMPLATE/bug.md': `
---
name: Bug / Problem
about: Something behaves wrongly
title: 'fix: '
labels: 't: fix :bug:'
---

<!-- Keep Problem and Proposal; delete Evidence or Impact when they add nothing. Delete these comments. -->

${renderSectionTemplate(BUG_ISSUE_SECTIONS)}
`.trim(),
  'ISSUE_TEMPLATE/change.md': `
---
name: Change / Feature
about: Propose a change that a third party could implement without asking a question
title: 'feat: '
labels: 't: feat :sparkles:'
---

<!-- Keep the first three sections for any change and add the others as the change grows; a large change fills all of them (spec-booster reviews against this list). Delete these comments. -->

${renderSectionTemplate(CHANGE_ISSUE_SECTIONS)}
`.trim(),
  'ISSUE_TEMPLATE/config.yml': 'blank_issues_enabled: true',
};

export async function generateGitHubTemplates(config: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateGitHubTemplates', async () => {
    // Templates are repository-level files, so a direct workspace-child invocation must not create them.
    if (!config.isWillBoosterRepo || !config.isRoot) {
      return;
    }

    for (const [fileName, content] of Object.entries(templates)) {
      const filePath = path.resolve(config.dirPath, '.github', fileName);
      await promisePool.run(() => fsUtil.generateFile(filePath, content));
    }
  });
}
