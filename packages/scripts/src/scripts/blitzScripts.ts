import path from 'node:path';

class BlitzScripts {
  testE2E({ playwrightArgs = 'test tests/e2e', startCommand = 'yarn start-prod' }): string {
    return `APP_ENV=production dotenv -e .env.production -- concurrently --kill-others --raw --success first
      "rm -Rf db/mount && ${startCommand}"
      "wait-on -t 600000 -i 2000 http://127.0.0.1:8080 && playwright ${playwrightArgs}"`;
  }

  testStart(): string {
    return `yarn concurrently --kill-others --raw "blitz dev" "${this.waitApp()}"`;
  }

  testUnit(): string {
    return `yarn vitest run tests/unit`;
  }

  waitApp(port = 3000): string {
    return `wait-on -t 60000 -i 2000 http://127.0.0.1:${port}`;
  }

  waitAndOpenApp(port = 3000): string {
    return `${this.waitApp(port)} && open-cli http://localhost:${port}`;
  }
}

export const blitzScripts = new BlitzScripts();
