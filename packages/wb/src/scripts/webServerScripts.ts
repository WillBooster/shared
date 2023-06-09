import { dockerScripts } from './dockerScripts.js';

/**
 * A collection of scripts for executing an app that utilizes an HTTP server like express.
 * Note that YARN zzz` is replaced with `yarn zzz` or `node_modules/.bin/zzz`.
 */
export abstract class WebServerScripts {
  protected constructor(private readonly defaultPort = 3000) {}

  buildDocker(wbEnv = 'local'): string {
    return dockerScripts.buildDevImage(wbEnv);
  }

  startDocker(): string {
    return `${this.buildDocker()}
      && YARN concurrently --raw --kill-others-on-fail
        "${dockerScripts.stopAndStart(false)}"
        "${this.waitAndOpenApp(8080)}"`;
  }

  testUnit(): string {
    // Since this command is referred to from other commands, we have to use "vitest run".
    return `YARN vitest run tests/unit --color --passWithNoTests`;
  }

  protected waitApp(port = this.defaultPort): string {
    return `wait-on -t 10000 http://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 10000 -i 500 http://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 10000 -i 1000 http://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 10000 -i 2000 http://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 20000 -i 4000 http://127.0.0.1:${port} 2> /dev/null
      || wait-on -t 60000 -i 5000 http://127.0.0.1:${port}`;
  }

  protected waitAndOpenApp(port = this.defaultPort): string {
    return `${this.waitApp(port)} && open-cli http://localhost:${port}`;
  }
}
