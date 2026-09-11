import os from 'node:os';
import path from 'node:path';

import merge from 'deepmerge';

import { fsUtil } from '../utils/fsUtil.js';
import { jsoncUtil } from '../utils/jsoncUtil.js';

/**
 * The user-level instruction file of each supported agent, relative to the home directory. These
 * apply to every repository the agent works in, so they hold only the conventions that are true on
 * every WillBooster developer machine rather than in a particular repository.
 */
const userAgentInstructionFilePaths = ['.codex/AGENTS.md', '.claude/CLAUDE.md', '.gemini/GEMINI.md'] as const;

// This content is loaded into every agent session, so it is kept as short as it can be while
// staying unambiguous: e.g., the excluded organizations are written as shell brace expansion, which
// the agents read as a path condition without any runtime matching.
const userAgentInstructionContent = `- Repos live under \`~/ghq/github.com\`; always clone with \`ghq get -p\`, never \`git clone\`.
- LLM/AI agent responses may take 1–2 hours; wait patiently, don't assume failure.
- No AI attribution (e.g., \`Co-Authored-By\` trailers, "Generated with ..." footers) in commits, issues, or PRs unless explicitly requested. This hides nothing: if asked which AI agent did the work, answer truthfully.
- Outside \`~/ghq/github.com/{WillBooster,WillBoosterLab}/\`, follow the repository's contribution guide (e.g., CONTRIBUTING.md, \`.github/\`) and issue/PR templates, match its commit and code conventions, and honor its rules on AI-assisted contributions. When writing issues and PRs, prioritize minimizing the reviewer's cognitive load: include only what a reviewer unfamiliar with the work needs to understand and assess it, as concisely as possible without losing necessary context.
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
    acceptsComments: false,
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
    // Gemini CLI strips comments before parsing its settings file, unlike Claude Code, which
    // rejects a commented file as malformed.
    acceptsComments: true,
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
  for (const { acceptsComments, relativePath, settings } of agentSettings) {
    // Awaited separately: `&&=` would skip the merge once an earlier file was skipped.
    const hasMerged = await mergeAgentSettings(relativePath, settings, acceptsComments);
    hasWrittenAll &&= hasMerged;
  }
  return hasWrittenAll;
}

async function mergeAgentSettings(
  relativePath: string,
  newSettings: object,
  acceptsComments: boolean
): Promise<boolean> {
  const filePath = path.join(os.homedir(), relativePath);
  const existingContent = await fsUtil.readFileIfExists(filePath);
  let existingSettings: Record<string, unknown> = {};
  if (existingContent !== undefined) {
    // An agent ignores its whole settings file when the file breaks the grammar the agent reads it
    // with, so wbfy leaves such a file to the developer to repair rather than rewriting it into a
    // file the agent still ignores: comments are tolerated only where the agent strips them, and
    // trailing commas nowhere, since both agents parse with JSON.parse in the end. Comment-only
    // content is checked too, because it is kept as a header above the generated object.
    if (!acceptsComments && jsoncUtil.containsComment(existingContent)) {
      console.warn(`Skipped updating ${filePath} because this agent reads it as strict JSON, comments and all.`);
      return false;
    }
    if (!jsoncUtil.isTriviaOnly(existingContent)) {
      const parsedSettings = jsoncUtil.parseObjectIgnoringError<Record<string, unknown>>(existingContent, false);
      if (!parsedSettings) {
        console.warn(
          `Skipped updating ${filePath} because the existing content is not a strict JSON object (a trailing comma, for example, is not allowed).`
        );
        return false;
      }
      existingSettings = parsedSettings;
    }
  }
  const settings = merge(existingSettings, newSettings);
  // Only the properties whose value changes are rewritten, so the file keeps its own formatting
  // and, where the agent allows them, its comments.
  const { content, keysLosingComments } = jsoncUtil.stringifyPreservingTrivia(existingContent, settings);
  if (!(await fsUtil.generateFile(filePath, content))) return false;

  for (const key of keysLosingComments) {
    console.warn(`Comments inside "${key}" were dropped while rewriting it in ${filePath}.`);
  }
  return true;
}
