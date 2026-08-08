import { describe, expect, it } from 'vitest';

import { lintDockerfile } from '../../src/utils/dockerfileLint.js';

describe('lintDockerfile', () => {
  it('rejects non-cache RUN mounts only when a Railway config exists', () => {
    const dockerfileText = `FROM node:24
RUN --mount=type=bind,source=dist/bash/a.sh,target=/tmp/a.sh bash /tmp/a.sh
RUN --mount=type=secret,id=fnox_age_key,env=FNOX_AGE_KEY bun run build
RUN --mount=type=cache,target=/root/.cache bun install
RUN --mount=target=/tmp/x true
`;
    const problems = lintDockerfile(dockerfileText, { railwayConfigured: true });
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('type=bind');
    expect(lintDockerfile(dockerfileText, { railwayConfigured: false })).toHaveLength(0);
  });

  it('rejects ENV/ARG age identities regardless of platform', () => {
    expect(lintDockerfile('ENV FNOX_AGE_KEY=abc\n', { railwayConfigured: false })).toHaveLength(1);
    expect(lintDockerfile('ARG MISE_AGE_KEY\n', { railwayConfigured: false })).toHaveLength(1);
    // A secret mount consumes the key without persisting it in a layer.
    expect(
      lintDockerfile('RUN --mount=type=secret,id=fnox_age_key,env=FNOX_AGE_KEY bun run build\n', {
        railwayConfigured: false,
      })
    ).toHaveLength(0);
  });

  it('rejects COPY of the root .env and .env globs but allows .docker.env and dist/.env', () => {
    expect(lintDockerfile('COPY .env ./\n', { railwayConfigured: false })).toHaveLength(1);
    expect(lintDockerfile('COPY .env .env.* package.json ./\n', { railwayConfigured: false })).toHaveLength(2);
    expect(lintDockerfile('COPY .docker.env ./.docker.env\n', { railwayConfigured: false })).toHaveLength(0);
    expect(lintDockerfile('COPY dist/.env ./.env\n', { railwayConfigured: false })).toHaveLength(0);
  });

  it('ignores comment lines', () => {
    expect(
      lintDockerfile('# RUN --mount=type=bind,source=a,target=b true\n# COPY .env ./\n', { railwayConfigured: true })
    ).toHaveLength(0);
  });

  it('handles quoted mount specs and ignores --mount inside the shell command', () => {
    expect(
      lintDockerfile('RUN --mount="type=bind,source=a,target=b" true\n', { railwayConfigured: true })
    ).toHaveLength(1);
    expect(lintDockerfile('RUN echo --mount=type=bind,source=a,target=b\n', { railwayConfigured: true })).toHaveLength(
      0
    );
  });

  it('collapses backslash line continuations', () => {
    expect(lintDockerfile('COPY \\\n  .env \\\n  ./\n', { railwayConfigured: false })).toHaveLength(1);
  });

  it('detects age keys after other assignments and lowercase instructions', () => {
    expect(
      lintDockerfile('ENV NODE_ENV=production FNOX_AGE_KEY=$FNOX_AGE_KEY\n', { railwayConfigured: false })
    ).toHaveLength(1);
    expect(lintDockerfile('env FNOX_AGE_KEY=abc\n', { railwayConfigured: false })).toHaveLength(1);
  });

  it('detects JSON-form COPY, ./.env, and mode-specific env files', () => {
    expect(lintDockerfile('COPY [".env", "./"]\n', { railwayConfigured: false })).toHaveLength(1);
    expect(lintDockerfile('COPY ./.env ./\n', { railwayConfigured: false })).toHaveLength(1);
    expect(lintDockerfile('COPY .env.production ./\n', { railwayConfigured: false })).toHaveLength(1);
  });
});
