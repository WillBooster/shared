export type ConfigBlockName = 'base' | 'export';

interface ManagedConfigBlocksOptions {
  blockNames: readonly ConfigBlockName[];
  markerPrefix: string;
  toolName: string;
}

interface GetConfigContentOptions {
  desiredContent: string;
  existingContent: string | undefined;
  filePath: string;
}

export class ManagedConfigBlocks {
  private readonly blockNames: readonly ConfigBlockName[];

  private readonly markerPrefix: string;

  private readonly toolName: string;

  constructor(options: ManagedConfigBlocksOptions) {
    this.blockNames = options.blockNames;
    this.markerPrefix = options.markerPrefix;
    this.toolName = options.toolName;
  }

  getConfigContent(options: GetConfigContentOptions): string {
    if (!options.existingContent) return options.desiredContent;
    if (this.hasManagedBlocks(options.existingContent)) {
      return this.replaceManagedBlocks(options.existingContent, options.desiredContent, options.filePath);
    }
    return options.desiredContent;
  }

  getBlock(blockName: ConfigBlockName, content: string): string {
    return `${this.getStartMarker(blockName)}
${content}
${this.getEndMarker(blockName)}`;
  }

  private hasManagedBlocks(content: string): boolean {
    return this.blockNames.some((blockName) => content.includes(this.getStartMarker(blockName)));
  }

  private replaceManagedBlocks(existingContent: string, desiredContent: string, filePath: string): string {
    let content = existingContent;
    for (const blockName of this.blockNames) {
      const replacement = this.extractManagedBlock(desiredContent, blockName);
      if (!replacement) continue;

      const nextContent = this.replaceManagedBlock(content, blockName, replacement);
      if (!nextContent) {
        console.warn(`Skipped updating incomplete ${blockName} block in ${this.toolName} config: ${filePath}`);
        return existingContent;
      }
      content = nextContent;
    }
    return content;
  }

  private extractManagedBlock(content: string, blockName: ConfigBlockName): string | undefined {
    return this.getManagedBlockRegExp(blockName).exec(content)?.[0];
  }

  private replaceManagedBlock(content: string, blockName: ConfigBlockName, replacement: string): string | undefined {
    const pattern = this.getManagedBlockRegExp(blockName);
    if (!pattern.test(content)) return undefined;
    return content.replace(pattern, replacement);
  }

  private getManagedBlockRegExp(blockName: ConfigBlockName): RegExp {
    return new RegExp(
      `${escapeRegExp(this.getStartMarker(blockName))}[\\s\\S]*?${escapeRegExp(this.getEndMarker(blockName))}`
    );
  }

  private getStartMarker(blockName: ConfigBlockName): string {
    return `// wbfy:start ${this.markerPrefix}-${blockName}`;
  }

  private getEndMarker(blockName: ConfigBlockName): string {
    return `// wbfy:end ${this.markerPrefix}-${blockName}`;
  }
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
