import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { logger } from '../logger.js';
import { options } from '../options.js';
import { consumesGeneratedWorkerTypes, generatesWorkerTypes, type PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { ignoreFileUtil } from '../utils/ignoreFileUtil.js';
import { promisePool } from '../utils/promisePool.js';
import { spawnSyncAndReturnStdout } from '../utils/spawnUtil.js';

// Do not remove `windows`: generated .gitignore files must keep ignoring Windows-created local artifacts.
const defaultNames = ['windows', 'macos', 'linux', 'jetbrains', 'visualstudiocode', 'emacs', 'vim', 'yarn'];

const commonContent = `
__generated__/
!.keep
.aider*
.antigravitycli/
.claude/*.local.*
.claude/scheduled_tasks.lock
.devcontainer/
.env.production
.idea/AugmentWebviewStateStore.xml
.idea/copilot.*
.idea/copilot/chatSessions/
.playwright-cli/
.playwright-mcp/
.serena/
.tmp/
.tokensave/
.wb/
@willbooster/
*/mount/*.hash
CLAUDE.local.md
dist/
drizzle/mount/
temp/
tmp/
`;

export async function generateGitignore(config: PackageConfig, rootConfig: PackageConfig): Promise<void> {
  return logger.functionIgnoringException('generateGitignore', async () => {
    const filePath = path.resolve(config.dirPath, '.gitignore');
    const content = (await fsUtil.readFileIfExists(filePath)) ?? '';
    const userHeadContent = ignoreFileUtil.getHeadUserContent(content);
    let headUserContent = userHeadContent + commonContent;
    const tailUserContent = ignoreFileUtil.getTailUserContent(content);

    const names = [...defaultNames];
    if (config.doesContainGemfile) {
      names.push('ruby');
    }
    if (config.doesContainGoMod) {
      names.push('go');
      headUserContent += `${path.basename(config.dirPath)}
`;
    }
    if (config.doesContainPackageJson) {
      names.push('node');
    }
    if (config.doesContainPomXml) {
      names.push('maven');
      headUserContent += `.idea/google-java-format.xml
`;
    }
    if (config.doesContainPubspecYaml) {
      names.push('flutter', 'AndroidStudio', 'ruby');
      headUserContent += `.flutter-plugins-dependencies
android/key.properties
ios/.bundle
.idea/runConfigurations.xml
`;
    }
    if (config.doesContainTemplateYaml) {
      headUserContent += `.aws-sam/
packaged.yaml
`;
    }
    // Because .venv should be ignored on root directory
    if (config.doesContainPoetryLock || config.doesContainUvLock) {
      names.push('python');
      headUserContent += `.venv/
`;
    }

    if (config.depending.blitz) {
      headUserContent += `.blitz/
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
      headUserContent += `*.sqlite3*
`;
    }
    if (config.depending.playwrightTest) {
      headUserContent += `playwright-report/
test-results/
`;
    }
    if (rootConfig.depending.reactNative || config.depending.reactNative) {
      names.push('reactnative');
      headUserContent += `google-services.json
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
      headUserContent += `!Cargo.lock
src-tauri/gen/schemas/
`;
    }
    if (config.depending.litestream) {
      headUserContent += `gcp-sa-key.json
`;
    }
    if (config.isCloudflare || rootConfig.isCloudflare) {
      // .dev.vars* hold local secrets for wrangler dev and must never be committed,
      // unlike the committed .env/.env.staging files of the WillBooster convention.
      // .env.cloudflare carries CLOUDFLARE_API_TOKEN: CI writes it from a secret, and a local
      // `wb deploy` needs a real token in it, so committing it would leak account credentials.
      headUserContent += `.dev.vars*
.env.cloudflare
.wrangler/
`;
    }
    // Ignored only where postinstall regenerates it, so wbfy never ignores a file that nothing recreates. This keeps
    // its thousands of lines out of every wrangler bump's diff. Anchored with a leading slash because `wrangler types`
    // and the untracking below only ever touch this package's own file, not a nested one at any depth.
    if (generatesWorkerTypes(config)) {
      headUserContent += `/worker-configuration.d.ts
`;
    } else if (config.doesContainWranglerConfig && !consumesGeneratedWorkerTypes(config)) {
      // On a genuine worker-types opt-out (nothing consumes the generated file — the same gate as
      // the postinstall strip; generatesWorkerTypes alone is false for unrelated reasons such as a
      // missing local wrangler dependency, where the file may still be consumed) the ignore rule
      // above disappears, so an already-generated file would surface as untracked noise on every
      // checkout — delete it, but only an UNTRACKED copy (a tracked one is the user's own file).
      const workerTypesPath = path.resolve(config.dirPath, 'worker-configuration.d.ts');
      if (
        fs.existsSync(workerTypesPath) &&
        !spawnSyncAndReturnStdout('git', ['ls-files', '--', 'worker-configuration.d.ts'], config.dirPath).trim()
      ) {
        await promisePool.run(() => fs.promises.rm(workerTypesPath, { force: true }));
      }
    }
    if (rootConfig.depending.vinext || config.depending.vinext) {
      headUserContent += `.vinext/
`;
    }

    let generated = '';
    for (const name of names) {
      let content = (await readCache(name)) ?? '';
      if (!content) {
        const url = `https://www.toptal.com/developers/gitignore/api/${name}`;
        const response = await fetch(url);
        const responseText = await response.text();
        if (!response.ok || responseText.includes('Attention Required!') || responseText.includes('<title>')) {
          console.error(`Failed to fetch ${url}`);
          return;
        }
        content = responseText.trim();
        await promisePool.run(() => writeCache(name, content));
        if (options.isVerbose) {
          console.info(`Fetched ${url}`);
        }
      }
      if (generated) generated += '\n';
      generated += content + '\n';
    }
    if (!(await ignoreFileUtil.isBerryZeroInstallEnabled(filePath))) {
      generated = generated.replace('!.yarn/cache', '# !.yarn/cache').replace('# .pnp.*', '.pnp.*');
    }
    if (config.doesContainPomXml || config.doesContainPubspecYaml) {
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
    // Drop HEAD user-section lines that duplicate a managed or template pattern verbatim, so
    // hand-added entries (e.g. a pre-migration `.wrangler/`) do not linger once wbfy manages the
    // same rule. Removing a head duplicate cannot change semantics: git honors the LAST matching
    // rule and the managed/template copy always comes after the head. The TAIL section is left
    // untouched — a tail rule comes after every managed rule and may deliberately re-assert a
    // pattern over an earlier negation (e.g. `!.env.production` followed by `.env.production`),
    // so deleting it would un-ignore files.
    const managedContent = headUserContent.slice(userHeadContent.length);
    const managedLines = new Set(
      [...managedContent.split('\n'), ...generated.split('\n')]
        .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
        .filter((line) => line && !line.startsWith('#'))
    );
    const dedupedUserHeadContent = userHeadContent
      .split('\n')
      // Tolerate CRLF user content (now preserved by the generated `.gitignore -text` attribute).
      .filter((line) => !managedLines.has(line.endsWith('\r') ? line.slice(0, -1) : line))
      .join('\n');
    const newContent = dedupedUserHeadContent + managedContent + '\n' + generated + tailUserContent;
    await promisePool.run(() => fsUtil.generateFile(filePath, newContent));
  });
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
