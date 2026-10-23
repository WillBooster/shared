import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fixNextConfigJson } from '../../src/fixers/nextConfig.js';
import { fixViteConfig } from '../../src/fixers/viteConfig.js';
import { createConfig } from '../helpers/testConfig.js';

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

test.each([
  [
    'an arrow function',
    `const images: NextConfig = { images: { unoptimized: true } };

const nextConfig = (phase: string): NextConfig => ({
  ...images,
  reactCompiler: true,
  reactStrictMode: phase !== 'test',
  typescript: { ignoreBuildErrors: true },
});

export default nextConfig;
`,
  ],
  [
    'an untyped variable next to a typed helper function',
    `const buildImages = (): NextConfig => ({ images: { unoptimized: true } });

const nextConfig = (phase: string) => ({
  ...buildImages(),
  reactCompiler: true,
  reactStrictMode: phase !== 'test',
  typescript: { ignoreBuildErrors: true },
});

export default nextConfig;
`,
  ],
  [
    'a wrapped variable next to a typed helper function',
    `const buildImages = (): NextConfig => ({ images: { unoptimized: true } });
const withPlugins = (config: NextConfig): NextConfig => config;

const phase = process.env.NODE_ENV;

const nextConfig: NextConfig = {
  ...buildImages(),
  reactCompiler: true,
  reactStrictMode: phase !== 'test',
  typescript: { ignoreBuildErrors: true },
};

export default withPlugins(nextConfig);
`,
  ],
  [
    'a satisfies-checked object behind a wrapper call',
    `const withPlugins = (config: NextConfig): NextConfig => config;
const phase = process.env.NODE_ENV;

const nextConfig = {
  reactCompiler: true,
  reactStrictMode: phase !== 'test',
  typescript: { ignoreBuildErrors: true },
} satisfies NextConfig;

export default withPlugins(nextConfig);
`,
  ],
  [
    'a function declaration',
    `const images: NextConfig = { images: { unoptimized: true } };

export default function nextConfig(phase: string): NextConfig {
  return {
    ...images,
    reactCompiler: true,
    reactStrictMode: phase !== 'test',
    typescript: { ignoreBuildErrors: true },
  };
}
`,
  ],
])('removes reactCompiler from a next.config.ts exporting %s of the phase in a vinext package', async (_, body) => {
  await withVinextPackage(
    { 'next.config.ts': `import type { NextConfig } from 'next';\n\n${body}` },
    async (dirPath) => {
      await fixNextConfigJson(createVinextConfig(dirPath));

      const content = fs.readFileSync(path.join(dirPath, 'next.config.ts'), 'utf8');
      expect(content).not.toContain('reactCompiler');
      expect(content).toContain("reactStrictMode: phase !== 'test'");
    }
  );
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
    for (const [relativePath, content] of Object.entries(files)) {
      const filePath = path.join(dirPath, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
    await run(dirPath);
  } finally {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}
