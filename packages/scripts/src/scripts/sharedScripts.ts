import { execute } from '@yarnpkg/shell';

class SharedScripts {
  // do nothing
}

export const sharedScripts = new SharedScripts();

export function runScript(script: string): Promise<number> {
  return execute(script.replaceAll('\n', '').trim());
}
