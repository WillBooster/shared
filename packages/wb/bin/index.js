#!/usr/bin/env node

if (process.argv[2] === 'dotenv' || process.argv[2] === 'run') {
  const { runDotenvCommand, runRunCommand } = await import('./dotenv.js');
  const command = process.argv[2] === 'dotenv' ? runDotenvCommand : runRunCommand;
  await command(process.argv.slice(3));
} else {
  await import('../dist/index.js');
}
