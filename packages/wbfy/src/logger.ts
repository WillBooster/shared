import { options } from './options.js';

class Logger {
  async functionIgnoringException(name: string, func: () => Promise<void>): Promise<void> {
    if (options.isVerbose) {
      console.info(`--------- ${name} start ---------`);
    }
    try {
      await func();
    } catch (error) {
      console.info(`Error occurred in ${name}: ${error instanceof Error ? error.stack : String(error)}}`);
    }
    if (options.isVerbose) {
      console.info(`---------- ${name} end ----------`);
    }
  }
}

export const logger = new Logger();
