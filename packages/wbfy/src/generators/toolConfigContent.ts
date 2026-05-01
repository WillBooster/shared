interface ToolConfigContentOptions {
  isEsmPackage: boolean;
  packageName: string;
}

export function generateToolConfigContent(options: ToolConfigContentOptions): string {
  if (!options.isEsmPackage) {
    return `// oxlint-disable unicorn/prefer-module -- Tool config files are auto-discovered as .ts, and CommonJS avoids Node typeless ESM warnings.
const toolConfig = require('${options.packageName}');

module.exports = toolConfig.default ?? toolConfig;
`;
  }

  return `import config from '${options.packageName}';

export default config;
`;
}

export function normalizeToolConfigContent(content: string | undefined): string | undefined {
  return content?.trim();
}
