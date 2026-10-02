// A semantic-release plugin for a package that bundles the sources of other workspaces into its build.
// multi-semantic-release hands each package only the commits under its own directory, so a fix in a
// bundled workspace would never release the package that ships it. This plugin analyzes the commits
// and writes the notes with the commits under the bundled sources added.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeCommits as analyzeConventionalCommits } from '@semantic-release/commit-analyzer';
import { generateNotes as generateConventionalNotes } from '@semantic-release/release-notes-generator';

const commitAnalyzer = '@semantic-release/commit-analyzer';
const releaseNotesGenerator = '@semantic-release/release-notes-generator';

/**
 * Returns the repository's semantic-release configuration for the package containing `configUrl`, with
 * the commit analyzer and release notes generator replaced by this plugin when the package's `src` or
 * `bin` imports another workspace's sources (`@willbooster/<name>/src`), which its build bundles.
 */
export function createBundledWorkspaceReleaseConfig(configUrl) {
  const rootConfig = JSON.parse(fs.readFileSync(new URL('../.releaserc.json', import.meta.url), 'utf8'));
  const packageDirPath = path.dirname(fileURLToPath(configUrl));
  const bundledPaths = findBundledWorkspaceNames(packageDirPath).map((name) => {
    const dirPath = workspaceDirPaths.get(name);
    if (!dirPath) throw new Error(`No workspace package is named ${name}.`);
    return path.relative(packageDirPath, path.join(dirPath, 'src'));
  });
  if (bundledPaths.length === 0) return rootConfig;

  const optionsOf = (name) => {
    const plugin = rootConfig.plugins.find((entry) => (Array.isArray(entry) ? entry[0] : entry) === name);
    if (!plugin) throw new Error(`.releaserc.json must configure ${name}.`);
    return Array.isArray(plugin) ? plugin[1] : {};
  };
  const plugin = [
    fileURLToPath(import.meta.url),
    { bundledPaths, analyzer: optionsOf(commitAnalyzer), notes: optionsOf(releaseNotesGenerator) },
  ];
  return {
    ...rootConfig,
    plugins: rootConfig.plugins.flatMap((entry) => {
      const name = Array.isArray(entry) ? entry[0] : entry;
      if (name === commitAnalyzer) return [plugin];
      return name === releaseNotesGenerator ? [] : [entry];
    }),
  };
}

const packagesDirPath = fileURLToPath(new URL('../packages', import.meta.url));
const workspaceDirPaths = new Map(
  fs
    .readdirSync(packagesDirPath)
    .map((dirName) => path.join(packagesDirPath, dirName))
    .filter((dirPath) => fs.existsSync(path.join(dirPath, 'package.json')))
    .map((dirPath) => [JSON.parse(fs.readFileSync(path.join(dirPath, 'package.json'), 'utf8')).name, dirPath])
);

function findBundledWorkspaceNames(packageDirPath) {
  const names = new Set();
  for (const dirName of ['src', 'bin']) {
    const dirPath = path.join(packageDirPath, dirName);
    if (!fs.existsSync(dirPath)) continue;
    for (const fileName of fs.readdirSync(dirPath, { recursive: true })) {
      const filePath = path.join(dirPath, fileName);
      if (!/\.[cm]?[jt]sx?$/u.test(filePath) || !fs.statSync(filePath).isFile()) continue;
      for (const match of fs.readFileSync(filePath, 'utf8').matchAll(/['"](@willbooster\/[\w-]+)\/src['"]/gu)) {
        names.add(match[1]);
      }
    }
  }
  return [...names].toSorted();
}

export async function analyzeCommits({ bundledPaths, analyzer }, context) {
  return analyzeConventionalCommits(analyzer, withBundledCommits(bundledPaths, context));
}

export async function generateNotes({ bundledPaths, notes }, context) {
  return generateConventionalNotes(notes, withBundledCommits(bundledPaths, context));
}

function withBundledCommits(bundledPaths, context) {
  const range = context.lastRelease.gitHead ? `${context.lastRelease.gitHead}..HEAD` : 'HEAD';
  const log = execFileSync('git', ['log', '--format=%H%x1f%cI%x1f%B%x1e', range, '--', ...bundledPaths], {
    cwd: context.cwd,
    encoding: 'utf8',
  });
  const knownHashes = new Set(context.commits.map((commit) => commit.hash));
  const bundledCommits = log
    .split('\u001E')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, committerDate, message] = record.split('\u001F');
      return { hash, committerDate, message, commit: { long: hash, short: hash.slice(0, 7) } };
    })
    .filter((commit) => !knownHashes.has(commit.hash));
  if (bundledCommits.length > 0) {
    context.logger.log(`Found ${bundledCommits.length} commits in the bundled workspaces since the last release`);
  }
  return { ...context, commits: [...context.commits, ...bundledCommits] };
}
