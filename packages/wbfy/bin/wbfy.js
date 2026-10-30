#!/usr/bin/env bun

if (!process.versions.bun && Number(process.versions.node.split('.')[0]) < 26) {
  throw new Error('wbfy requires Node.js >= 26 or Bun >= 1.4.4.');
}

await import('../dist/index.js');
