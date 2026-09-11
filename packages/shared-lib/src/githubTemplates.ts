/**
 * A section of a PR or issue body: its heading and what the section must state. `requirement`
 * starts lowercase and ends without punctuation, so that it reads both as a placeholder sentence
 * (capitalized, with a period appended) and as a checklist clause after the heading.
 */
export interface TemplateSection {
  readonly heading: string;
  readonly requirement: string;
}

/** Sections of a pull request body, in the order they appear in the PR template. */
export const PULL_REQUEST_SECTIONS: readonly TemplateSection[] = [
  {
    heading: 'Why',
    requirement: 'the problem, with the numbers or observations behind it, and why this approach over the alternatives',
  },
  {
    heading: 'Requirements',
    requirement:
      "the requirements the change must satisfy and the guarantees it must keep, one per line, each marked `required` (asked for by the requester, or an existing contract callers depend on) or `chosen` (the implementer's own decision, which a simpler design may replace); copy the requester's instructions here as given, whether they came from an issue or a conversation, and keep the list when the body is later rewritten unless the requester's instructions changed",
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

/**
 * How a tool that writes or rewrites a PR body derives it from the repository's PR template, as
 * markdown bullets for an agent's instructions. Stated once here and rendered by every writer (the
 * generated agent instructions, the PR-drafting skills) so the writers cannot drift apart; the
 * template-less branch lets the same text serve repositories outside the organization.
 */
const PULL_REQUEST_TEMPLATE_RULES = `- Base the PR body on \`.github/pull_request_template.md\` when creating or updating a PR, even when a skill or workflow supplies its own skeleton: keep the template's headings in order, fill each section with what its placeholder comment asks for at a length fitting the change (a sentence for a small change, numbered subsections for a large one), and delete the placeholder comments and an empty Notes section. Without a template, use no fixed headings: state the scope, the motivation, and the verification concisely.
- Start the body with \`Close #<n>\` only when the PR resolves an existing issue.`;

/**
 * How a tool that writes or rewrites a PR body fills the Requirements section of
 * `PULL_REQUEST_SECTIONS`, as markdown bullets for an agent's instructions. Skills that draft PR
 * bodies render this text instead of restating it, so the writers and the reviewers that read the
 * section as the boundary a fix must keep never disagree on what a line means.
 */
export const PULL_REQUEST_REQUIREMENTS_RULES = `- Requirements section: one line per requirement, taken from the requester's instructions as they were given (the issue, the conversation that asked for the change), each marked \`required\` (asked for, or an existing contract callers depend on) or \`chosen\` (your own decision, which a simpler design may replace). Never infer a requirement from the diff: when no issue, PR message, or conversation states the request, write \`required: not recorded — ask the requester\` as the only request-derived line (a \`required\` line for an existing contract callers depend on may still be listed) and say so in Notes.
- Record rule: an existing Requirements section is a record, not a description of the diff. Keep its \`required\` lines as they are, rewriting them only when the requester's instructions changed (then from the updated instructions, dropping a line only when the requester removed it; with no instructions available, keep them unchanged); add a \`chosen\` line for a new decision, and replace or remove one when the decision it records changed. A section that merely describes the implementation, or holds only the template's placeholder or a \`required: not recorded\` line, is not a record: write it afresh by the rule above.
- Place the section where the template puts it; when the template has no such heading, right after the issue-closing line, or at the top of the body when there is none.
- Never drop or weaken a \`required\` line to fit what was implemented: when one cannot hold in the diff, keep it and say so in Notes.`;

/** The complete rules for writing a PR body: the template rules followed by the Requirements rules. */
export const PULL_REQUEST_BODY_RULES = `${PULL_REQUEST_TEMPLATE_RULES}\n${PULL_REQUEST_REQUIREMENTS_RULES}`;

/**
 * How a tool that creates an issue derives it from the repository's issue templates, as markdown
 * bullets for an agent's instructions; shared by the same writers as `PULL_REQUEST_BODY_RULES`.
 * Guidance the templates state in their own placeholder comments (which sections to keep, deleting
 * the comments) is deliberately not repeated here, since the writer reads the template anyway.
 */
export const ISSUE_TEMPLATE_RULES = `- Follow the closest template under \`.github/ISSUE_TEMPLATE/\`: \`bug.md\` for wrong behavior, \`change.md\` for anything to build or alter; a question or note fitting neither, or a repository without templates, needs no template.
- Title: a Conventional Commits prefix for the type that fits the change (\`feat:\`, \`fix:\`, \`refactor:\`, \`docs:\`, \`chore:\`, ...); when it differs from the template's \`title\` prefix, replace the template's type label (\`t: ...\`) with the one matching the type.
- The YAML front matter between the \`---\` lines is metadata, not body text: pass its \`labels\` via \`--label\` and submit only the content below the closing \`---\` as the body.`;

/** Sections of a bug report, in the order they appear in the issue template. */
export const BUG_ISSUE_SECTIONS: readonly TemplateSection[] = [
  { heading: 'Problem', requirement: 'what happens, and what should happen instead' },
  { heading: 'Evidence', requirement: 'reproduction steps, logs, run IDs, or links' },
  { heading: 'Impact', requirement: 'who or what is affected, and how badly' },
  { heading: 'Proposal', requirement: 'the fix you have in mind, and the root cause if known' },
];

/**
 * Sections a change specification must settle before a third party can implement it, defined
 * once so that the issue template and any tool that drafts or reviews specifications against
 * these sections cannot drift apart; checklist consumers render it with `renderSectionChecklist`.
 * The first three sections suffice for a small change, so they come first.
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
