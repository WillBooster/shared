import { createRequire } from 'node:module';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import type { Argv, CommandModule, InferredOptionTypes } from 'yargs';
import { z } from 'zod';

import { findSelfProjectOrExit, type Project } from '../project.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { readNearestPackageJson } from '../utils/nearestPackageJson.js';
import { printCommand } from '../utils/packageCommand.js';
import { buildShellCommand } from '../utils/shell.js';

const builder = {
  base: {
    type: 'string',
    describe: 'Report only violations in what the working tree changed since the merge-base with this ref',
  },
} as const;

const argumentsBuilder = {
  target: {
    type: 'string',
    describe: 'File or directory to check instead of the whole project',
  },
} as const;

type CodeGaugeCommandOptions = InferredOptionTypes<
  typeof builder & typeof sharedOptionsBuilder & typeof argumentsBuilder
>;

const locationSchema = z.object({ file: z.string(), startLine: z.number(), endLine: z.number() });
const levelSchema = z.enum(['warning', 'error']);
const exceededSchema = z.array(
  z.object({ metric: z.string(), value: z.number(), level: levelSchema, limit: z.number() })
);
const codeViolationSchema = locationSchema.extend({
  kind: z.enum(['function', 'file', 'duplication']),
  level: levelSchema,
  name: z.string().optional(),
  exceeded: exceededSchema,
  largestBlocks: z
    .array(
      z.object({
        name: z.string().optional(),
        startLine: z.number(),
        endLine: z.number(),
        cognitiveComplexity: z.number(),
      })
    )
    .optional(),
  partners: z.array(locationSchema).optional(),
});
/** The share of test code in the checked directory, which no line span locates. */
const projectViolationSchema = z.object({
  kind: z.literal('project'),
  file: z.string(),
  level: levelSchema,
  exceeded: exceededSchema,
  testNcss: z.number(),
  productionNcss: z.number(),
  excessTestNcss: z.number(),
});
const violationSchema = z.union([codeViolationSchema, projectViolationSchema]);
const reportSchema = z.object({
  summary: z.object({
    violationCount: z.number(),
    errorViolationCount: z.number(),
    warningViolationCount: z.number(),
    functionViolationCount: z.number(),
    fileViolationCount: z.number(),
    duplicationViolationCount: z.number(),
    projectViolationCount: z.number(),
    checkedFileCount: z.number(),
  }),
  violations: z.array(violationSchema),
  directiveProblems: z.array(z.object({ file: z.string(), line: z.number(), message: z.string() })),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
});

type Location = z.infer<typeof locationSchema>;
type CodeViolation = z.infer<typeof codeViolationSchema>;
type Violation = z.infer<typeof violationSchema>;
type Report = z.infer<typeof reportSchema>;

interface CodeGaugeCheck {
  /** Absent when code-gauge printed no report, e.g. for a base ref that does not exist. */
  report?: Report;
  /** code-gauge's exit code: 0 no errors (warnings may remain), 1 errors, 2 incomplete check. */
  status: number;
  stderr: string;
}

const VERIFY_BASE_REF = 'origin/HEAD';
const MAX_VERIFY_VIOLATION_LINES = 10;
const MAX_PARTNER_LOCATIONS = 3;
const VIOLATION_HANDLING_INSTRUCTIONS = `How to handle these violations:
- In code your change touches, fix every error, and each warning whose fix makes the code easier to read, with behavior-preserving changes (e.g., extract a helper, flatten branching, reuse the code it duplicates).
- Leave a violation whose only fix moves complexity elsewhere (e.g., splitting a function mechanically), restructures far more code than your change touches, or removes an intentional duplicate (e.g., a file mirroring another by design).
- Allow each warning left with a \`code-gauge-allow <metric> -- <reason>\` comment on its own line right above the function's reported start line; for a duplicated block, above the start line of its enclosing function, separately for each copy (\`code-gauge-allow-file\` for the whole file or a block outside a function), where <metric> is the camelCase metric name (e.g., functionParameterCount). For a directive reported as an error, correct its syntax or placement, keeping its reason, when the code it covers still has the warning it was written for; remove it when no such warning remains.
- When the share of test code (the test NCSS of a directory, \`.\` for the whole project) is reported in code this branch changed, delete or merge tests in the same change so it adds no test code; no comment can allow it.
- List each error left, which no comment can allow, with the reason, in the PR body's Notes, proposing a \`code-gauge.config.json\` exclusion there for an intentional duplicate. Never edit \`code-gauge.config.json\` to silence a violation unless asked.
- When a violation measures the code incorrectly (e.g., misparsed syntax, unrelated code reported as duplicated), search the issues of WillBooster/code-gauge and, if none covers it, create one with a freshly written minimal reproduction, the command, and its output.`;

export const codeGaugeCommand: CommandModule<unknown, CodeGaugeCommandOptions> = {
  command: 'code-gauge [target]',
  describe: 'Print code-gauge errors and warnings without failing',
  builder: (yargs) =>
    yargs.options(builder).positional('target', argumentsBuilder.target) as Argv<CodeGaugeCommandOptions>,
  async handler(argv) {
    const project = findSelfProjectOrExit(argv, false);
    if (argv.dryRun) {
      printCodeGaugeCommands(project, [argv.base], argv.target);
      return;
    }
    const check = await runCodeGaugeCheck(project, argv.base, argv.target);
    const report = formatReport(
      check,
      formatViolationLines(
        check.report?.violations ?? [],
        check.report?.directiveProblems ?? [],
        argv.base !== undefined
      )
    );
    if (report) {
      console.info(report);
    } else if (argv.target !== undefined && argv.base === undefined && check.report?.summary.checkedFileCount === 0) {
      // Silence would read as a clean result, while nothing under the path was checked at all.
      // With --base the count is of changed files, so zero does not tell an unchanged path from one
      // holding nothing to check, and the message would be false for the former.
      console.info(chalk.yellow(`code-gauge: no file was checked under ${argv.target}`));
    }
  },
};

/**
 * Checks the whole project, and what the current branch changed to list those violations first.
 * Returns undefined when there is nothing to report.
 */
export async function checkCodeGaugeForVerify(project: Project): Promise<string | undefined> {
  const [check, branchCheck] = await Promise.all([
    runCodeGaugeCheck(project),
    runCodeGaugeCheck(project, VERIFY_BASE_REF),
  ]);
  const violations = check.report?.violations ?? [];
  // A branch check without a report (e.g. no `origin/HEAD`) only costs the ordering and the count,
  // which the header then says; with no violation to order, there is nothing to say.
  const branchReport = branchCheck.report;
  const branchViolations = violations.filter((violation) =>
    branchReport?.violations.some((branchViolation) => isSameViolation(violation, branchViolation))
  );
  const directiveProblems = check.report?.directiveProblems ?? [];
  const branchDirectiveProblems = directiveProblems.filter((problem) =>
    branchReport?.directiveProblems.some(({ file, line }) => file === problem.file && line === problem.line)
  );
  const branchLines = formatViolationLines(branchViolations, branchDirectiveProblems, true);
  const allLines = [
    ...branchLines,
    ...formatViolationLines(
      violations.filter((violation) => !branchViolations.includes(violation)),
      directiveProblems.filter((problem) => !branchDirectiveProblems.includes(problem)),
      false
    ),
  ];
  const lines = allLines.slice(0, MAX_VERIFY_VIOLATION_LINES);
  const omittedCount = allLines.length - lines.length;
  if (omittedCount > 0) {
    const command = `${project.packageManagerCommand} wb code-gauge`;
    lines.push(
      `... and ${omittedCount} more: list all with \`${command}\`` +
        (branchLines.length > MAX_VERIFY_VIOLATION_LINES
          ? `, those in code this branch changed with \`${command} --base ${VERIFY_BASE_REF}\``
          : '')
    );
  }
  const branchSummary = branchReport
    ? describeBranchViolations(branchLines.length)
    : `not ordered by this branch's changes (no report for --base ${VERIFY_BASE_REF})`;
  const report = formatReport(check, lines, branchSummary);
  return allLines.length > 0 ? `${report}\n${VIOLATION_HANDLING_INSTRUCTIONS}` : report;
}

export function printCodeGaugeCommandsForVerify(project: Project): void {
  printCodeGaugeCommands(project, [undefined, VERIFY_BASE_REF]);
}

function printCodeGaugeCommands(project: Project, bases: (string | undefined)[], target?: string): void {
  let cliPath;
  try {
    cliPath = resolveCodeGaugeCliPath();
  } catch {
    // The run reports a code-gauge it cannot locate as an incomplete check; a dry run must not fail on it either.
    cliPath = '<code-gauge CLI not found>';
  }
  for (const base of bases) {
    printCommand(buildShellCommand(['node', cliPath, ...buildCheckArgs(base, target)]), project.dirPath);
  }
}

function describeBranchViolations(count: number): string {
  return count === 0 ? 'none in code this branch changed' : `${count} in code this branch changed (listed first)`;
}

/**
 * Whether a violation of the whole-project report is the one the branch report holds. code-gauge
 * merges overlapping duplicated blocks after limiting them to the changed lines, so the same block
 * can span fewer lines in the branch report; other kinds keep their span.
 */
function isSameViolation(violation: Violation, branchViolation: Violation): boolean {
  if (violation.kind !== branchViolation.kind || violation.file !== branchViolation.file) return false;
  if (violation.kind === 'project' || branchViolation.kind === 'project') return true;
  return violation.kind === 'duplication'
    ? violation.startLine <= branchViolation.endLine && branchViolation.startLine <= violation.endLine
    : violation.startLine === branchViolation.startLine && violation.endLine === branchViolation.endLine;
}

async function runCodeGaugeCheck(project: Project, base?: string, target?: string): Promise<CodeGaugeCheck> {
  try {
    // Run by node, not by the runtime running wb: code-gauge loads a native addon.
    const { status, stderr, stdout } = await spawnAsync(
      'node',
      [resolveCodeGaugeCliPath(), ...buildCheckArgs(base, target)],
      {
        cwd: project.dirPath,
        env: project.env,
      }
    );
    return { report: parseReport(stdout), status: status ?? 2, stderr };
  } catch (error) {
    // A code-gauge that cannot be located or started is an incomplete check, not a wb failure.
    return { status: 2, stderr: error instanceof Error ? error.message : String(error) };
  }
}

function buildCheckArgs(base?: string, target?: string): string[] {
  return [
    'check',
    '--json',
    ...(base === undefined ? [] : ['--base', base]),
    ...(target === undefined ? [] : [target]),
  ];
}

/** Resolved from wb's own dependency, so target repositories need not declare code-gauge. */
function resolveCodeGaugeCliPath(): string {
  // code-gauge exports neither `package.json` nor its CLI, so locate the package from its entry point.
  const { dirPath, packageJson } = readNearestPackageJson(createRequire(import.meta.url).resolve('code-gauge'));
  return path.join(dirPath, z.object({ bin: z.string() }).parse(packageJson).bin);
}

function parseReport(stdout: string): CodeGaugeCheck['report'] {
  try {
    return reportSchema.parse(JSON.parse(stdout));
  } catch {
    return undefined;
  }
}

function formatReport(check: CodeGaugeCheck, lines: string[], branchSummary?: string): string | undefined {
  const sections: string[] = [];
  if (!check.report || (check.status !== 0 && check.status !== 1)) {
    // With `--json`, code-gauge reports the files it could not measure in the report, not on stderr.
    sections.push(
      chalk.yellow(`code-gauge: the check is incomplete (exit code ${check.status})`),
      ...(check.report?.errors ?? []),
      check.stderr.trim()
    );
  }
  const measurementWarnings = check.report?.warnings ?? [];
  if (measurementWarnings.length > 0) {
    sections.push(chalk.yellow('code-gauge: some files were not fully measured'), ...measurementWarnings);
  }
  const summary = check.report?.summary;
  const directiveProblemCount = check.report?.directiveProblems.length ?? 0;
  if (summary && summary.violationCount + directiveProblemCount > 0) {
    sections.push(
      chalk.yellow(
        `code-gauge: ${summary.errorViolationCount + directiveProblemCount} errors, ` +
          `${summary.warningViolationCount} warnings ` +
          `(${summary.functionViolationCount} functions, ` +
          `${summary.fileViolationCount} files, ${summary.duplicationViolationCount} duplicated blocks` +
          (summary.projectViolationCount > 0 ? `, ${summary.projectViolationCount} test shares` : '') +
          (directiveProblemCount > 0 ? `, ${directiveProblemCount} directives` : '') +
          ')' +
          (branchSummary ? `, ${branchSummary}` : '')
      ),
      ...lines
    );
  }
  return sections.filter(Boolean).join('\n') || undefined;
}

/**
 * The share of test code first whatever its level, then the errors with the directive problems
 * (errors too), then the warnings, so that a cut list keeps errors. A branch's share asks only
 * that the change add no test code, not that the whole excess go.
 */
function formatViolationLines(
  violations: Violation[],
  directiveProblems: Report['directiveProblems'],
  inBranch: boolean
): string[] {
  const format = (violation: Violation): string => `${violation.level}: ${describeViolation(violation, inBranch)}`;
  const codeViolations = violations.filter(({ kind }) => kind !== 'project');
  return [
    ...violations.filter(({ kind }) => kind === 'project').map(format),
    ...codeViolations.filter(({ level }) => level === 'error').map(format),
    ...directiveProblems.map(({ file, line, message }) => `error: ${file}:${line}: ${message}`),
    ...codeViolations.filter(({ level }) => level === 'warning').map(format),
  ];
}

function describeViolation(violation: Violation, inBranch: boolean): string {
  const exceeded = violation.exceeded.map((limit) => formatExceededThreshold(limit, violation)).join(', ');
  if (violation.kind === 'project') {
    return (
      `${violation.file}: ${exceeded}, test NCSS ${violation.testNcss} of production NCSS ${violation.productionNcss}; ` +
      (inBranch
        ? 'this change edits tests: delete or merge tests so the change adds no test code'
        : `delete or merge ${violation.excessTestNcss} test NCSS`)
    );
  }
  if (violation.kind === 'file') return `${violation.file}: ${exceeded}`;
  if (violation.kind === 'function') {
    return `${formatLocation(violation)} ${toOneLine(violation.name ?? '')}: ${exceeded}`;
  }

  const partners = violation.partners ?? [];
  const omittedPartnerCount = partners.length - MAX_PARTNER_LOCATIONS;
  return (
    `${formatLocation(violation)}: ${exceeded}, also at ` +
    partners.slice(0, MAX_PARTNER_LOCATIONS).map(formatLocation).join(', ') +
    (omittedPartnerCount > 0 ? ` (+${omittedPartnerCount} more)` : '')
  );
}

/** Names the level of a limit milder than its line's, so an error line shows which limits make it one. */
function formatExceededThreshold(
  { level, limit, metric, value }: Violation['exceeded'][number],
  violation: Violation
): string {
  const label = metric.replaceAll(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
  // `duplicateLines` is the only metric that violates from its limit on instead of above it.
  const maxAllowed = metric === 'duplicateLines' ? Math.max(Math.ceil(limit) - 1, 0) : limit;
  // Rounded up so that a violating value never prints as equal to the maximum; the inner rounding
  // drops binary floating-point noise such as 26.4 * 10 = 264.00000000000006.
  const roundedValue = Math.ceil(Number((value * 10).toFixed(6))) / 10;
  const blocks =
    violation.kind === 'function' && metric === 'functionCognitiveComplexity'
      ? formatLargestBlocks(violation.largestBlocks)
      : '';
  return `${label} ${roundedValue} (${level === violation.level ? '' : `${level} `}max ${maxAllowed}${blocks})`;
}

/** The parts of the function to look at first, each with the complexity it adds. */
function formatLargestBlocks(blocks: CodeViolation['largestBlocks'] = []): string {
  const parts = blocks.map(({ cognitiveComplexity, endLine, name, startLine }) => {
    const lines = endLine === startLine ? `L${startLine}` : `L${startLine}-${endLine}`;
    return `${lines}${name ? ` ${toOneLine(name)}` : ''} ${cognitiveComplexity}`;
  });
  return parts.length > 0 ? `; largest parts ${parts.join(', ')}` : '';
}

/** A computed name can span lines in the source; a violation stays on one line. */
function toOneLine(name: string): string {
  return name.replaceAll(/\s*[\n\r]\s*/g, ' ');
}

function formatLocation({ endLine, file, startLine }: Location): string {
  return `${file}:${startLine}-${endLine}`;
}
