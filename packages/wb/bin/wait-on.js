#!/usr/bin/env node

process.argv.splice(2, 0, 'wait-on');
await import('./index.js');
