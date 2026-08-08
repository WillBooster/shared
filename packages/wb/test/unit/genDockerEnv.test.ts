import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { serializeDockerEnvLine } from '../../src/commands/genDockerEnv.js';
import { collectPlaintextFnoxValues } from '../../src/utils/fnoxToml.js';

const FNOX_TOML = `[secrets]
WB_ENV = { default = "development" }
APP_TITLE = { default = "dev title" }
EMPTY_VALUE = { default = "" }
BUILD_ONLY = { default = "x", env = false }
EXEC_ONLY = { default = "y", env = "exec" }
PLAIN_TO_SECRET = { default = "plain-in-dev" }
SECRET_TO_PLAIN = { provider = "age", value = "YWdlLWVuY3J5cHRpb24ub3JnL3YxCg==" }
ALWAYS_SECRET = { provider = "age", value = "YWdlLWVuY3J5cHRpb24ub3JnL3YxCg==" }

[profiles.production.secrets]
WB_ENV = { default = "production" }
APP_TITLE = { default = "prod title" }
PLAIN_TO_SECRET = { provider = "age", value = "YWdlLWVuY3J5cHRpb24ub3JnL3YxCg==" }
SECRET_TO_PLAIN = { default = "plain-in-prod" }

[providers.age]
recipients = ["age1examplerecipientkey"]
`;

describe('collectPlaintextFnoxValues', () => {
  it('returns only effective plaintext defaults for the selected profile', async () => {
    const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-gen-docker-env-'));
    await fs.writeFile(path.join(dirPath, 'fnox.toml'), FNOX_TOML);

    try {
      // A profile plaintext override of an encrypted base IS returned; a plaintext base
      // overridden by an encrypted profile value is NOT; env=false / env="exec" never are.
      expect({ ...collectPlaintextFnoxValues(dirPath, dirPath, 'production') }).toStrictEqual({
        WB_ENV: 'production',
        APP_TITLE: 'prod title',
        EMPTY_VALUE: '',
        SECRET_TO_PLAIN: 'plain-in-prod',
      });
      expect({ ...collectPlaintextFnoxValues(dirPath, dirPath, 'development') }).toStrictEqual({
        WB_ENV: 'development',
        APP_TITLE: 'dev title',
        EMPTY_VALUE: '',
        PLAIN_TO_SECRET: 'plain-in-dev',
      });
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('overlays ancestor configs with any profile entry beating any base entry', async () => {
    const rootDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-gen-docker-env-'));
    const appDirPath = path.join(rootDirPath, 'packages', 'app');
    await fs.mkdir(appDirPath, { recursive: true });
    // fnox 1.31.1 precedence (verified with `fnox export`): all base [secrets] tables merge
    // root-most→nearest first, then all profile tables merge root-most→nearest on top, so a ROOT
    // profile entry still beats a NEARER base entry.
    await fs.writeFile(
      path.join(rootDirPath, 'fnox.toml'),
      '[secrets]\nOVERLAP = { default = "root-base" }\n\n[profiles.production.secrets]\nOVERLAP = { default = "root-prod" }\n'
    );
    await fs.writeFile(path.join(appDirPath, 'fnox.toml'), '[secrets]\nOVERLAP = { default = "app-base" }\n');

    try {
      expect({ ...collectPlaintextFnoxValues(appDirPath, rootDirPath, 'production') }).toStrictEqual({
        OVERLAP: 'root-prod',
      });
      expect({ ...collectPlaintextFnoxValues(appDirPath, rootDirPath, undefined) }).toStrictEqual({
        OVERLAP: 'app-base',
      });
    } finally {
      await fs.rm(rootDirPath, { force: true, recursive: true });
    }
  });

  it('stops the ancestor walk at a config declaring root = true', async () => {
    const rootDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-gen-docker-env-'));
    const appDirPath = path.join(rootDirPath, 'packages', 'app');
    await fs.mkdir(appDirPath, { recursive: true });
    await fs.writeFile(path.join(rootDirPath, 'fnox.toml'), '[secrets]\nANCESTOR = { default = "ancestor" }\n');
    await fs.writeFile(path.join(appDirPath, 'fnox.toml'), 'root = true\n\n[secrets]\nCHILD = { default = "child" }\n');

    try {
      expect({ ...collectPlaintextFnoxValues(appDirPath, rootDirPath, undefined) }).toStrictEqual({ CHILD: 'child' });
    } finally {
      await fs.rm(rootDirPath, { force: true, recursive: true });
    }
  });

  it('fails fast on fnox settings outside the canonical wbfy layout', async () => {
    const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-gen-docker-env-'));

    try {
      await fs.writeFile(path.join(dirPath, 'fnox.toml'), 'env = false\n\n[secrets]\nA = { default = "x" }\n');
      expect(() => collectPlaintextFnoxValues(dirPath, dirPath, undefined)).toThrow('top-level env setting');

      await fs.writeFile(
        path.join(dirPath, 'fnox.toml'),
        '[secrets]\nA = { default = \'{"a":1}\', json_path = "a" }\n'
      );
      expect(() => collectPlaintextFnoxValues(dirPath, dirPath, undefined)).toThrow('value transformation');

      // A `value` without an explicit provider is still provider-backed (default_provider-style
      // configs); it must never be baked.
      await fs.writeFile(path.join(dirPath, 'fnox.toml'), '[secrets]\nA = { value = "bogus", default = "fb" }\n');
      expect({ ...collectPlaintextFnoxValues(dirPath, dirPath, undefined) }).toStrictEqual({});
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('resolves plaintext-to-plaintext ${NAME} references and rejects the rest', async () => {
    const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-gen-docker-env-'));

    try {
      // The canonical wbfy-tolerated pattern (`NEXT_PUBLIC_WB_ENV = "${WB_ENV}"`) and chains
      // resolve statically, matching `fnox export`.
      await fs.writeFile(
        path.join(dirPath, 'fnox.toml'),
        '[secrets]\nWB_ENV = { default = "development" }\nNEXT_PUBLIC_WB_ENV = { default = "${WB_ENV}" }\nHOST = { default = "example.com" }\nORIGIN = { default = "https://${HOST}" }\n\n[profiles.production.secrets]\nWB_ENV = { default = "production" }\n'
      );
      expect({ ...collectPlaintextFnoxValues(dirPath, dirPath, 'production') }).toStrictEqual({
        WB_ENV: 'production',
        NEXT_PUBLIC_WB_ENV: 'production',
        HOST: 'example.com',
        ORIGIN: 'https://example.com',
      });

      // A reference to a secret (or any non-plaintext entry) cannot be baked.
      await fs.writeFile(
        path.join(dirPath, 'fnox.toml'),
        '[secrets]\nSECRET = { provider = "age", value = "YWdlCg==" }\nURL = { default = "https://${SECRET}@h" }\n'
      );
      expect(() => collectPlaintextFnoxValues(dirPath, dirPath, undefined)).toThrow(
        'not a bakeable plaintext fnox entry'
      );

      await fs.writeFile(
        path.join(dirPath, 'fnox.toml'),
        '[secrets]\nA = { default = "${B}" }\nB = { default = "${A}" }\n'
      );
      expect(() => collectPlaintextFnoxValues(dirPath, dirPath, undefined)).toThrow('reference cycle');
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });

  it('keeps a `__proto__` key as ordinary data', async () => {
    const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-gen-docker-env-'));
    await fs.writeFile(path.join(dirPath, 'fnox.toml'), '[secrets]\n"__proto__" = { default = "kept" }\n');

    try {
      expect(collectPlaintextFnoxValues(dirPath, dirPath, undefined)['__proto__']).toBe('kept');
    } finally {
      await fs.rm(dirPath, { force: true, recursive: true });
    }
  });
});

describe('serializeDockerEnvLine', () => {
  it('single-quotes every representable value', () => {
    for (const value of [String.raw`a\b`, 'a # b', '$(id)', ' pad ', '', 'a"b', 'a`b', 'costs $100', 'x$', 'a=b']) {
      expect(serializeDockerEnvLine('KEY', value)).toBe(`KEY='${value}'`);
    }
  });

  it('rejects values and keys no consumer reads back identically', () => {
    expect(() => serializeDockerEnvLine('KEY', "it's")).toThrow('not representable');
    expect(() => serializeDockerEnvLine('KEY', 'a\nb')).toThrow('not representable');
    expect(() => serializeDockerEnvLine('KEY', 'a\rb')).toThrow('not representable');
    // A trailing backslash makes dotenv read the closing quote as escaped and swallow later lines.
    expect(() => serializeDockerEnvLine('KEY', 'v1\\')).toThrow('not representable');
    expect(() => serializeDockerEnvLine('KEY', 'https://${DOMAIN}/api')).toThrow('does not expand references');
    // dotenv-expand resolves a bare $NAME (and $$), and rewrites \$ to $, while shell sourcing
    // keeps them literal.
    expect(() => serializeDockerEnvLine('KEY', '$HOME')).toThrow('does not expand references');
    expect(() => serializeDockerEnvLine('KEY', 'a$$b')).toThrow('does not expand references');
    expect(() => serializeDockerEnvLine('KEY', String.raw`\$1`)).toThrow('does not expand references');
    expect(() => serializeDockerEnvLine('INVALID-KEY', 'x')).toThrow('not a POSIX shell identifier');
    // dotenv's parser drops a `__proto__` assignment even though it is a valid shell identifier.
    expect(() => serializeDockerEnvLine('__proto__', 'x')).toThrow('silently drop a __proto__ assignment');
  });
});
