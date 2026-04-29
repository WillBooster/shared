import type { PackageConfig } from '../packageConfig.js';

interface ToolConfigContentOptions {
  commonJsVariableName: string;
  packageName: string;
  toolName: string;
}

export function generateToolConfigContent(config: PackageConfig, options: ToolConfigContentOptions): string {
  if (config.packageJson?.type === 'module') {
    return `import config from '${options.packageName}';

export default config;
`;
  }

  return `// oxlint-disable unicorn/prefer-module -- ${options.toolName} only auto-discovers .ts config files, and CommonJS avoids Node typeless ESM warnings.
const ${options.commonJsVariableName} = require('${options.packageName}');

module.exports = ${options.commonJsVariableName}.default ?? ${options.commonJsVariableName};
`;
}
