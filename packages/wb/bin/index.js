#!/usr/bin/env node

const commandName = process.argv[2];
const commandArgs = process.argv.slice(3);
const useRunFastPath = commandName === 'run' && (commandArgs[0] === undefined || !commandArgs[0].startsWith('-'));

if (commandName === 'dotenv' || useRunFastPath) {
  const { runDotenvCommand, runRunCommand } = await import('./dotenv.js');
  const command = commandName === 'dotenv' ? runDotenvCommand : runRunCommand;
  await command(commandArgs);
} else {
  await import('../dist/index.js');
}
