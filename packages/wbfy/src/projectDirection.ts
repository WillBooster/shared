import path from 'node:path';

import * as yaml from 'js-yaml';
import { z } from 'zod';

import { matchFrontMatter } from './utils/frontMatter.js';
import { fsUtil } from './utils/fsUtil.js';

// A value that states nothing (no value, blank text, an empty list, a blank item) is accepted and
// rendered as absent: only text that would otherwise be dropped unnoticed makes the front matter invalid.
const textSchema = z.string().trim().nullish();
const listSchema = z.array(textSchema).transform((items) => items.filter(Boolean) as string[]);

const projectDirectionSchema = z.strictObject({
  purpose: textSchema,
  goals: listSchema.nullish(),
  nonGoals: listSchema.nullish(),
  milestones: listSchema.nullish(),
});

export type ProjectDirection = z.infer<typeof projectDirectionSchema>;

/** Throws when the front matter of `README.md` is invalid, which the CLI reports before changing anything. */
export async function readProjectDirection(rootDirPath: string): Promise<ProjectDirection> {
  const readme = await fsUtil.readFileConfinedIfExists(path.resolve(rootDirPath, 'README.md'));
  const frontMatter = matchFrontMatter(readme?.replace(/^﻿/u, '') ?? '');
  // js-yaml throws on a body that holds no document, which states nothing rather than something invalid.
  if (!frontMatter || /^(?:\s*(?:#.*)?(?:\r?\n|$))*$/u.test(frontMatter.body)) return {};
  try {
    return projectDirectionSchema.parse(yaml.load(frontMatter.body) ?? {});
  } catch (error) {
    throw new Error(`The front matter of README.md is invalid: ${String(error)}`, { cause: error });
  }
}
