import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';

import type { Project } from '../project.js';

const ALLOWED_TEST_DIRECTORY_NAMES = new Set(['unit', 'e2e', 'debug', 'helpers', 'fixtures']);
const RUNNABLE_TEST_DIRECTORY_NAMES = new Set(['unit', 'e2e', 'debug']);
const TEST_FILE_NAME_REGEXP = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Enforces the test-layout convention with no fallback: `test/` may contain only the `unit`, `e2e`,
 * `debug`, `helpers`, and `fixtures` directories, and test files may exist only under `test/unit/`,
 * `test/e2e/`, and `test/debug/` — anywhere else in the project (e.g. `test/helpers/`, `src/`, or the
 * project root), wb would silently skip them. A project's own Playwright config also requires
 * `test/e2e` for the same reason. `test/fixtures/` is exempt from the test-file check because
 * fixtures may contain test files as data.
 */
export function findTestStructureViolations(project: Pick<Project, 'dirPath' | 'packageJson'>): string[] {
  const testDirPath = path.join(project.dirPath, 'test');
  const violations = [...findFileSystemViolations(project.dirPath)];
  // Only a project's OWN Playwright config counts: a workspace root legitimately shares a root-level
  // playwright.config.ts while keeping e2e specs in a single app package. Checked outside the
  // memoized walk because it depends on the caller-supplied packageJson, not only the directory.
  if (
    !project.packageJson.workspaces &&
    fs.existsSync(path.join(project.dirPath, 'playwright.config.ts')) &&
    !fs.existsSync(path.join(testDirPath, 'e2e'))
  ) {
    violations.push('playwright.config.ts');
  }
  return violations;
}

// The recursive walk is the expensive part and runs for the same directories from both `wb lint`
// and `wb test` within one `wb verify`, so its result is shared per project directory.
const fileSystemViolationsCache = new Map<string, string[]>();

export function clearTestStructureCache(): void {
  fileSystemViolationsCache.clear();
}

function findFileSystemViolations(projectDirPath: string): string[] {
  const cachedViolations = fileSystemViolationsCache.get(projectDirPath);
  if (cachedViolations) return cachedViolations;

  const violations: string[] = [];
  const testDirPath = path.join(projectDirPath, 'test');
  if (fs.existsSync(testDirPath)) {
    for (const entry of fs.readdirSync(testDirPath, { withFileTypes: true })) {
      // OS and editor artifacts such as .DS_Store are environment noise, not layout mistakes.
      if (entry.name.startsWith('.')) continue;
      if (!entry.isDirectory() || !ALLOWED_TEST_DIRECTORY_NAMES.has(entry.name)) {
        violations.push(`test/${entry.name}`);
      }
    }
  }
  collectStrayTestFiles(projectDirPath, '', violations);
  // A test file directly under test/ is reported by both the top-level check and the stray-file walk.
  const uniqueViolations = [...new Set(violations)];
  fileSystemViolationsCache.set(projectDirPath, uniqueViolations);
  return uniqueViolations;
}

function collectStrayTestFiles(projectDirPath: string, relativeDirPath: string, violations: string[]): void {
  for (const entry of fs.readdirSync(path.join(projectDirPath, relativeDirPath), { withFileTypes: true })) {
    // Hidden entries (.git, .tmp, .next, ...) and dependencies are not project-authored test locations:
    // the convention places tests only under test/, so a test file in a hidden directory (e.g.
    // .storybook) is outside the input contract, and enumerating environmental hidden directories
    // instead would false-positive on any unlisted generated one (.turbo, .wrangler, ...). Visible
    // build outputs such as dist/ are deliberately NOT skipped: wbfy-managed builds never emit
    // test-pattern files there, so any match is an authored file worth flagging.
    // Symlinks fail `isDirectory()` on a Dirent, so cycles are impossible.
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const relativePath = relativeDirPath ? `${relativeDirPath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // test/unit, test/e2e, and test/debug hold the runnable tests; test/fixtures may contain
      // test files as data.
      if (relativeDirPath === 'test' && (RUNNABLE_TEST_DIRECTORY_NAMES.has(entry.name) || entry.name === 'fixtures')) {
        continue;
      }
      // A nested package (e.g. a workspace member) is validated as its own project.
      if (fs.existsSync(path.join(projectDirPath, relativePath, 'package.json'))) continue;
      collectStrayTestFiles(projectDirPath, relativePath, violations);
    } else if (TEST_FILE_NAME_REGEXP.test(entry.name)) {
      violations.push(relativePath);
    }
  }
}

export function printTestStructureViolations(projectName: string, violations: string[]): void {
  console.error(
    chalk.red(
      `Invalid test layout in ${projectName}. test/ may contain only the unit, e2e, debug, helpers, and fixtures directories, test files may exist only under test/unit/, test/e2e/, and test/debug/, and a Playwright config requires test/e2e/:\n` +
        violations.map((violation) => `  ${violation}`).join('\n')
    )
  );
}

/**
 * Reports every project's layout violations and tells the caller whether any project violated the
 * convention, so a single run surfaces all of them instead of only the first.
 */
export function reportTestStructureViolations(projects: Pick<Project, 'dirPath' | 'name' | 'packageJson'>[]): boolean {
  let violated = false;
  for (const project of projects) {
    const violations = findTestStructureViolations(project);
    if (violations.length === 0) continue;

    printTestStructureViolations(project.name, violations);
    violated = true;
  }
  return violated;
}
