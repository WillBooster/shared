interface ToolConfigContentOptions {
  packageName: string;
}

export function generateToolConfigContent(options: ToolConfigContentOptions): string {
  return `// @ts-nocheck -- Tool config files may be loaded as CommonJS before the package opts into ESM.
import config from '${options.packageName}';

export default config;
`;
}

export function normalizeToolConfigContent(content: string | undefined): string | undefined {
  return content?.trim();
}
