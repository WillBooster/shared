import path from 'node:path';

import * as yaml from 'js-yaml';
import { z } from 'zod';

import { matchFrontMatter } from './utils/frontMatter.js';
import { fsUtil } from './utils/fsUtil.js';

const textSchema = z.string().trim().min(1);
const listSchema = z.array(textSchema).min(1);

const projectDirectionSchema = z.strictObject({
  purpose: textSchema.optional(),
  goals: listSchema.optional(),
  nonGoals: listSchema.optional(),
  milestones: listSchema.optional(),
});

export type ProjectDirection = z.infer<typeof projectDirectionSchema>;

/** Throws when the front matter of `README.md` is invalid, which the CLI reports before changing anything. */
export async function readProjectDirection(rootDirPath: string): Promise<ProjectDirection> {
  const readme = await fsUtil.readFileConfinedIfExists(path.resolve(rootDirPath, 'README.md'));
  const frontMatter = matchFrontMatter(readme?.replace(/^﻿/u, '') ?? '');
  if (!frontMatter) return {};
  try {
    return projectDirectionSchema.parse(yaml.load(frontMatter.body));
  } catch (error) {
    throw new Error(`The front matter of README.md is invalid: ${String(error)}`, { cause: error });
  }
}
