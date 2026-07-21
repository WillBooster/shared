import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { generateReadme, writeBadgeBlock } from '../src/generators/readme.js';
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

test('orders the block as workflows, semantic-release, then wbfy', async () => {
  await withTempDir(async (dirPath) => {
    const workflowsPath = path.resolve(dirPath, '.github', 'workflows');
    fs.mkdirSync(workflowsPath, { recursive: true });
    fs.writeFileSync(path.resolve(workflowsPath, 'test.yml'), 'name: test\n');
    fs.writeFileSync(path.resolve(dirPath, '.releaserc.json'), '{}\n');
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), '# Project\n\nBody text.\n');

    const firstContent = await runGenerateReadme(dirPath, '1.2.3');
    expect(firstContent).toBe(
      `# Project\n\n[![Test](https://github.com/WillBooster/example/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/example/actions/workflows/test.yml)\n[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)\n${badgeOf('1.2.3')}\n\nBody text.\n`
    );
    // Rewriting the whole block means the order is re-established on every run, not just the first.
    expect(await runGenerateReadme(dirPath, '1.2.3')).toBe(firstContent);
    expect(await runGenerateReadme(dirPath, '1.2.3')).toBe(firstContent);
  });
});

test.each([
  {
    name: 'no blank line after the heading',
    input: '# Project\nDescription.\n',
    expected: `# Project\n\n${badgeOf('1.2.3')}\n\nDescription.\n`,
  },
  {
    name: 'CRLF line endings',
    input: '# Project\r\n\r\nDescription.\r\n',
    expected: `# Project\r\n\r\n${badgeOf('1.2.3')}\r\n\r\nDescription.\r\n`,
  },
  {
    // A Setext heading is a heading to the parser, so the badges land under it like they do under
    // the `# <name>` form wbfy writes.
    name: 'a Setext heading',
    input: 'Project\n=======\nDescription.\n',
    expected: `Project\n=======\n\n${badgeOf('1.2.3')}\n\nDescription.\n`,
  },
  {
    // Many READMEs center their title in HTML; the badges follow the whole HTML block.
    name: 'an HTML title',
    input: '<h1 align="center">Project</h1>\n\nDescription.\n',
    expected: `<h1 align="center">Project</h1>\n\n${badgeOf('1.2.3')}\n\nDescription.\n`,
  },
  {
    // A BOM is not Markdown: left in the text it hid the `#` from the title check, so the badges
    // were prepended ahead of the marker and the heading stopped being a heading.
    name: 'a UTF-8 BOM before the title',
    input: '﻿# Project\n\nDescription.\n',
    expected: `﻿# Project\n\n${badgeOf('1.2.3')}\n\nDescription.\n`,
  },
  {
    // An indented code block reads exactly like a badge line once trimmed, so the line-based scan
    // consumed it and the example was deleted from the README.
    name: 'an indented code block under the title',
    input: `# Project\n\n    ${legacyBadge}\n`,
    expected: `# Project\n\n${badgeOf('1.2.3')}\n\n    ${legacyBadge}\n`,
  },
  {
    name: 'a badge example inside a multiline code span',
    input: `# Project\n\n\`example:\n${legacyBadge}\`\n`,
    expected: `# Project\n\n${badgeOf('1.2.3')}\n\n\`example:\n${legacyBadge}\`\n`,
  },
  {
    // CommonMark allows a block quote marker with no following space.
    name: 'a fenced example inside a compact block quote',
    input: `# Project\n\n>\`\`\`\n>${legacyBadge}\n>\`\`\`\n`,
    expected: `# Project\n\n${badgeOf('1.2.3')}\n\n>\`\`\`\n>${legacyBadge}\n>\`\`\`\n`,
  },
  {
    name: 'an indented code block inside a block quote',
    input: `# Project\n\n>     ${legacyBadge}\n`,
    expected: `# Project\n\n${badgeOf('1.2.3')}\n\n>     ${legacyBadge}\n`,
  },
  {
    // HTML blocks are recognized by CommonMark's start/end conditions, not by a list of known tags.
    name: 'a badge inside an HTML block with an unknown tag',
    input: `# Project\n\n<custom-card>\n${legacyBadge}\n</custom-card>\n`,
    expected: `# Project\n\n${badgeOf('1.2.3')}\n\n<custom-card>\n${legacyBadge}\n</custom-card>\n`,
  },
  {
    name: 'a badge quoted below the title',
    input: `# Project\n\n> ${legacyBadge}\n`,
    expected: `# Project\n\n${badgeOf('1.2.3')}\n\n> ${legacyBadge}\n`,
  },
  {
    // A README that opens with something other than a title has no anchor to sit under, so the
    // badges go to the top rather than the generator hunting for a heading further down.
    name: 'content that does not open with a title',
    input: '```md\n# Example\n```\n\n# Project\n\nDescription.\n',
    expected: `${badgeOf('1.2.3')}\n\n\`\`\`md\n# Example\n\`\`\`\n\n# Project\n\nDescription.\n`,
  },
  {
    name: 'front matter before the title',
    input: '---\ntitle: Project\n---\n\n# Project\n\nDescription.\n',
    expected: `---\ntitle: Project\n---\n\n# Project\n\n${badgeOf('1.2.3')}\n\nDescription.\n`,
  },
  {
    name: 'no title at all',
    input: 'Just a description.\n',
    expected: `${badgeOf('1.2.3')}\n\nJust a description.\n`,
  },
])('places the badge correctly with $name', async ({ input, expected }) => {
  await withTempDir(async (dirPath) => {
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), input);

    expect(await runGenerateReadme(dirPath, '1.2.3')).toBe(expected);
    expect(await runGenerateReadme(dirPath, '1.2.3')).toBe(expected);
  });
});

test('supersedes a badge whose image URL format changed', async () => {
  await withTempDir(async (dirPath) => {
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `# example\n\n${legacyBadge}\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content).toBe(`# example\n\n${badgeOf('1.2.3')}\n`);
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

test('supersedes a workflow badge carrying query parameters', async () => {
  await withTempDir(async (dirPath) => {
    const workflowsPath = path.resolve(dirPath, '.github', 'workflows');
    fs.mkdirSync(workflowsPath, { recursive: true });
    fs.writeFileSync(path.resolve(workflowsPath, 'test.yml'), 'name: test\n');
    const staleBadge =
      '[![Test](https://github.com/WillBooster/shared/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/WillBooster/shared/actions/workflows/test.yml)';
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `# Project\n\n${staleBadge}\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content).not.toContain('?branch=main');
    expect(content.split('actions/workflows/test.yml/badge.svg')).toHaveLength(2);
  });
});

test('stays idempotent with a Markdown-significant workflow filename', async () => {
  await withTempDir(async (dirPath) => {
    // An unencoded `(` would end the Markdown destination early, so wbfy could not read its own
    // badge back and added a second one on the next run.
    const workflowsPath = path.resolve(dirPath, '.github', 'workflows');
    fs.mkdirSync(workflowsPath, { recursive: true });
    fs.writeFileSync(path.resolve(workflowsPath, 'test(foo).yml'), 'name: test\n');
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), '# Project\n\nBody.\n');

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content).toContain('test%28foo%29.yml');
    expect(await runGenerateReadme(dirPath, '1.2.3')).toBe(content);
  });
});

test('replaces a badge block stamped above a title-less README', async () => {
  await withTempDir(async (dirPath) => {
    // Nothing is searched for beyond the first content, so a heading added later cannot orphan the
    // badges already at the top.
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `${legacyBadge}\n\nDescription.\n\n## Usage\n\nSteps.\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content).toBe(`${badgeOf('1.2.3')}\n\nDescription.\n\n## Usage\n\nSteps.\n`);
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

test('leaves everything below the badge block untouched', async () => {
  await withTempDir(async (dirPath) => {
    // The badge block is the only region wbfy edits, so an example badge in a fenced block, in a
    // comment or in prose survives without the generator understanding any of those constructs.
    const body = [
      '```md',
      legacyBadge,
      '',
      '',
      'Preserve two blank lines above.',
      '```',
      '',
      '<!--',
      legacyBadge,
      '-->',
      '',
      `Write ${legacyBadge} inline.`,
    ].join('\n');
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `# Project\n\n${body}\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content).toBe(`# Project\n\n${badgeOf('1.2.3')}\n\n${body}\n`);
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

// An `<h1>` mentioned in a comment or an attribute is not a rendered title, so anchoring the badges
// to it would bury them below the real heading.
test.each([
  ['a comment', '<!-- documentation example: <h1>Example</h1> -->'],
  ['an attribute', '<div title="<h1>"></div>'],
])('does not treat an <h1> inside %s as the title', async (_description, htmlBlock) => {
  await withTempDir(async (dirPath) => {
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `${htmlBlock}\n\n# Real title\n\nDescription.\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content.indexOf(badgeOf('1.2.3'))).toBeLessThan(content.indexOf(htmlBlock));
  });
});

// A genuinely rendered HTML title still anchors the block.
test('treats a rendered HTML <h1> as the title', async () => {
  await withTempDir(async (dirPath) => {
    const htmlTitle = '<div align="center"><h1>Example</h1></div>';
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), `${htmlTitle}\n\nDescription.\n`);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content.indexOf(badgeOf('1.2.3'))).toBeGreaterThan(content.indexOf(htmlTitle));
  });
});

// The normal input is an earlier wbfy run's output. Older versions recognized neither Setext nor
// HTML titles, so they stamped the block ABOVE such a title; upgrading must move it below, or the
// new placement would only ever apply to READMEs wbfy has never touched.
test.each([
  ['a Setext title', 'Project\n=======\n'],
  ['an HTML title', '<div align="center"><h1>Project</h1></div>\n'],
])('moves a legacy block below %s on upgrade', async (_description, title) => {
  await withTempDir(async (dirPath) => {
    const legacyLayout = `${badgeOf('1.0.0')}\n\n${title}\nDescription.\n`;
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), legacyLayout);

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content.indexOf(badgeOf('1.2.3'))).toBeGreaterThan(content.indexOf('Project'));
    expect(content).not.toContain('1.0.0');
    // Idempotent from the upgraded layout too.
    expect(await runGenerateReadme(dirPath, '1.2.3')).toBe(content);
  });
});

// A badge someone else put in the legacy block must survive the move rather than be dropped with it.
test('carries an unrelated badge down when relocating a legacy block', async () => {
  await withTempDir(async (dirPath) => {
    const unrelated = '[![custom](https://example.test/b.svg)](https://example.test)';
    fs.writeFileSync(
      path.resolve(dirPath, 'README.md'),
      `${badgeOf('1.0.0')}\n${unrelated}\n\nProject\n=======\n\nDescription.\n`
    );

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content).toContain(unrelated);
    expect(content.indexOf(unrelated)).toBeGreaterThan(content.indexOf('Project'));
  });
});

// Front matter whose closing delimiter ends at EOF carries no newline of its own.
test('separates front matter ending at EOF from the badge block', async () => {
  await withTempDir(async (dirPath) => {
    fs.writeFileSync(path.resolve(dirPath, 'README.md'), '---\ntitle: Project\n---');

    const content = await runGenerateReadme(dirPath, '1.2.3');
    expect(content).toContain('---\n\n[![wbfy]');
  });
});

// mdast reports a node's offset AFTER CommonMark's optional one-to-three-space indentation, so
// slicing from it would silently reindent content this generator promises to copy verbatim.
// Asserted on writeBadgeBlock directly: generateFile separately trims the file's leading whitespace,
// which would mask the first-line cases.
test.each([
  ['before an untitled body', '   intro\n'],
  ['before the title', ' # Heading\n\nBody\n'],
  ['before the body', '# Heading\n\n   body\n'],
])('preserves leading indentation %s', (_description, input) => {
  const result = writeBadgeBlock(input, [badgeOf('1.2.3')]);
  for (const line of input.split('\n').filter((candidate) => candidate.trim())) {
    expect(result).toContain(line);
  }
});

// A title-less README's leading block is the badge block itself, not something to skip past.
test('keeps an unrelated badge in a title-less leading block', () => {
  const unrelated = '[![custom](https://example.test/b.svg)](https://example.test)';
  const result = writeBadgeBlock(`${badgeOf('1.0.0')}\n${unrelated}\n\nDescription.\n`, [badgeOf('1.2.3')]);

  expect(result).toContain(unrelated);
  expect(result).not.toContain('1.0.0');
});

// Only wbfy's own output is migratable; a user's custom-only badge layout stays where they put it.
test('leaves a user-authored badge block above the title', () => {
  const custom = '[![custom](https://example.test/b.svg)](https://example.test)';
  const first = writeBadgeBlock(`${custom}\n\n# Project\n\nDescription.\n`, [badgeOf('1.2.3')]);

  expect(first.indexOf(custom)).toBeLessThan(first.indexOf('# Project'));
  // wbfy's own block goes BELOW the title, so the next run does not see a managed badge in the
  // user's block and relocate the whole thing.
  expect(first.indexOf(badgeOf('1.2.3'))).toBeGreaterThan(first.indexOf('# Project'));
  expect(writeBadgeBlock(first, [badgeOf('1.2.3')])).toBe(first);
});

// Quoting is significant only inside a start tag; quotation marks in ordinary text are text.
test('treats an <h1> surrounded by quotation marks in text as the title', () => {
  const htmlTitle = '<div>\n"<h1>Project</h1>"\n</div>';
  const result = writeBadgeBlock(`${htmlTitle}\n\nDescription.\n`, [badgeOf('1.2.3')]);

  expect(result.indexOf(badgeOf('1.2.3'))).toBeGreaterThan(result.indexOf(htmlTitle));
});

// HTML parses these elements' content as raw text, so a tag written inside one is not an element.
test.each(['script', 'style', 'textarea', 'title'])('ignores an <h1> inside <%s>', (element) => {
  const htmlBlock = `<${element}>const example = "<h1>Not a title</h1>";</${element}>`;
  const result = writeBadgeBlock(`${htmlBlock}\n\n# Real title\n\nBody.\n`, [badgeOf('1.2.3')]);

  expect(result.indexOf(badgeOf('1.2.3'))).toBeLessThan(result.indexOf(htmlBlock));
});
