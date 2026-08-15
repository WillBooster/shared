#!/usr/bin/env node

process.argv.splice(2, 0, 'open-cli');
await import('./index.js');
