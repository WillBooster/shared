interface ToolConfigContentOptions {
  packageName: string;
}

export function generateToolConfigContent(options: ToolConfigContentOptions): string {
  return `import config from '${options.packageName}';

export default config;
`;
}

export function normalizeToolConfigContent(content: string | undefined): string | undefined {
  return content?.trim();
}
