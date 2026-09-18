import { quoteForShell } from '@willbooster/shared-lib/src';

export function buildShellCommand(args: string[]): string {
  return args.map((arg) => shellEscapeArgument(arg)).join(' ');
}

export function buildShellEnvironmentAssignment(name: string, value: string): string {
  return `${name}=${shellEscapeArgument(value)}`;
}

/**
 * Quoting follows `quoteForShell`; only the set of words left bare is wider, so that the
 * commands `wb` prints stay readable: a Docker option, an image tag or an assignment
 * (`name=value`, `image:tag`) carries no shell meaning as an argument, and an assignment in
 * particular must stay bare to keep working in command position.
 */
export function shellEscapeArgument(arg: string): string {
  return /^[\w./:=,@%+-]+$/u.test(arg) ? arg : quoteForShell(arg);
}
