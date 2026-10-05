import { createRequire } from 'node:module';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import chalk from 'chalk';
import type { CommandModule, InferredOptionTypes } from 'yargs';
import { z } from 'zod';

import { findSelfProject, type Project } from '../project.js';
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
const violationSchema = locationSchema.extend({
  kind: z.enum(['function', 'file', 'duplication']),
  name: z.string().optional(),
  exceeded: z.array(z.object({ metric: z.string(), value: z.number(), limit: z.number() })),
  partners: z.array(locationSchema).optional(),
});
const reportSchema = z.object({
  summary: z.object({
    violationCount: z.number(),
    functionViolationCount: z.number(),
    fileViolationCount: z.number(),
    duplicationViolationCount: z.number(),
  }),
  violations: z.array(violationSchema),
  errors: z.array(z.string()),
});

type Location = z.infer<typeof locationSchema>;
type Violation = z.infer<typeof violationSchema>;

interface CodeGaugeCheck {
  /** Absent when code-gauge printed no report, e.g. for a base ref that does not exist. */
  report?: z.infer<typeof reportSchema>;
  /** code-gauge's exit code: 0 no violations, 1 violations, 2 incomplete check. */
  status: number;
  stderr: string;
}

const VERIFY_BASE_REF = 'origin/HEAD';
const MAX_VERIFY_VIOLATION_LINES = 10;
const MAX_PARTNER_LOCATIONS = 3;

export const codeGaugeCommand: CommandModule<unknown, CodeGaugeCommandOptions> = {
  command: 'code-gauge',
  describe: 'Print code-gauge threshold violations as warnings without failing',
  builder,
  async handler(argv) {
    const project = findSelfProject(argv, false);
    if (!project) {
      console.error(chalk.red('No project found.'));
      process.exit(1);
    }
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
  // A branch check without a report (e.g. no `origin/HEAD`) only costs the ordering and the count.
  const branchKeys = branchCheck.report && new Set(branchCheck.report.violations.map(toViolationKey));
  const branchViolations = violations.filter((violation) => branchKeys?.has(toViolationKey(violation)));
  const orderedViolations = [
    ...branchViolations,
    ...violations.filter((violation) => !branchKeys?.has(toViolationKey(violation))),
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
  const branchSummary = branchKeys && describeBranchViolations(branchViolations.length);
  return formatWarnings(check, lines, branchSummary);
}

export function printCodeGaugeCommandsForVerify(project: Project): void {
  printCodeGaugeCommands(project, [undefined, VERIFY_BASE_REF]);
}

function printCodeGaugeCommands(project: Project, bases: (string | undefined)[]): void {
  for (const base of bases) {
    printCommand(['node', resolveCodeGaugeCliPath(), ...buildCheckArgs(base)].join(' '), project.dirPath);
  }
}

function describeBranchViolations(count: number): string {
  return count === 0 ? 'none in code this branch changed' : `${count} in code this branch changed (listed first)`;
}

function toViolationKey(violation: Violation): string {
  return `${violation.kind}:${violation.file}:${violation.startLine}-${violation.endLine}`;
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
  const summary = check.report?.summary;
  if (summary?.violationCount) {
    sections.push(
      chalk.yellow(
        `code-gauge: ${summary.violationCount} threshold violations (${summary.functionViolationCount} functions, ` +
          `${summary.fileViolationCount} files, ${summary.duplicationViolationCount} duplicated blocks)` +
          (branchSummary ? `, ${branchSummary}` : '')
      ),
      ...violationLines
    );
  }
  return sections.filter(Boolean).join('\n') || undefined;
}

function formatViolationLines(violations: Violation[]): string[] {
  return violations.map((violation) => {
    const exceeded = violation.exceeded.map(formatExceededThreshold).join(', ');
    if (violation.kind === 'file') return `${violation.file}: ${exceeded}`;
    if (violation.kind === 'function') return `${formatLocation(violation)} ${violation.name}: ${exceeded}`;

    const partners = violation.partners ?? [];
    const omittedPartnerCount = partners.length - MAX_PARTNER_LOCATIONS;
    return (
      `${formatLocation(violation)}: ${exceeded}, also at ` +
      partners.slice(0, MAX_PARTNER_LOCATIONS).map(formatLocation).join(', ') +
      (omittedPartnerCount > 0 ? ` (+${omittedPartnerCount} more)` : '')
    );
  });
}

function formatExceededThreshold({ limit, metric, value }: Violation['exceeded'][number]): string {
  const label = metric.replaceAll(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
  // `duplicateLines` is the only metric that violates from its limit on instead of above it.
  const comparator = metric === 'duplicateLines' ? '<' : '<=';
  // Rounded up so that a violating value never prints as equal to its limit; the inner rounding
  // drops binary floating-point noise such as 26.4 * 10 = 264.00000000000006.
  const roundedValue = Math.ceil(Number((value * 10).toFixed(6))) / 10;
  return `${label} ${roundedValue} (${comparator} ${limit})`;
}

function formatLocation({ endLine, file, startLine }: Location): string {
  return `${file}:${startLine}-${endLine}`;
}
