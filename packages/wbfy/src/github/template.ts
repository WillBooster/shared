import path from 'node:path';

import { logger } from '../logger.js';
import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { promisePool } from '../utils/promisePool.js';

const templates = {
  'pull_request_template.md': `
Close #<IssueNumber>

<!-- Write for a reviewer who has not followed the work. Scale each section to the change: a sentence for a small change, numbered subsections for a large one. Delete this comment and the placeholder comments below. -->

## Why

<!-- The problem, with the numbers or observations behind it, and why this approach over the alternatives. -->

## Customer Summary

<!-- Behavior, workflow, or user-visible changes, written for readers who know nothing about the implementation. -->

## Technical Summary

<!-- Decisions and their reasons, data flow, where to look (the files that matter most), and what to check hardest: the parts whose correctness is argued rather than proven. -->

## Testing

<!-- Commands run, tests added, and what was NOT exercised and why. -->

## Notes

<!-- Known limitations, compatibility and migration, follow-up work. Delete this section if there is none. -->
`.trim(),
  'ISSUE_TEMPLATE/bug.md': `
---
name: Bug / Problem
about: Something behaves wrongly
title: 'fix: '
labels: 't: fix :bug:'
---

<!-- Keep Problem and Proposal; delete Evidence or Impact when they add nothing. Delete these comments. -->

## Problem

<!-- What happens, and what should happen instead. -->

## Evidence

<!-- Reproduction steps, logs, run IDs, or links. -->

## Impact

<!-- Who or what is affected, and how badly. -->

## Proposal

<!-- The fix you have in mind, and the root cause if known. -->
`.trim(),
  // The headings mirror the spec-booster checklist in WillBooster/review-booster; only
  // "Scope and non-goals" is moved down so the three sections a small change needs stay contiguous.
  'ISSUE_TEMPLATE/change.md': `
---
name: Change / Feature
about: Propose a change that a third party could implement without asking a question
title: 'feat: '
labels: 't: feat :sparkles:'
---

<!-- Keep the first three sections for any change and add the others as the change grows; a large change fills all of them (spec-booster reviews against this list). Delete these comments. -->

## Background and goal

<!-- The problem being solved, for whom, and what outcome counts as success. -->

## Behavior

<!-- Every observable behavior: inputs, outputs, error cases, edge cases, interactions with existing behavior. -->

## Acceptance criteria

<!-- Checkable conditions that decide whether the implementation is done. -->

## Scope and non-goals

<!-- What the change covers and what it deliberately leaves out. -->

## Design constraints

<!-- Data, API, schema, UI, configuration, naming, and the existing code the implementation must fit; everything else is left to the implementer. -->

## Compatibility and migration

<!-- Existing data, users, callers, or configurations affected, and how the transition happens. -->

## Verification

<!-- How the change is tested or demonstrated, including what needs no test and why. -->

## Open questions

<!-- Undecided points, each with its options. Empty once the specification is implementable. -->
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
