import { execute, UserOptions } from '@yarnpkg/shell';

class SharedScripts {
  // do nothing
}

export const sharedScripts = new SharedScripts();

export function runScript(script: string, opts?: Partial<UserOptions>): Promise<number> {
  return execute(script.replaceAll('\n', '').trim(), undefined, opts);
}
