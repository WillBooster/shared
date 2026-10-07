import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { logger } from '../logger.js';
import { options } from '../options.js';
import { consumesGeneratedWorkerTypes, generatesWorkerTypes, type PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { ignoreFileUtil } from '../utils/ignoreFileUtil.js';
import { promisePool } from '../utils/promisePool.js';

// Do not remove `windows`: generated .gitignore files must keep ignoring Windows-created local artifacts.
const defaultNames = ['windows', 'macos', 'linux', 'jetbrains', 'visualstudiocode', 'emacs', 'vim', 'yarn'];

const commonContent = `
__generated__/
.aider*
.antigravitycli/
.claude/*.local.*
.claude/scheduled_tasks.lock
.devcontainer/
.docker.env
.env*
.idea/AugmentWebviewStateStore.xml
.idea/copilot.*
.idea/copilot/chatSessions/
.playwright-cli/
.playwright-mcp/
.serena/
.tmp/
.tmp-*/
.tokensave/
.wb/
@willbooster/
@willbooster-private/
*/mount/*.hash
CLAUDE.local.md
dist/
drizzle/mount/
temp/
tmp/
`;

interface TemplateEntries {
  names: string[];
  rules: string;
}

export async function generateGitignore(config: PackageConfig, rootConfig: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateGitignore', async () => {
    const filePath = path.resolve(config.dirPath, '.gitignore');
    const content = (await fsUtil.readFileIfExists(filePath)) ?? '';
    const projectFileEntries = getProjectFileEntries(config);
    const dependencyEntries = getDependencyEntries(config, rootConfig);
    let headUserContent =
      ignoreFileUtil.getHeadUserContent(content) +
      commonContent +
      projectFileEntries.rules +
      dependencyEntries.rules +
      (await syncWorkerTypesRule(config));
    if (rootConfig.depending.vinext || config.depending.vinext) {
      headUserContent += `.vinext/
`;
    }
    const tailUserContent = ignoreFileUtil.getTailUserContent(content);

    const templates = await readTemplates([...defaultNames, ...projectFileEntries.names, ...dependencyEntries.names]);
    if (templates === undefined) return;
    const isBerryZeroInstallEnabled = await ignoreFileUtil.isBerryZeroInstallEnabled(filePath);
    const generated = adjustTemplates(templates, config, rootConfig, isBerryZeroInstallEnabled);
    const newContent = headUserContent + '\n' + generated + tailUserContent;
    await promisePool.runAndWaitForReturnValue(() => fsUtil.generateFile(filePath, newContent));
  });
}

function getProjectFileEntries(config: PackageConfig): TemplateEntries {
  const names: string[] = [];
  let rules = '';
  if (config.doesContainGemfile) {
    names.push('ruby');
  }
  if (config.doesContainGoMod) {
    names.push('go');
    rules += `${path.basename(config.dirPath)}
`;
  }
  // Every accepted repository root receives a managed package.json later in the same run, so its
  // dependency tree must be ignored even when the manifest did not exist at config-detection time.
  if (config.doesContainPackageJson || config.isRoot) {
    names.push('node');
  }
  // Recursive detection (not just a root pom.xml): a multi-language repository keeps its Maven
  // modules in subdirectories, and dropping the maven template would let target/ get tracked.
  if (config.doesContainPomXmlAnywhere) {
    names.push('maven');
    rules += `.idea/google-java-format.xml
`;
  }
  if (config.doesContainPubspecYaml) {
    names.push('flutter', 'AndroidStudio', 'ruby');
    rules += `.flutter-plugins-dependencies
android/key.properties
ios/.bundle
.idea/runConfigurations.xml
`;
  }
  if (config.doesContainTemplateYaml) {
    rules += `.aws-sam/
packaged.yaml
`;
  }
  // Because .venv should be ignored on root directory. Recursive detection (not just a root
  // lockfile): a multi-language repository keeps Python directories in subdirectories, and
  // dropping the python template would let __pycache__/ and .venv/ get tracked.
  if (config.doesContainPythonLockAnywhere) {
    names.push('python');
    rules += `.venv/
`;
  }
  return { names, rules };
}

function getDependencyEntries(config: PackageConfig, rootConfig: PackageConfig): TemplateEntries {
  const names: string[] = [];
  let rules = '';
  if (config.depending.blitz) {
    rules += `.blitz/
.blitz**
`;
  }
  if (config.depending.next) {
    names.push('nextjs');
  }
  if (rootConfig.depending.firebase || config.depending.firebase) {
    names.push('firebase');
  }
  if (config.depending.prisma || config.depending.drizzle) {
    rules += `*.sqlite3*
`;
  }
  if (config.depending.playwrightTest) {
    rules += `playwright-report/
test-results/
`;
  }
  if (rootConfig.depending.reactNative || config.depending.reactNative) {
    names.push('reactnative');
    rules += `google-services.json
android/app/src/main/assets/
`;
  }
  if (config.depending.storybook) {
    names.push('storybookjs');
  }
  if (config.depending.tauri) {
    names.push('rust');
  }
  if (config.doesContainTauriConfig) {
    // !Cargo.lock overrides any pre-existing unanchored Cargo.lock rule from a
    // parent .gitignore, so the application lockfile stays committable.
    rules += `!Cargo.lock
src-tauri/gen/schemas/
`;
  }
  if (config.depending.litestream) {
    rules += `gcp-sa-key.json
`;
  }
  if (config.isCloudflare || rootConfig.isCloudflare) {
    // .dev.vars* hold local secrets for wrangler dev and must never be committed.
    // .env.cloudflare carries CLOUDFLARE_API_TOKEN: CI writes it from a secret, and a local
    // `wb deploy` needs a real token in it, so committing it would leak account credentials.
    // It is listed explicitly so the Cloudflare-specific credential policy remains visible.
    rules += `.dev.vars*
.env.cloudflare
.wrangler/
`;
  }
  return { names, rules };
}

/**
 * Returns the ignore rule for worker-configuration.d.ts, deleting a stale generated copy when the
 * rule no longer applies.
 */
async function syncWorkerTypesRule(config: PackageConfig): Promise<string> {
  // Ignored only where postinstall regenerates it, so wbfy never ignores a file that nothing recreates. This keeps
  // its thousands of lines out of every wrangler bump's diff. Anchored with a leading slash because `wrangler types`
  // and the opt-out deletion below only ever touch this package's own file, not a nested one at any depth.
  if (await generatesWorkerTypes(config)) {
    return `/worker-configuration.d.ts
`;
  }
  if (config.doesContainWranglerConfig && !(await consumesGeneratedWorkerTypes(config))) {
    // On a genuine worker-types opt-out (nothing consumes the generated file; generatesWorkerTypes
    // alone is false for unrelated reasons such as a missing local wrangler dependency, where the
    // file may still be consumed) the ignore rule
    // above disappears, so an already-generated file would surface as untracked noise on every
    // checkout — delete it. No repository tracks the file (docs/expected-repository-rules.md),
    // so an existing copy is always a disposable generated one.
    const workerTypesPath = path.resolve(config.dirPath, 'worker-configuration.d.ts');
    if (fs.existsSync(workerTypesPath)) {
      await promisePool.runAndWaitForReturnValue(() => fs.promises.rm(workerTypesPath, { force: true }));
    }
  }
  return '';
}

/** Returns the concatenated gitignore.io templates, or undefined when one cannot be fetched. */
async function readTemplates(names: readonly string[]): Promise<string | undefined> {
  let templates = '';
  for (const name of names) {
    const template = (await readCache(name)) || (await fetchTemplate(name));
    if (template === undefined) return;
    if (templates) templates += '\n';
    templates += template + '\n';
  }
  return templates;
}

async function fetchTemplate(name: string): Promise<string | undefined> {
  const url = `https://www.toptal.com/developers/gitignore/api/${name}`;
  const response = await fetch(url);
  const responseText = await response.text();
  if (!response.ok || responseText.includes('Attention Required!') || responseText.includes('<title>')) {
    console.error(`Failed to fetch ${url}`);
    return;
  }
  const template = responseText.trim();
  await promisePool.runAndWaitForReturnValue(() => writeCache(name, template));
  if (options.isVerbose) {
    console.info(`Fetched ${url}`);
  }
  return template;
}

function adjustTemplates(
  templates: string,
  config: PackageConfig,
  rootConfig: PackageConfig,
  isBerryZeroInstallEnabled: boolean
): string {
  let generated = templates;
  if (!isBerryZeroInstallEnabled) {
    generated = generated.replace('!.yarn/cache', '# !.yarn/cache').replace('# .pnp.*', '.pnp.*');
  }
  if (config.doesContainPomXmlAnywhere || config.doesContainPubspecYaml) {
    generated = generated
      .replaceAll(/^# .idea\/artifacts$/gm, '.idea/artifacts')
      .replaceAll(/^# .idea\/compiler.xml$/gm, '.idea/compiler.xml')
      .replaceAll(/^# .idea\/jarRepositories.xml$/gm, '.idea/jarRepositories.xml')
      .replaceAll(/^# .idea\/modules.xml$/gm, '.idea/modules.xml')
      .replaceAll(/^# .idea\/*.iml$/gm, '.idea/*.iml')
      .replaceAll(/^# .idea\/modules$/gm, '.idea/modules')
      .replaceAll(/^# *.iml$/gm, '*.iml')
      .replaceAll(/^# *.ipr$/gm, '*.ipr');
    if (config.doesContainPubspecYaml) {
      generated = generated.replaceAll(/^.idea\/modules.xml$/gm, '# .idea/modules.xml');
    }
  }
  // gitignore treats `#` as a comment only at line start, so a trailing comment (e.g., vim's `!*.svg  # ...`)
  // turns the whole line into a pattern that never matches.
  generated = generated.replaceAll(/^([^#\s].*?)[ \t]+(#.*)$/gm, '$2\n$1');
  generated = generated.replaceAll(/^.idea\/?$/gm, '# .idea');
  if (config.depending.tauri) {
    // The rust template's unanchored debug/ would also hide frontend source
    // directories such as src/debug/; cargo output is already covered by target/.
    generated = generated.replaceAll(/^debug\/$/gm, '# debug/');
  }
  if (config.doesContainTauriConfig || config.doesContainTauriConfigInPackages) {
    // The rust template ignores Cargo.lock, but a src-tauri configuration marks an
    // application, whose Cargo.lock must be committed for reproducible builds. The
    // rule is also disabled when a sub package contains a Tauri application, because
    // an unanchored Cargo.lock rule in a parent .gitignore would hide the nested
    // application's lockfile. Tauri plugin libraries (detected only via
    // @tauri-apps/* dependencies) keep the template's policy of ignoring Cargo.lock.
    generated = generated.replaceAll(/^Cargo\.lock$/gm, '# Cargo.lock');
  }
  if (rootConfig.depending.reactNative || config.depending.reactNative || config.doesContainPubspecYaml) {
    generated = generated.replaceAll(/^(.idea\/.+)$/gm, '$1\nandroid/$1');
  }
  return generated;
}

const dirPath = path.join(os.homedir(), '.cache', 'wbfy', 'gitignore');

async function writeCache(name: string, content: string): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true });
  await fs.promises.writeFile(path.join(dirPath, name), content);
}

async function readCache(name: string): Promise<string | undefined> {
  try {
    const stat = await fs.promises.stat(path.join(dirPath, name));
    if (Date.now() - stat.mtimeMs > 6 * 60 * 60 * 1000) {
      return;
    }
    return await fs.promises.readFile(path.join(dirPath, name), 'utf8');
  } catch {
    // do nothing
  }
}
