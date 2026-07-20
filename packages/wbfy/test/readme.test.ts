import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { generateReadme } from '../src/generators/readme.js';
import { fsUtil } from '../src/utils/fsUtil.js';
import { promisePool } from '../src/utils/promisePool.js';
import * as version from '../src/utils/version.js';
import { createConfig } from './testConfig.js';

const legacyBadge =
  '[![wbfy](https://img.shields.io/badge/-wbfy-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)';

function badgeOf(label: string): string {
  return `[![wbfy](https://img.shields.io/badge/wbfy-${label}-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)`;
}

async function withTempDir(test: (dirPath: string) => Promise<void>): Promise<void> {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-readme-'));
  try {
    await test(dirPath);
  } finally {
    fs.rmSync(dirPath, { force: true, recursive: true });
  }
}

// setRootDirPath is process-wide state: leaving a deleted temporary directory behind would confine
// any later test sharing this worker to a repository root that no longer exists.
afterEach(() => {
  fsUtil.setRootDirPath(undefined);
  vi.restoreAllMocks();
});

async function runGenerateReadme(dirPath: string, versionLabel: string | undefined): Promise<string> {
  vi.spyOn(version, 'getWbfyVersionLabel').mockReturnValue(versionLabel);
  fsUtil.setRootDirPath(dirPath);
  await generateReadme(createConfig({ dirPath, isRoot: true, packageJson: { name: 'example' } }));
  await promisePool.promiseAll();
  return fs.readFileSync(path.resolve(dirPath, 'README.md'), 'utf8');
}

test('stamps the released version and stays idempotent', async () => {
  await withTempDir(async (dirPath) => {
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), '# example\n\nA description.\n');

    const firstContent = await runGenerateReadme(dirPath, '1.2.3');
    expect(firstContent).toContain(badgeOf('1.2.3'));
    expect(await runGenerateReadme(dirPath, '1.2.3')).toBe(firstContent);
    expect(firstContent.split(badgeOf('1.2.3'))).toHaveLength(2);

    // A newer wbfy replaces the version instead of appending a second badge.
    const updatedContent = await runGenerateReadme(dirPath, '2.0.0');
    expect(updatedContent).toContain(badgeOf('2.0.0'));
    expect(updatedContent).not.toContain('1.2.3');
  });
});

test.each([
  {
    name: 'leading HTML comment',
    input: '<!--\n\nGenerated file; edit elsewhere.\n-->\n\n# Project\n\nDescription.\n',
    expected: `<!--\n\nGenerated file; edit elsewhere.\n-->\n\n# Project\n\n${badgeOf('1.2.3')}\n\nDescription.\n`,
  },
  {
    name: 'CRLF line endings',
    input: '# Project\r\n\r\nDescription.\r\n',
    expected: `# Project\r\n\r\n${badgeOf('1.2.3')}\r\n\r\nDescription.\r\n`,
  },
  {
    name: 'no blank line after the heading',
    input: '# Project\nDescription.\n',
    expected: `# Project\n\n${badgeOf('1.2.3')}\n\nDescription.\n`,
  },
  {
    name: 'an inline HTML comment in the heading',
    input: '# Project <!-- generated -->\nDescription.\n',
    expected: `# Project <!-- generated -->\n\n${badgeOf('1.2.3')}\n\nDescription.\n`,
  },
  {
    name: 'a Setext heading',
    input: 'Project\n=======\nDescription.\n',
    expected: `Project\n=======\n\n${badgeOf('1.2.3')}\n\nDescription.\n`,
  },
  {
    name: 'a dash-style Setext heading',
    input: 'Project\n-------\nDescription.\n',
    expected: `Project\n-------\n\n${badgeOf('1.2.3')}\n\nDescription.\n`,
  },
  {
    name: 'front matter without a heading',
    input: '---\ntitle: Project\n---\n\nDescription.\n',
    expected: `---\ntitle: Project\n---\n\n${badgeOf('1.2.3')}\n\nDescription.\n`,
  },
  {
    name: 'a fence containing a non-closing fence line',
    input: '```md\n```not-a-close\n# still code\n```\n# Project\nDescription.\n',
    expected: `\`\`\`md\n\`\`\`not-a-close\n# still code\n\`\`\`\n# Project\n\n${badgeOf('1.2.3')}\n\nDescription.\n`,
  },
  {
    name: 'a tab-indented code block without a heading',
    input: '\t# comment inside code\nCode content.\n',
    expected: `${badgeOf('1.2.3')}\n\n\t# comment inside code\nCode content.\n`,
  },
  {
    name: 'a fenced example nested directly in a list',
    input: '- ```md\n  # Example\n  ```\n\n# Project\n',
    expected: `- \`\`\`md\n  # Example\n  \`\`\`\n\n# Project\n\n${badgeOf('1.2.3')}\n`,
  },
  {
    name: 'a centered HTML title',
    input: '<h1 align="center">Project</h1>\n\nDescription.\n',
    expected: `<h1 align="center">Project</h1>\n\n${badgeOf('1.2.3')}\n\nDescription.\n`,
  },
  {
    name: 'a multiline HTML title',
    input: '<h1 align="center">\n  Project\n</h1>\n\nDescription.\n',
    expected: `<h1 align="center">\n  Project\n</h1>\n\n${badgeOf('1.2.3')}\n\nDescription.\n`,
  },
  {
    name: 'a commented-out closing tag in an HTML title',
    input: '<h1>\nProject\n<!-- </h1> old close -->\n</h1>\n\nBody.\n',
    expected: `<h1>\nProject\n<!-- </h1> old close -->\n</h1>\n\n${badgeOf('1.2.3')}\n\nBody.\n`,
  },
  {
    name: 'prose that starts with a link',
    input: '# Project\n\n[Documentation](docs.md) explains setup.\n',
    expected: `# Project\n\n${badgeOf('1.2.3')}\n\n[Documentation](docs.md) explains setup.\n`,
  },
  {
    name: 'a heading inside a collapsed details section',
    input: '<details>\n<summary>Example</summary>\n\n# Example\n\nHidden.\n</details>\n\n# Project\n\nVisible.\n',
    expected: `<details>\n<summary>Example</summary>\n\n# Example\n\nHidden.\n</details>\n\n# Project\n\n${badgeOf('1.2.3')}\n\nVisible.\n`,
  },
  {
    name: 'a heading inside a raw div block',
    input: '<div>\n# Example\n</div>\n\n# Project\n',
    expected: `<div>\n# Example\n</div>\n\n# Project\n\n${badgeOf('1.2.3')}\n`,
  },
  {
    name: 'a commented-out details tag before the title',
    input: '<!-- <details> -->\n# Project\n',
    expected: `<!-- <details> -->\n# Project\n\n${badgeOf('1.2.3')}\n`,
  },
  {
    name: 'a reference-style badge under the title',
    input: '# Project\n\n[![Build][build-image]][build-url]\n\n[build-image]: build.svg\n[build-url]: build\n',
    expected: `# Project\n\n${badgeOf('1.2.3')}\n[![Build][build-image]][build-url]\n\n[build-image]: build.svg\n[build-url]: build\n`,
  },
  {
    name: 'a leading thematic break that is not front matter',
    input: '---\n# Project\nBody.\n',
    expected: `---\n# Project\n\n${badgeOf('1.2.3')}\n\nBody.\n`,
  },
  {
    name: 'a level-2 heading as the only title',
    input: '## Project\n\nBody.\n',
    expected: `## Project\n\n${badgeOf('1.2.3')}\n\nBody.\n`,
  },
  {
    name: 'a level-2 heading above the real title',
    input: '## Intro\n\nText.\n\n# Real Title\n\nBody.\n',
    expected: `## Intro\n\nText.\n\n# Real Title\n\n${badgeOf('1.2.3')}\n\nBody.\n`,
  },
  {
    name: 'a heading inside a section block',
    input: '<section>\n# Example\n</section>\n\n# Project\n',
    expected: `<section>\n# Example\n</section>\n\n# Project\n\n${badgeOf('1.2.3')}\n`,
  },
  {
    name: 'an HTML block left unclosed before the title',
    input: '<div>Raw HTML\n\n# Project\n',
    expected: `<div>Raw HTML\n\n# Project\n\n${badgeOf('1.2.3')}\n`,
  },
  {
    name: 'a CDATA section',
    input: '<![CDATA[\n# Example\n]]>\n\n# Project\n',
    expected: `<![CDATA[\n# Example\n]]>\n\n# Project\n\n${badgeOf('1.2.3')}\n`,
  },
  {
    name: 'a commented-out details tag inside an HTML block',
    input: '<div><!-- <details> --></div>\n\n# Project\n',
    expected: `<div><!-- <details> --></div>\n\n# Project\n\n${badgeOf('1.2.3')}\n`,
  },
  {
    name: 'a closing tag inside an HTML title attribute',
    input: '<h1 title="literal </h1> text">\nProject\n</h1>\n\nBody.\n',
    expected: `<h1 title="literal </h1> text">\nProject\n</h1>\n\n${badgeOf('1.2.3')}\n\nBody.\n`,
  },
  {
    name: 'a fence left unclosed inside a list item',
    input: '- ```md\n  # Example\n\n# Project\n',
    expected: `- \`\`\`md\n  # Example\n\n# Project\n\n${badgeOf('1.2.3')}\n`,
  },
  {
    name: 'a closing details tag inside an attribute',
    input:
      '<details title="foo </details> bar">\n<summary>x</summary>\n\n# Hidden\n\nH.\n</details>\n\n# Project\n\nV.\n',
    expected: `<details title="foo </details> bar">\n<summary>x</summary>\n\n# Hidden\n\nH.\n</details>\n\n# Project\n\n${badgeOf('1.2.3')}\n\nV.\n`,
  },
  {
    name: 'an escaped details tag before the title',
    input: '\\<details>\n# Project\n',
    expected: `\\<details>\n# Project\n\n${badgeOf('1.2.3')}\n`,
  },
  {
    name: 'a comment opener inside an HTML attribute',
    input: '<div data-prefix="<!--"></div>\n\n# Project\n',
    expected: `<div data-prefix="<!--"></div>\n\n# Project\n\n${badgeOf('1.2.3')}\n`,
  },
  {
    name: 'a raw HTML block',
    input: '<pre>\n# Example\n</pre>\n\n# Project\n',
    expected: `<pre>\n# Example\n</pre>\n\n# Project\n\n${badgeOf('1.2.3')}\n`,
  },
])('places the badge correctly with $name', async ({ input, expected }) => {
  await withTempDir(async (dirPath) => {
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), input);

    expect(await runGenerateReadme(dirPath, '1.2.3')).toBe(expected);
    expect(await runGenerateReadme(dirPath, '1.2.3')).toBe(expected);
  });
});

test('preserves badge examples and whitespace inside fenced code', async () => {
  await withTempDir(async (dirPath) => {
    const example = `\`\`\`md\n${legacyBadge}\n\n\nPreserve two blank lines above.\n\`\`\``;
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `# Project\n\n${example}\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content).toBe(`# Project\n\n${badgeOf('1.2.3')}\n\n${example}\n`);
  });
});

test('does not merge lines when replacing an inline legacy badge', async () => {
  await withTempDir(async (dirPath) => {
    const otherBadge = '[![Test](https://example.com/test.svg)](https://example.com/test)';
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `# Project\n\n${otherBadge} ${legacyBadge}\nDescription.\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content).toBe(`# Project\n\n${badgeOf('1.2.3')}\n${otherBadge} \nDescription.\n`);
  });
});

test('stays idempotent when another badge sits above the body', async () => {
  await withTempDir(async (dirPath) => {
    // The wbfy badge is inserted first, so any second badge pushes it against the body — the case
    // where an emptied badge line used to leave a blank line behind and grow the file on every run.
    fs.writeFileSync(path.resolve(dirPath, '.releaserc.json'), '{}\n');
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), '# Project\n\nBody text.\n');

    const firstContent = await runGenerateReadme(dirPath, '1.2.3');
    expect(firstContent).toContain('semantic-release');
    expect(await runGenerateReadme(dirPath, '1.2.3')).toBe(firstContent);
    expect(await runGenerateReadme(dirPath, '1.2.3')).toBe(firstContent);
  });
});

test('supersedes a badge embedded in the title line', async () => {
  await withTempDir(async (dirPath) => {
    const oldBadge = '[![wbfy](https://img.shields.io/badge/wbfy-0.9.0-1e90ff.svg)](https://example.com/old-wbfy)';
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `# Project ${oldBadge}\n\nDescription.\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content).not.toContain('0.9.0');
    expect(content.split('img.shields.io/badge')).toHaveLength(2);
  });
});

test('keeps a badge shown as an inline-code example', async () => {
  await withTempDir(async (dirPath) => {
    const example = `\`${legacyBadge}\``;
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `# Project\n\nUse ${example} to mark it.\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content).toContain(example);
    expect(content).toContain(badgeOf('1.2.3'));
  });
});

test('keeps a badge inside a code span that spans lines', async () => {
  await withTempDir(async (dirPath) => {
    const example = `\`code across\n${legacyBadge}\nlines\``;
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `# Project\n\nUse ${example} as example.\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content).toContain(example);
    expect(await runGenerateReadme(dirPath, '1.2.3')).toBe(content);
  });
});

test('supersedes a badge between escaped backticks', async () => {
  await withTempDir(async (dirPath) => {
    // `\`` is literal text, not a code-span delimiter, so the badge between them is live Markdown.
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `# Project\n\nA \\\`${legacyBadge}\\\` b.\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content.split('img.shields.io/badge')).toHaveLength(2);
  });
});

test('keeps a badge example inside a compact block quote', async () => {
  await withTempDir(async (dirPath) => {
    const example = `>\`\`\`md\n>${legacyBadge}\n>\`\`\``;
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `# Project\n\n${example}\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content).toContain(example);
  });
});

test('supersedes a badge after a multiline comment ends', async () => {
  await withTempDir(async (dirPath) => {
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `# Project\n\nText <!-- note\n--> ${legacyBadge}\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content.split('img.shields.io/badge')).toHaveLength(2);
  });
});

test('supersedes an unlinked wbfy badge', async () => {
  await withTempDir(async (dirPath) => {
    fs.writeFileSync(
      path.resolve(dirPath, 'README.md'),
      '# Project\n\n![wbfy](https://img.shields.io/badge/-wbfy-1e90ff.svg)\n'
    );

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content).toBe(`# Project\n\n${badgeOf('1.2.3')}\n`);
  });
});

test('keeps a badge whose opening bracket is escaped', async () => {
  await withTempDir(async (dirPath) => {
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `# Project\n\nWrite \\${legacyBadge} to show it.\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content).toContain(`\\${legacyBadge}`);
    expect(await runGenerateReadme(dirPath, '1.2.3')).toBe(content);
  });
});

test('supersedes a badge below a stray unmatched backtick', async () => {
  await withTempDir(async (dirPath) => {
    // The backtick has no closer in the paragraph, so it is literal text and protects nothing.
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `# Project\n\nText \`\n${legacyBadge}\nBody.\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content.split('img.shields.io/badge')).toHaveLength(2);
  });
});

test('supersedes a badge below an unmatched backtick in a heading', async () => {
  await withTempDir(async (dirPath) => {
    // A heading's inline content ends with its own line, so its backtick cannot pair with a later one.
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `# Project \`\n\n${legacyBadge}\ntext \`\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content.split('img.shields.io/badge')).toHaveLength(2);
  });
});

test('supersedes a badge whose image URL format changed', async () => {
  await withTempDir(async (dirPath) => {
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `# example\n\n${legacyBadge}\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content).toBe(`# example\n\n${badgeOf('1.2.3')}\n`);
  });
});

test('supersedes a badge trailed by an inline HTML comment', async () => {
  await withTempDir(async (dirPath) => {
    const comment = '<!-- managed badge -->';
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `# example\n\n${legacyBadge} ${comment}\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content).toContain(comment);
    expect(content.split('img.shields.io/badge')).toHaveLength(2);
  });
});

test('keeps a badge that is itself commented out', async () => {
  await withTempDir(async (dirPath) => {
    const commentedBadge = `<!-- ${legacyBadge} -->`;
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `# example\n\n${commentedBadge}\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content).toContain(commentedBadge);
    expect(content).toContain(badgeOf('1.2.3'));
  });
});

test('supersedes a badge below an inline-code comment opener', async () => {
  await withTempDir(async (dirPath) => {
    // A `<!--` inside inline code must not protect the rest of the file; the badge under it is still
    // managed, and failing to remove it duplicates the badge on every run.
    fs.writeFileSync(
      path.resolve(dirPath, 'README.md'),
      `# Project\n\nUse \`<!--\` to show a comment opener.\n\n${legacyBadge}\n`
    );

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content.split('img.shields.io/badge')).toHaveLength(2);
    expect(content).toContain(badgeOf('1.2.3'));
  });
});

test('preserves a badge example inside a multiline comment', async () => {
  await withTempDir(async (dirPath) => {
    const comment = `<!--\n${legacyBadge}\n\n# Not the title\n-->`;
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `# Project\n\n${comment}\n\nBody.\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content).toBe(`# Project\n\n${badgeOf('1.2.3')}\n\n${comment}\n\nBody.\n`);
  });
});

test('supersedes a badge whose link changed', async () => {
  await withTempDir(async (dirPath) => {
    const oldLinkBadge = '[![wbfy](https://img.shields.io/badge/wbfy-0.9.0-1e90ff.svg)](https://example.com/old-wbfy)';
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `# example\n\n${oldLinkBadge}\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content).toBe(`# example\n\n${badgeOf('1.2.3')}\n`);
  });
});

test('keeps an unrelated image that merely links to wbfy', async () => {
  await withTempDir(async (dirPath) => {
    const diagram =
      '[![Architecture diagram](./architecture.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)';
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `# example\n\n${diagram}\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content).toContain(diagram);
    expect(content).toContain(badgeOf('1.2.3'));
  });
});

test('marks a run from an unreleased checkout with its commit hash', async () => {
  await withTempDir(async (dirPath) => {
    await runGenerateReadme(dirPath, '1.2.3');

    const localContent = await runGenerateReadme(dirPath, 'abc1234-local');
    expect(localContent).toContain(badgeOf('abc1234--local'));
    expect(localContent).not.toContain('1.2.3');
  });
});

test('creates a missing README with a version-less badge', async () => {
  await withTempDir(async (dirPath) => {
    expect(await runGenerateReadme(dirPath, undefined)).toBe(`# example\n\n${badgeOf('applied')}\n`);
  });
});

test('keeps an existing README that cannot be read', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.resolve(dirPath, 'README.md');
    fs.writeFileSync(filePath, '# example\n\nImportant content.\n');
    // Injected rather than provoked through permission bits: root bypasses those, so a chmod-based
    // test would silently exercise the success path instead in a root container.
    const error: NodeJS.ErrnoException = new Error('EACCES: permission denied');
    error.code = 'EACCES';
    vi.spyOn(fsUtil, 'readFileIfExists').mockRejectedValue(error);

    // generateReadme swallows the read failure, so the unreadable README must stay untouched
    // instead of being overwritten with the generated stub.
    await runGenerateReadme(dirPath, '1.2.3');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('# example\n\nImportant content.\n');
  });
});

test('resolves a real version label from wbfy itself', () => {
  // Either a released version or `<commit hash>[-dirty]-local`, never the unreleased placeholder.
  expect(version.getWbfyVersionLabel()).toMatch(/^(?:\d+\.\d+\.\d+|[0-9a-f]{8,}(?:-dirty)?-local)$/u);
});
