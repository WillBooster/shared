import { expect, test } from 'vitest';

import { postinstallGeneratesWorkerTypes } from '../src/utils/wranglerTypesCommand.js';

// wbfy itself converts `yarn workspace <pkg> run <script>` into `bun run --filter <pkg> <script>`,
// so a runner aimed at another package is supported input. Resolving its script name against THIS
// package's scripts would claim the managed worker-configuration.d.ts is regenerated on install and
// untrack a file no local command produces.
test.each([
  { name: 'a --filter runner', postinstall: 'bun run --filter components gen' },
  { name: 'a --filter=value runner', postinstall: 'bun run --filter=components gen' },
  { name: 'a --cwd runner pointing elsewhere', postinstall: 'bun run --cwd ../other gen' },
  { name: 'an all-workspaces runner', postinstall: 'bun run --workspaces gen' },
])('does not credit $name with generating this package worker types', ({ postinstall }) => {
  expect(postinstallGeneratesWorkerTypes({ gen: 'wrangler types', postinstall })).toBe(false);
});

test.each([
  { name: 'a plain wrapper', postinstall: 'bun run gen' },
  { name: 'a --cwd runner pointing at this package', postinstall: 'bun run --cwd . gen' },
  { name: 'a direct invocation', postinstall: 'wrangler types' },
])('credits $name with generating this package worker types', ({ postinstall }) => {
  expect(postinstallGeneratesWorkerTypes({ gen: 'wrangler types', postinstall })).toBe(true);
});
