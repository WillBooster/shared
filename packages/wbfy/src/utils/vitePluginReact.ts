import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

export const oxcTransformReactDependency = 'oxc-transform-react';

const pluginReactPackageJsonSchema = z.object({
  peerDependencies: z.record(z.string(), z.string()).optional(),
});

/**
 * The `oxc-transform-react` range that the `@vitejs/plugin-react` installed in the package
 * peer-requires, or `undefined` when it is not installed or predates its React Compiler support.
 */
export function getOxcTransformReactPeerRange(dirPath: string): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(path.join(dirPath, 'node_modules', '@vitejs', 'plugin-react', 'package.json'), 'utf8');
  } catch {
    return undefined;
  }
  return pluginReactPackageJsonSchema.parse(JSON.parse(content)).peerDependencies?.[oxcTransformReactDependency];
}
