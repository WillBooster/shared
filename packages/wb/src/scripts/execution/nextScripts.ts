import fs from 'node:fs';
import path from 'node:path';

import semver from 'semver';

import type { Project } from '../../project.js';
import type { ScriptArgv } from '../builder.js';

import { BaseScripts } from './baseScripts.js';

/**
 * A collection of scripts for executing Next.js commands.
 * Note that `YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
class NextScripts extends BaseScripts {
  constructor() {
    super(true);
  }

  protected override startDevProtected(project: Project, argv: ScriptArgv): string {
    // Blitz's withBlitz wires its RPC layer through a webpack loader, which Turbopack ignores,
    // so Blitz apps must run the webpack dev server (Turbopack dies with resolve errors).
    // Passing no bundler flag selects webpack only on Next.js 15; Next.js 16 defaults to
    // Turbopack and needs an explicit --webpack, a flag Next.js 15's CLI rejects as unknown.
    let bundlerOption = '--turbopack ';
    if (project.packageJson.dependencies?.blitz) {
      bundlerOption = getNextMajorVersion(project) >= 16 ? '--webpack ' : '';
    }
    return `YARN next dev ${bundlerOption}${argv.normalizedArgsText ?? ''}`;
  }

  protected override buildDefaultProductionStartCommands(project: Project, argv: ScriptArgv): string[] {
    return [project.buildCommand, `YARN next start ${argv.normalizedArgsText ?? ''}`.trim()];
  }
}

export const nextScripts = new NextScripts();

/**
 * Prefers the installed package over the declared specifier because the declared one may be a
 * range; falls back to 15 (webpack-by-default behavior) when neither is readable.
 */
function getNextMajorVersion(project: Project): number {
  try {
    const installed = JSON.parse(
      fs.readFileSync(path.join(project.dirPath, 'node_modules', 'next', 'package.json'), 'utf8')
    ) as { version?: string };
    const major = semver.coerce(installed.version)?.major;
    if (major !== undefined) return major;
  } catch {
    // fall through to the declared specifier
  }
  return semver.coerce(project.packageJson.dependencies?.next)?.major ?? 15;
}
