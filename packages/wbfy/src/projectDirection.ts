import path from 'node:path';

import type { RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';

import { fsUtil } from './utils/fsUtil.js';

const sectionBodyTypes = { Purpose: 'paragraph', Goals: 'list', 'Non-goals': 'list', Milestones: 'list' } as const;

type SectionTitle = keyof typeof sectionBodyTypes;

/** The Markdown source of each section body, keyed by the section's `##` heading text in `README.md`. */
export type ProjectDirection = Partial<Record<SectionTitle, string>>;

export const projectDirectionTitles = Object.keys(sectionBodyTypes) as SectionTitle[];

/** Throws when a section is not exactly one paragraph or list, which the CLI reports before changing anything. */
export async function readProjectDirection(rootDirPath: string): Promise<ProjectDirection> {
  const readme = await fsUtil.readFileConfinedIfExists(path.resolve(rootDirPath, 'README.md'));
  if (readme === undefined) return {};

  const direction: ProjectDirection = {};
  const nodes = fromMarkdown(readme).children;
  for (const [index, node] of nodes.entries()) {
    const title = getSectionTitle(node);
    if (!title) continue;
    if (title in direction) throw new Error(`README.md has more than one \`## ${title}\` section.`);

    const bodyType = sectionBodyTypes[title];
    const body = nodes[index + 1];
    const following = nodes[index + 2];
    if (body?.type !== bodyType || (following && following.type !== 'heading')) {
      throw new Error(`The \`## ${title}\` section of README.md must consist of exactly one ${bodyType}.`);
    }
    direction[title] = readme.slice(body.position?.start.offset, body.position?.end.offset);
  }
  return direction;
}

function getSectionTitle(node: RootContent): SectionTitle | undefined {
  if (node.type !== 'heading' || node.depth !== 2 || node.children.length !== 1) return undefined;
  const [child] = node.children;
  return child?.type === 'text' && child.value in sectionBodyTypes ? (child.value as SectionTitle) : undefined;
}
