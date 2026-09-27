import { expect, test } from 'bun:test';

import { getFileExtension } from '../../src/filePath.js';

test('getFileExtension reads the extension of the last segment only', () => {
  expect(getFileExtension('dir/Photo.JPG')).toBe('jpg');
  expect(getFileExtension('archive.tar.gz')).toBe('gz');
  expect(getFileExtension('dir.v2/README')).toBe('');
  expect(getFileExtension('dir/.gitignore')).toBe('');
  expect(getFileExtension('.gitignore')).toBe('');
});
