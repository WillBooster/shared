import { describe, expect, it } from 'vitest';

import { extractUnknownOptions } from '../src/commands/prisma.js';

describe('prisma command unknown options', () => {
  it('should extract unknown options correctly', () => {
    const argv = {
      _: ['prisma', 'migrate', 'dev'],
      $0: 'wb',
      'create-only': true,
      'skip-seed': true,
      name: 'test-migration',
      verbose: true,
      'dry-run': false,
      env: ['.env.test'],
      'some-custom-flag': 'custom-value',
      'another-flag': true,
    };

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

  it('should handle array values correctly', () => {
    const argv = {
      _: ['prisma', 'studio'],
      $0: 'wb',
      'custom-array': ['value1', 'value2'],
      verbose: true,
    };

    const result = extractUnknownOptions(argv);
    expect(result).toContain('--custom-array value1 --custom-array value2');
  });

  it('should handle boolean false values correctly', () => {
    const argv = {
      _: ['prisma', 'migrate', 'dev'],
      $0: 'wb',
      'create-only': false,
      'skip-seed': true,
      verbose: false,
    };

    const result = extractUnknownOptions(argv);

    // Should include only true boolean flags
    expect(result).toContain('--skip-seed');
    expect(result).not.toContain('--create-only'); // false value should not be included
    expect(result).not.toContain('--verbose'); // known option should not be included
  });
});
