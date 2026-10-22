import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { fixNextConfigJson } from '../../src/fixers/nextConfig.js';
import { fixViteConfig } from '../../src/fixers/viteConfig.js';
import { generateRenovateJsonc } from '../../src/generators/renovateJsonc.js';
import { createConfig } from '../helpers/testConfig.js';

const pluginReactPackageJson = JSON.stringify({
  name: '@vitejs/plugin-react',
  peerDependencies: { 'oxc-transform-react': '^0.152.0', vite: '^8.0.0' },
});
const viteConfigHeader = `import { defineConfig } from 'vite';
import vinext from 'vinext';
`;

test.each([
  ['no options', 'vinext()', 'vinext({ react: { compiler: { reportDiagnostics: true } } })'],
  [
    'unrelated options',
    'vinext({ cache: { data: adapter() } })',
    'vinext({ cache: { data: adapter() }, react: { compiler: { reportDiagnostics: true } } })',
  ],
  [
    'a boolean compiler',
    'vinext({ react: { compiler: true } })',
    'vinext({ react: { compiler: { reportDiagnostics: true } } })',
  ],
  [
    'other compiler options',
    "vinext({ react: { compiler: { target: '19' } } })",
    "vinext({ react: { compiler: { target: '19', reportDiagnostics: true } } })",
  ],
])('enables the React Compiler in a vinext call with %s', async (_, oldCall, newCall) => {
  await withVinextPackage(
    { 'vite.config.ts': `${viteConfigHeader}export default defineConfig({ plugins: [${oldCall}] });\n` },
    async (dirPath) => {
      await fixViteConfig(createVinextConfig(dirPath));

      // `bun cleanup` formats the spliced text after wbfy runs, so compare without whitespace.
      expect(removeWhitespace(fs.readFileSync(path.join(dirPath, 'vite.config.ts'), 'utf8'))).toBe(
        removeWhitespace(`${viteConfigHeader}export default defineConfig({ plugins: [${newCall}] });`)
      );
    }
  );
});

test.each([
  ['a spread', 'vinext({ react: { compiler: true }, ...options })'],
  ['a duplicate key', 'vinext({ react: { compiler: true }, react: { compiler: false } })'],
  ['an opted-out react plugin', 'vinext({ react: false })'],
])('leaves vinext options with %s untouched', async (_, call) => {
  const content = `${viteConfigHeader}const options = {};\nexport default defineConfig({ plugins: [${call}] });\n`;
  await withVinextPackage({ 'vite.config.ts': content }, async (dirPath) => {
    await fixViteConfig(createVinextConfig(dirPath));

    expect(fs.readFileSync(path.join(dirPath, 'vite.config.ts'), 'utf8')).toBe(content);
  });
});

test('removes reactCompiler from next.config.ts in a vinext package', async () => {
  await withVinextPackage(
    {
      'next.config.ts': `import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: true },
  reactCompiler: true // enabled for now, but a, b
};

export default nextConfig;
`,
    },
    async (dirPath) => {
      await fixNextConfigJson(createVinextConfig(dirPath));

      const content = fs.readFileSync(path.join(dirPath, 'next.config.ts'), 'utf8');
      expect(content).not.toContain('reactCompiler');
      expect(content).toContain('typescript: { ignoreBuildErrors: true }, // enabled for now, but a, b\n};');
    }
  );
});

test('groups the React Compiler packages in Renovate while keeping custom rules', async () => {
  const customPin = { matchPackageNames: ['oxc-transform-react'], allowedVersions: '~0.152.0' };
  await withVinextPackage({ 'renovate.jsonc': JSON.stringify({ packageRules: [customPin] }) }, async (dirPath) => {
    const config = createVinextConfig(dirPath);
    await generateRenovateJsonc(config);
    await generateRenovateJsonc(config);

    const settings = JSON.parse(fs.readFileSync(path.join(dirPath, 'renovate.jsonc'), 'utf8')) as {
      packageRules: Record<string, unknown>[];
    };
    expect(settings.packageRules).toEqual([
      customPin,
      expect.objectContaining({
        matchPackageNames: ['@vitejs/plugin-react', 'oxc-transform-react'],
        automerge: false,
      }),
      expect.objectContaining({ matchPackageNames: ['oxc-transform-react'], allowedVersions: '^0.152.0' }),
    ]);
  });
});

function removeWhitespace(text: string): string {
  return text.replaceAll(/\s/gu, '');
}

function createVinextConfig(dirPath: string): ReturnType<typeof createConfig> {
  const config = createConfig({ dirPath, isRoot: true });
  Object.assign(config.depending, { next: true, vinext: true });
  return config;
}

async function withVinextPackage(
  files: Record<string, string>,
  run: (dirPath: string) => Promise<void>
): Promise<void> {
  const dirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-vinext-')));
  try {
    for (const [relativePath, content] of Object.entries({
      ...files,
      'node_modules/@vitejs/plugin-react/package.json': pluginReactPackageJson,
    })) {
      const filePath = path.join(dirPath, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
    await run(dirPath);
  } finally {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}
