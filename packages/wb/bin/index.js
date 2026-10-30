#!/usr/bin/env bun

if (!process.versions.bun && Number(process.versions.node.split('.')[0]) < 26) {
  throw new Error('wb requires Node.js >= 26 or Bun >= 1.4.4.');
}

import { protectRunScriptArgs } from './runArgs.js';

protectRunScriptArgs(process.argv);

if (process.argv[2] === 'dotenv') {
  // This fast path skips dist/index.js, so it starts automatic GC through the dependency-free bundle.
  const { startAutoGcIfDue } = await import('../dist/gc.js');
  startAutoGcIfDue('dotenv');
  const { runDotenvCommand } = await import('./dotenv.js');
  runDotenvCommand(process.argv.slice(3));
} else {
  await import('../dist/index.js');
}
