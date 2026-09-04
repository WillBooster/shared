import os from 'node:os';
import path from 'node:path';

import { fsUtil } from '../utils/fsUtil.js';

/**
 * The user-level instruction file of each supported agent, relative to the home directory. These
 * apply to every repository the agent works in, so they hold only the conventions that are true on
 * every WillBooster developer machine rather than in a particular repository.
 */
const userAgentInstructionFilePaths = ['.codex/AGENTS.md', '.claude/CLAUDE.md', '.gemini/GEMINI.md'] as const;

const userAgentInstructionContent = `- Repos live under \`~/ghq/github.com\`; always clone with \`ghq get -p\`, never \`git clone\`.
- LLM/AI agent responses may take 1–2 hours; wait patiently, don't assume failure.
- No AI attribution (e.g., \`Co-Authored-By\` trailers, "Generated with ..." footers) in commits, issues, or PRs unless explicitly requested. This hides nothing: if asked which AI agent did the work, answer truthfully.
`;

/** Overwrites the user-level instruction files of every supported agent with the fixed content. */
export async function generateUserAgentInstructions(): Promise<void> {
  for (const relativePath of userAgentInstructionFilePaths) {
    await fsUtil.generateFile(path.join(os.homedir(), relativePath), userAgentInstructionContent);
  }
}
