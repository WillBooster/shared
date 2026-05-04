export type ConfigBlockName = 'base' | 'export';

interface GetConfigContentWithManagedBlocksOptions {
  blockNames: readonly ConfigBlockName[];
  desiredContent: string;
  existingContent: string | undefined;
  filePath: string;
  markerPrefix: string;
  toolName: string;
}

export function getConfigContentWithManagedBlocks(options: GetConfigContentWithManagedBlocksOptions): string {
  if (!options.existingContent) return options.desiredContent;
  if (hasManagedBlocks(options.existingContent, options)) {
    return replaceManagedBlocks(options.existingContent, options.desiredContent, options);
  }
  return options.desiredContent;
}

export function getManagedBlock(
  blockName: ConfigBlockName,
  content: string,
  options: Pick<GetConfigContentWithManagedBlocksOptions, 'markerPrefix'>
): string {
  return `${getStartMarker(blockName, options)}
${content}
${getEndMarker(blockName, options)}`;
}

function hasManagedBlocks(content: string, options: GetConfigContentWithManagedBlocksOptions): boolean {
  return options.blockNames.some((blockName) => content.includes(getStartMarker(blockName, options)));
}

function replaceManagedBlocks(
  existingContent: string,
  desiredContent: string,
  options: GetConfigContentWithManagedBlocksOptions
): string {
  let content = existingContent;
  for (const blockName of options.blockNames) {
    const replacement = extractManagedBlock(desiredContent, blockName, options);
    if (!replacement) continue;

    const nextContent = replaceManagedBlock(content, blockName, replacement, options);
    if (!nextContent) {
      console.warn(`Skipped updating incomplete ${blockName} block in ${options.toolName} config: ${options.filePath}`);
      return existingContent;
    }
    content = nextContent;
  }
  return content;
}

function extractManagedBlock(
  content: string,
  blockName: ConfigBlockName,
  options: Pick<GetConfigContentWithManagedBlocksOptions, 'markerPrefix'>
): string | undefined {
  return getManagedBlockRegExp(blockName, options).exec(content)?.[0];
}

function replaceManagedBlock(
  content: string,
  blockName: ConfigBlockName,
  replacement: string,
  options: Pick<GetConfigContentWithManagedBlocksOptions, 'markerPrefix'>
): string | undefined {
  const pattern = getManagedBlockRegExp(blockName, options);
  if (!pattern.test(content)) return undefined;
  return content.replace(pattern, replacement);
}

function getManagedBlockRegExp(
  blockName: ConfigBlockName,
  options: Pick<GetConfigContentWithManagedBlocksOptions, 'markerPrefix'>
): RegExp {
  return new RegExp(
    `${escapeRegExp(getStartMarker(blockName, options))}[\\s\\S]*?${escapeRegExp(getEndMarker(blockName, options))}`
  );
}

function getStartMarker(
  blockName: ConfigBlockName,
  options: Pick<GetConfigContentWithManagedBlocksOptions, 'markerPrefix'>
): string {
  return `// wbfy:start ${options.markerPrefix}-${blockName}`;
}

function getEndMarker(
  blockName: ConfigBlockName,
  options: Pick<GetConfigContentWithManagedBlocksOptions, 'markerPrefix'>
): string {
  return `// wbfy:end ${options.markerPrefix}-${blockName}`;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
