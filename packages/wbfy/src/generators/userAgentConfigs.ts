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

/**
 * The user-level settings merged into each agent's JSON settings file, relative to the home
 * directory.
 *
 * Every agent that carries facts from one session into the next is turned off here because such
 * memory makes a session depend on invisible machine-local state: its behavior stops being
 * reproducible across developers and CI, and a stale or wrong memory silently overrides the
 * instruction files above. Codex needs no entry because its memories are opt-in
 * (`[features] memories = true` in `~/.codex/config.toml`), so leaving that flag unset is enough.
 */
const agentSettings = [
  {
    relativePath: '.claude/settings.json',
    /**
     * Claude Code injects its own attribution directive (a `Co-Authored-By` trailer, a "Generated
     * with" footer, and a session link) into the tool descriptions and mid-session reminders, and
     * that directive declares itself to replace earlier guidance, so the instruction file alone
     * cannot suppress it. Only this setting removes the directive at its source. Auto memory is on
     * by default, so it must be turned off explicitly.
     */
    settings: {
      attribution: {
        commit: '',
        pr: '',
        sessionUrl: false,
      },
      autoMemoryEnabled: false,
    },
  },
  {
    relativePath: '.gemini/settings.json',
    settings: {
      experimental: {
        autoMemory: false,
      },
    },
  },
] as const;

/**
 * Overwrites the user-level instruction files of every supported agent with the fixed content and
 * merges the fixed settings into each agent's user settings. Returns false when any file was
 * skipped (e.g. a symlinked or unparsable file), so the command can fail loudly.
 */
export async function generateUserAgentConfigs(): Promise<boolean> {
  let hasWrittenAll = true;
  for (const relativePath of userAgentInstructionFilePaths) {
    const hasWritten = await fsUtil.generateFile(path.join(os.homedir(), relativePath), userAgentInstructionContent);
    hasWrittenAll &&= hasWritten;
  }
  for (const { relativePath, settings } of agentSettings) {
    // Awaited separately: `&&=` would skip the merge once an earlier file was skipped.
    const hasMerged = await mergeAgentSettings(relativePath, settings);
    hasWrittenAll &&= hasMerged;
  }
  return hasWrittenAll;
}

async function mergeAgentSettings(relativePath: string, newSettings: object): Promise<boolean> {
  const filePath = path.join(os.homedir(), relativePath);
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
  const settings = merge(existingSettings, newSettings);
  return await fsUtil.generateFile(filePath, JSON.stringify(settings, undefined, 2));
}
