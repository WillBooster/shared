#!/usr/bin/env node

if (process.argv[2] === 'dotenv') {
  const { runDotenvCommand } = await import('./dotenv.js');
  await runDotenvCommand(process.argv.slice(3));
} else {
  await import('../dist/index.js');
}
