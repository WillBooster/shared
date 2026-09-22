import type { TestArgv } from '../../commands/test.js';
import type { Project } from '../../project.js';

const NAME_FILTER_OPTION_REGEXP = /^(?:-t|-g|--grep|--test-name-pattern)(?:=(?<value>.*))?$/;

export function validateUnitRunnerTestSelection(project: Project, argv: TestArgv, forwardedArgs: string[]): void {
  if (project.hasPlaywrightConfig || argv.grep === undefined) return;
  const { unsupportedOption } = adaptForwardedArgsForUnitRunner(forwardedArgs);
  if (unsupportedOption !== undefined) {
    throw new Error(`Cannot forward Playwright option to the unit-test runner: ${unsupportedOption}`);
  }
}

export function adaptForwardedArgsForUnitRunner(args: string[]): {
  targets: string[];
  flags: string[];
  unsupportedOption?: string;
} {
  const targets: string[] = [];
  let nameFilter: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (arg === '--') {
      targets.push(...args.slice(index + 1));
      break;
    }
    const filterMatch = NAME_FILTER_OPTION_REGEXP.exec(arg);
    if (filterMatch) {
      const value = filterMatch.groups?.value ?? args[++index];
      if (!value) return { targets, flags: [], unsupportedOption: arg };
      nameFilter = value;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      return { targets, flags: [], unsupportedOption: arg };
    }
    targets.push(arg);
  }
  return { targets, flags: nameFilter === undefined ? [] : [`-t=${nameFilter}`] };
}
