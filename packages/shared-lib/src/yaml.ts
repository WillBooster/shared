/**
 * Options for `stringify` of the `yaml` package that keep multiline strings readable: `blockQuote: 'literal'` writes
 * them as `key: |` blocks, and `lineWidth: 0` disables line wrapping.
 */
export const yamlStringifyOptions = { blockQuote: 'literal', lineWidth: 0 } as const;
