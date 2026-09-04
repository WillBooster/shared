import os from 'node:os';
import path from 'node:path';

import merge from 'deepmerge';
import { z } from 'zod';

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

const claudeSettingsFilePath = '.claude/settings.json';

/**
 * Claude Code injects its own attribution directive (a `Co-Authored-By` trailer, a "Generated with"
 * footer, and a session link) into the tool descriptions and mid-session reminders, and that
 * directive declares itself to replace earlier guidance, so the instruction file alone cannot
 * suppress it. Only this setting removes the directive at its source.
 */
const claudeSettings = {
  attribution: {
    commit: '',
    pr: '',
    sessionUrl: false,
  },
};

/**
 * Overwrites the user-level instruction files of every supported agent with the fixed content and
 * merges the fixed settings into Claude Code's user settings. Returns false when any file was
 * skipped (e.g. a symlinked or unparsable file), so the command can fail loudly.
 */
export async function generateUserAgentConfigs(): Promise<boolean> {
  let hasWrittenAll = true;
  for (const relativePath of userAgentInstructionFilePaths) {
    const hasWritten = await fsUtil.generateFile(path.join(os.homedir(), relativePath), userAgentInstructionContent);
    hasWrittenAll &&= hasWritten;
  }
  // Awaited separately: `&&=` would skip the merge once an instruction file was skipped.
  const hasMergedSettings = await mergeClaudeSettings();
  return hasWrittenAll && hasMergedSettings;
}

async function mergeClaudeSettings(): Promise<boolean> {
  const filePath = path.join(os.homedir(), claudeSettingsFilePath);
  const existingContent = await fsUtil.readFileIfExists(filePath);
  let existingSettings: Record<string, unknown> = {};
  if (existingContent !== undefined) {
    try {
      existingSettings = z.record(z.string(), z.unknown()).parse(JSON.parse(existingContent));
    } catch {
      console.warn(`Skipped updating ${filePath} because the existing content is not a JSON object.`);
      return false;
    }
  }
  const settings = merge(existingSettings, claudeSettings);
  return await fsUtil.generateFile(filePath, JSON.stringify(settings, undefined, 2));
}
