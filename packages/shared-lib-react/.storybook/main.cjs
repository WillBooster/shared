module.exports = {
  stories: ['../src/**/*.stories.mdx', '../src/**/*.stories.@(js|jsx|ts|tsx)'],
  addons: ['@storybook/addon-links', '@storybook/addon-essentials', '@storybook/addon-interactions'],
  framework: '@storybook/react',
  webpackFinal: async (config) => {
    // cf. https://github.com/vercel/next.js/issues/41961#issue-1425451409
    const webpack = require('webpack');
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(new RegExp(/\.jsx?$/), (resource) => {
        resource.request = resource.request.replace(/\.jsx?$/, '');
      })
    );
    return config;
  },
};
