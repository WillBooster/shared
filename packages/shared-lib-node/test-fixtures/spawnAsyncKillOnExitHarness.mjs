import { spawnAsync } from '../dist/spawn.js';

const pidFilePath = process.argv[2];
if (!pidFilePath) {
  throw new Error('pidFilePath is required');
}
const exitOnSigint = process.argv.includes('--exit-on-sigint');

const keepAliveScript = [
  "const fs = require('node:fs');",
  'fs.writeFileSync(process.argv[1], String(process.pid));',
  'setInterval(() => {}, 1000);',
].join('');

void spawnAsync(process.execPath, ['-e', keepAliveScript, pidFilePath], {
  killOnExit: true,
  stdio: 'ignore',
});

if (exitOnSigint) {
  process.on('SIGINT', () => {
    setTimeout(() => {
      process.exit(0);
    }, 50);
  });
}

setInterval(() => {}, 1000);
