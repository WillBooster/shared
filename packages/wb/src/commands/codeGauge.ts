import { createRequire } from 'node:module';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import type { CommandModule, InferredOptionTypes } from 'yargs';
import { z } from 'zod';

import { findSelfProjectOrExit, type Project } from '../project.js';
import type { sharedOptionsBuilder } from '../sharedOptionsBuilder.js';
import { readNearestPackageJson } from '../utils/nearestPackageJson.js';
import { printCommand } from '../utils/packageCommand.js';

const builder = {
  base: {
    type: 'string',
    describe: 'Report only violations in what the working tree changed since the merge-base with this ref',
  },
} as const;

type CodeGaugeCommandOptions = InferredOptionTypes<typeof builder & typeof sharedOptionsBuilder>;

const locationSchema = z.object({ file: z.string(), startLine: z.number(), endLine: z.number() });
const levelSchema = z.enum(['warning', 'error']);
const violationSchema = locationSchema.extend({
  kind: z.enum(['function', 'file', 'duplication']),
  level: levelSchema,
  name: z.string().optional(),
  exceeded: z.array(z.object({ metric: z.string(), value: z.number(), level: levelSchema, limit: z.number() })),
  partners: z.array(locationSchema).optional(),
});
const reportSchema = z.object({
  summary: z.object({
    violationCount: z.number(),
    errorViolationCount: z.number(),
    warningViolationCount: z.number(),
    functionViolationCount: z.number(),
    fileViolationCount: z.number(),
    duplicationViolationCount: z.number(),
  }),
  violations: z.array(violationSchema),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
});

type Location = z.infer<typeof locationSchema>;
type Violation = z.infer<typeof violationSchema>;

interface CodeGaugeCheck {
  /** Absent when code-gauge printed no report, e.g. for a base ref that does not exist. */
  report?: z.infer<typeof reportSchema>;
  /** code-gauge's exit code: 0 no errors (warnings may remain), 1 errors, 2 incomplete check. */
  status: number;
  stderr: string;
}

const VERIFY_BASE_REF = 'origin/HEAD';
const MAX_VERIFY_VIOLATION_LINES = 10;
const MAX_PARTNER_LOCATIONS = 3;

export const codeGaugeCommand: CommandModule<unknown, CodeGaugeCommandOptions> = {
  command: 'code-gauge',
  describe: 'Print code-gauge errors and warnings without failing',
  builder,
  async handler(argv) {
    const project = findSelfProjectOrExit(argv, false);
    if (argv.dryRun) {
      printCodeGaugeCommands(project, [argv.base]);
      return;
    }
    const check = await runCodeGaugeCheck(project, argv.base);
    const warnings = formatWarnings(check, formatViolationLines(check.report?.violations ?? []));
    if (warnings) console.info(warnings);
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
  const orderedViolations = [
    ...branchViolations,
    ...violations.filter((violation) => !branchViolations.includes(violation)),
  ];
  const lines = formatViolationLines(orderedViolations.slice(0, MAX_VERIFY_VIOLATION_LINES));
  const omittedCount = orderedViolations.length - lines.length;
  if (omittedCount > 0) {
    const command = `${project.packageManagerCommand} wb code-gauge`;
    lines.push(
      `... and ${omittedCount} more: list all with \`${command}\`` +
        (branchViolations.length > MAX_VERIFY_VIOLATION_LINES
          ? `, those in code this branch changed with \`${command} --base ${VERIFY_BASE_REF}\``
          : '')
    );
  }
  const branchSummary = branchReport
    ? describeBranchViolations(branchViolations.length)
    : `not ordered by this branch's changes (no report for --base ${VERIFY_BASE_REF})`;
  return formatWarnings(check, lines, branchSummary);
}

export function printCodeGaugeCommandsForVerify(project: Project): void {
  printCodeGaugeCommands(project, [undefined, VERIFY_BASE_REF]);
}

function printCodeGaugeCommands(project: Project, bases: (string | undefined)[]): void {
  let cliPath;
  try {
    cliPath = resolveCodeGaugeCliPath();
  } catch {
    // The run reports a code-gauge it cannot locate as an incomplete check; a dry run must not fail on it either.
    cliPath = '<code-gauge CLI not found>';
  }
  for (const base of bases) {
    printCommand(['node', cliPath, ...buildCheckArgs(base)].join(' '), project.dirPath);
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
  return violation.kind === 'duplication'
    ? violation.startLine <= branchViolation.endLine && branchViolation.startLine <= violation.endLine
    : violation.startLine === branchViolation.startLine && violation.endLine === branchViolation.endLine;
}

async function runCodeGaugeCheck(project: Project, base?: string): Promise<CodeGaugeCheck> {
  try {
    // Run by node, not by the runtime running wb: code-gauge loads a native addon.
    const { status, stderr, stdout } = await spawnAsync('node', [resolveCodeGaugeCliPath(), ...buildCheckArgs(base)], {
      cwd: project.dirPath,
      env: project.env,
    });
    return { report: parseReport(stdout), status: status ?? 2, stderr };
  } catch (error) {
    // A code-gauge that cannot be located or started is an incomplete check, not a wb failure.
    return { status: 2, stderr: error instanceof Error ? error.message : String(error) };
  }
}

function buildCheckArgs(base?: string): string[] {
  return ['check', '--json', ...(base === undefined ? [] : ['--base', base])];
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

function formatWarnings(check: CodeGaugeCheck, violationLines: string[], branchSummary?: string): string | undefined {
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
  if (summary?.violationCount) {
    sections.push(
      chalk.yellow(
        `code-gauge: ${summary.errorViolationCount} errors, ${summary.warningViolationCount} warnings ` +
          `(${summary.functionViolationCount} functions, ` +
          `${summary.fileViolationCount} files, ${summary.duplicationViolationCount} duplicated blocks)` +
          (branchSummary ? `, ${branchSummary}` : '')
      ),
      ...violationLines
    );
  }
  return sections.filter(Boolean).join('\n') || undefined;
}

function formatViolationLines(violations: Violation[]): string[] {
  return violations.map((violation) => `${violation.level}: ${describeViolation(violation)}`);
}

function describeViolation(violation: Violation): string {
  const exceeded = violation.exceeded.map((limit) => formatExceededThreshold(limit, violation.level)).join(', ');
  if (violation.kind === 'file') return `${violation.file}: ${exceeded}`;
  if (violation.kind === 'function') {
    // A computed name can span lines in the source; a violation stays on one line.
    return `${formatLocation(violation)} ${violation.name?.replaceAll(/\s*[\n\r]\s*/g, ' ')}: ${exceeded}`;
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
  lineLevel: Violation['level']
): string {
  const label = metric.replaceAll(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
  // `duplicateLines` is the only metric that violates from its limit on instead of above it.
  const maxAllowed = metric === 'duplicateLines' ? Math.max(Math.ceil(limit) - 1, 0) : limit;
  // Rounded up so that a violating value never prints as equal to the maximum; the inner rounding
  // drops binary floating-point noise such as 26.4 * 10 = 264.00000000000006.
  const roundedValue = Math.ceil(Number((value * 10).toFixed(6))) / 10;
  return `${label} ${roundedValue} (${level === lineLevel ? '' : `${level} `}max ${maxAllowed})`;
}

function formatLocation({ endLine, file, startLine }: Location): string {
  return `${file}:${startLine}-${endLine}`;
}
