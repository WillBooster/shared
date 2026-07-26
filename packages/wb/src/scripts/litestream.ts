import fs from 'node:fs';
import path from 'node:path';

import type { Project } from '../project.js';

const LITESTREAM_CONFIG_FILE_NAME = 'litestream.yml';
const DEFAULT_LITESTREAM_CONFIG_PATH = '/etc/litestream.yml';

export function getLitestreamConfigOption(project: Pick<Project, 'dirPath'>, configPath?: string): string {
  if (configPath) return `-config "${configPath}"`;

  const localConfigPath = path.join(project.dirPath, LITESTREAM_CONFIG_FILE_NAME);
  if (fs.existsSync(localConfigPath)) return `-config ./${LITESTREAM_CONFIG_FILE_NAME}`;
  if (fs.existsSync(DEFAULT_LITESTREAM_CONFIG_PATH)) return `-config ${DEFAULT_LITESTREAM_CONFIG_PATH}`;
  return `-config ./${LITESTREAM_CONFIG_FILE_NAME}`;
}
