#!/usr/bin/env node

import { protectRunScriptArgs } from './runArgs.js';

protectRunScriptArgs(process.argv);

if (process.argv[2] === 'dotenv') {
  // This fast path skips dist/index.js, so it starts automatic GC through the dependency-free bundle.
  const { startAutoGcIfDue } = await import('../dist/gc.js');
  startAutoGcIfDue('dotenv');
  const { runDotenvCommand } = await import('./dotenv.js');
  await runDotenvCommand(process.argv.slice(3));
} else {
  await import('../dist/index.js');
}
