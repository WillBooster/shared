interface OxfmtConfigContentOptions {
  isEsmPackage: boolean;
}

export function generateOxfmtConfigContent(options: OxfmtConfigContentOptions): string {
  // CommonJS packages need require/module.exports here: oxfmt config files are
  // only auto-discovered as .ts, and the shared config package is ESM-only.
  if (!options.isEsmPackage) {
    return `// oxlint-disable unicorn/prefer-module -- Oxfmt config files are only auto-discovered as .ts, and CommonJS avoids Node typeless ESM warnings.
const oxfmtConfig = require('@willbooster/oxfmt-config');

module.exports = oxfmtConfig.default ?? oxfmtConfig;
`;
  }

  return `import config from '@willbooster/oxfmt-config';

export default config;
`;
}
