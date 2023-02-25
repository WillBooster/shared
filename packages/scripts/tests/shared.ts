import os from 'node:os';
import path from 'node:path';

export const tempDir = path.join(os.tmpdir(), 'shared');
console.info('tempDir:', tempDir);
