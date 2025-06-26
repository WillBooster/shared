import { describe, expect, it } from 'vitest';
import yargs from 'yargs';

import { extractUnknownOptions } from '../src/commands/prisma.js';
import { sharedOptionsBuilder } from '../src/sharedOptionsBuilder.js';

describe('prisma command unknown options', () => {
  it('should extract unknown options correctly', () => {
    // Use yargs to parse command-line arguments like it would in real usage
    const argv = yargs()
      .options(sharedOptionsBuilder)
      .strict(false) // Allow unknown options
      .parseSync([
        'prisma',
        'migrate',
        'dev',
        '--create-only',
        '--skip-seed',
        '--name',
        'test-migration',
        '--verbose',
        '--dry-run',
        'false',
        '--env',
        '.env.test',
        '--some-custom-flag',
        'custom-value',
        '--another-flag',
      ]);

    const result = extractUnknownOptions(argv);

    // Should include the unknown options but not the known ones
    expect(result).toContain('--create-only');
    expect(result).toContain('--skip-seed');
    expect(result).toContain('--name test-migration');
    expect(result).toContain('--some-custom-flag custom-value');
    expect(result).toContain('--another-flag');

    // Should not include known options
    expect(result).not.toContain('--verbose');
    expect(result).not.toContain('--dry-run');
    expect(result).not.toContain('--env');
  });

  it('should avoid duplicating kebab-case and camelCase options', () => {
    // Use yargs to parse kebab-case options - yargs automatically creates camelCase versions
    const argv = yargs()
      .options(sharedOptionsBuilder)
      .strict(false) // Allow unknown options
      .parseSync(['prisma', 'migrate', 'dev', '--create-only', '--skip-seed', '--verbose']);

    const result = extractUnknownOptions(argv);

    // Should only include kebab-case versions, not camelCase duplicates
    expect(result).toContain('--create-only');
    expect(result).toContain('--skip-seed');
    expect(result).not.toContain('--createOnly');
    expect(result).not.toContain('--skipSeed');
    expect(result).not.toContain('--verbose'); // known option should not be included
  });

  it('should handle array values correctly', () => {
    const argv = yargs()
      .options(sharedOptionsBuilder)
      .strict(false) // Allow unknown options
      .parseSync(['prisma', 'studio', '--custom-array', 'value1', '--custom-array', 'value2', '--verbose']);

    const result = extractUnknownOptions(argv);
    expect(result).toContain('--custom-array value1 --custom-array value2');
  });

  it('should handle boolean false values correctly', () => {
    const argv = yargs()
      .options(sharedOptionsBuilder)
      .strict(false) // Allow unknown options
      .parseSync([
        'prisma',
        'migrate',
        'dev',
        '--skip-seed', // This will be true
        // --create-only is omitted, so it will be false/undefined
        // --verbose is omitted, so it will be false/undefined
      ]);

    const result = extractUnknownOptions(argv);

    // Should include only true boolean flags
    expect(result).toContain('--skip-seed');
    expect(result).not.toContain('--create-only'); // false/undefined value should not be included
    expect(result).not.toContain('--verbose'); // known option should not be included
  });
});
