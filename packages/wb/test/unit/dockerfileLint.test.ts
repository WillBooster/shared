import { describe, expect, it } from 'vitest';
import { consumesDockerEnv } from '@willbooster/shared-lib-node/src';

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

  it('handles quoted tokens and COPY flags', () => {
    // A quoted flag value containing a space must not hide a later non-cache mount.
    expect(
      lintDockerfile('RUN --mount=type=cache,target="/tmp/cache dir" --mount=type=secret,id=fnox_age_key bun build\n', {
        railwayConfigured: true,
      })
    ).toHaveLength(1);
    expect(lintDockerfile('COPY ".env" "./"\n', { railwayConfigured: false })).toHaveLength(1);
    expect(lintDockerfile('COPY --chown=1000:1000 [".env", "/app/.env"]\n', { railwayConfigured: false })).toHaveLength(
      1
    );
    // Sources of a --from COPY come from another stage, not the build-context root.
    expect(lintDockerfile('COPY --from=builder /app/.env ./.env\n', { railwayConfigured: false })).toHaveLength(0);
  });

  it('applies the same source check to ADD', () => {
    expect(lintDockerfile('ADD .env ./\n', { railwayConfigured: false })).toHaveLength(1);
  });

  it('does not parse heredoc bodies as instructions', () => {
    const dockerfileText =
      'RUN --mount=type=cache,target=/c <<EOF\nenv FNOX_AGE_KEY="$(cat /run/secrets/k)" fnox export\nEOF\nCOPY .env ./\n';
    // The heredoc body is skipped, but the instruction after the delimiter is still linted.
    expect(lintDockerfile(dockerfileText, { railwayConfigured: true })).toHaveLength(1);
  });

  it('does not treat << inside shell words or unterminated candidates as heredocs', () => {
    // `<<TOKEN>>` inside a sed expression is not a heredoc and must not swallow later problems.
    expect(
      lintDockerfile("RUN sed -i 's/<<TOKEN>>/x/' f\nENV FNOX_AGE_KEY=abc\nCOPY .env ./\n", {
        railwayConfigured: false,
      })
    ).toHaveLength(2);
    // A regular `<<` delimiter must match the exact line: an indented occurrence inside a nested
    // shell heredoc does not terminate it.
    const nested = 'RUN <<OUTER\ncat <<INNER >/tmp/f\n OUTER\nENV FNOX_AGE_KEY=literal\nINNER\nOUTER\n';
    expect(lintDockerfile(nested, { railwayConfigured: false })).toHaveLength(0);
  });

  it('lints CRLF Dockerfiles', () => {
    expect(lintDockerfile('COPY .env ./\r\nENV FNOX_AGE_KEY=abc\r\n', { railwayConfigured: false })).toHaveLength(2);
  });
});

describe('consumesDockerEnv', () => {
  it('recognizes direct and helper-based consumption outside comments', () => {
    expect(consumesDockerEnv('COPY .docker.env ./\n')).toBe(true);
    expect(consumesDockerEnv('CMD ["./bash/apply-docker-env.sh", "node", "index.js"]\n')).toBe(true);
    expect(consumesDockerEnv('# COPY .docker.env ./\n# apply-docker-env.sh\n')).toBe(false);
  });
});
