import { setupLabels } from './github/label.js';
import { setupGitHubSettings } from './github/settings.js';
import { getPackageConfig } from './packageConfig.js';

const rootDirPath = '/Users/exkazuu/ghq/github.com/WillBoosterLab/exercode';
const rootConfig = await getPackageConfig(rootDirPath);
if (rootConfig) {
  void setupLabels(rootConfig);
  void setupGitHubSettings(rootConfig);
}
