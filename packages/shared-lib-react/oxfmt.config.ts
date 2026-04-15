const configModule = await import('@willbooster/oxfmt-config').catch((error: unknown) => {
  // @willbooster/oxfmt-config@1.1.0 exposed JSON as the package entrypoint.
  if (error instanceof Error && 'code' in error && error.code === 'ERR_IMPORT_ATTRIBUTE_MISSING') {
    return import('@willbooster/oxfmt-config', { with: { type: 'json' } });
  }
  throw error;
});

export default configModule.default;
