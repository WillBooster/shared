import { spawnAsync } from '../dist/spawn.js';

const pidFilePath = process.argv[2];
if (!pidFilePath) {
  throw new Error('pidFilePath is required');
}
const exitOnSigterm = process.argv.includes('--exit-on-sigterm');

const keepAliveScript = [
  "const fs = require('node:fs');",
  'fs.writeFileSync(process.argv[1], String(process.pid));',
  'setInterval(() => {}, 1000);',
].join('');

void spawnAsync(process.execPath, ['-e', keepAliveScript, pidFilePath], {
  killOnExit: true,
  stdio: 'ignore',
});

// An application-owned listener: spawnAsync's own handler must then leave termination to the app.
if (exitOnSigterm) {
  process.on('SIGTERM', () => {
    process.exit(0);
  });
}

setInterval(() => {}, 1000);
