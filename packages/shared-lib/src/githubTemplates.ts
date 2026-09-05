/** A section of a PR or issue body: its heading and what the section must state. */
export interface TemplateSection {
  heading: string;
  requirement: string;
}

/** Sections of a pull request body, in the order they appear in the PR template. */
export const PULL_REQUEST_SECTIONS: readonly TemplateSection[] = [
  {
    heading: 'Why',
    requirement: 'the problem, with the numbers or observations behind it, and why this approach over the alternatives',
  },
  {
    heading: 'Customer Summary',
    requirement:
      'behavior, workflow, or user-visible changes, written for readers who know nothing about the implementation',
  },
  {
    heading: 'Technical Summary',
    requirement:
      'decisions and their reasons, data flow, where to look (the files that matter most), and what to check hardest: the parts whose correctness is argued rather than proven',
  },
  {
    heading: 'Testing',
    requirement: 'commands run, tests added, and what was NOT exercised and why',
  },
  {
    heading: 'Notes',
    requirement: 'known limitations, compatibility and migration, follow-up work; delete this section if there is none',
  },
];

/** Sections of a bug report, in the order they appear in the issue template. */
export const BUG_ISSUE_SECTIONS: readonly TemplateSection[] = [
  { heading: 'Problem', requirement: 'what happens, and what should happen instead' },
  { heading: 'Evidence', requirement: 'reproduction steps, logs, run IDs, or links' },
  { heading: 'Impact', requirement: 'who or what is affected, and how badly' },
  { heading: 'Proposal', requirement: 'the fix you have in mind, and the root cause if known' },
];

/**
 * Sections a change specification must settle before a third party can implement it. The
 * issue template, the spec-booster drafting template, and the spec reviewers' checklist are all
 * rendered from this one list. The first three sections suffice for a small change, so they
 * come first.
 */
export const CHANGE_ISSUE_SECTIONS: readonly TemplateSection[] = [
  {
    heading: 'Background and goal',
    requirement: 'the problem being solved, for whom, and what outcome counts as success',
  },
  {
    heading: 'Behavior',
    requirement:
      'every user- or caller-observable behavior, including inputs, outputs, error cases, edge cases, and interactions with existing behavior, stated precisely enough that two implementers would build the same thing',
  },
  {
    heading: 'Acceptance criteria',
    requirement:
      'checkable conditions (Given/When/Then or an equivalent) that decide whether the implementation is done',
  },
  {
    heading: 'Scope and non-goals',
    requirement: 'what the change covers and what it deliberately leaves out, so an implementer knows where to stop',
  },
  {
    heading: 'Design constraints',
    requirement:
      'the data, API, schema, UI, and configuration changes, naming, and the existing code or conventions the implementation must fit — as far as the writer intends to constrain them, with everything else explicitly left to the implementer',
  },
  {
    heading: 'Compatibility and migration',
    requirement: 'what existing data, users, callers, or configurations are affected and how the transition happens',
  },
  {
    heading: 'Verification',
    requirement: 'how the change is tested or demonstrated, including what needs no test and why',
  },
  {
    heading: 'Open questions',
    requirement: 'undecided points, each with its options; empty once the specification is implementable',
  },
];

/** Renders sections as markdown bullets (`- **Heading**: requirement`). */
export function renderSectionChecklist(sections: readonly TemplateSection[]): string {
  return sections.map((section) => `- **${section.heading}**: ${section.requirement}`).join('\n');
}

/** Renders sections as markdown headings, each followed by its requirement as a placeholder comment. */
export function renderSectionTemplate(sections: readonly TemplateSection[]): string {
  return sections
    .map(
      (section) =>
        `## ${section.heading}\n\n<!-- ${section.requirement.charAt(0).toUpperCase()}${section.requirement.slice(1)}. -->`
    )
    .join('\n\n');
}
