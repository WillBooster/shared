import externals from 'rollup-plugin-node-externals';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import babel from '@rollup/plugin-babel';
import { terser } from 'rollup-plugin-terser';
import analyze from 'rollup-plugin-analyzer';

const extensions = ['.ts'];
const plugins = [
  externals({
    deps: true,
    devDeps: false,
  }),
  resolve({ extensions }),
  commonjs(),
  babel({ extensions, babelHelpers: 'bundled', exclude: 'node_modules/**' }),
];
if (process.env.NODE_ENV === 'production') {
  plugins.push(terser(), analyze({ summaryOnly: true }));
}

export default {
  input: 'src/index.ts',
  output: {
    dir: 'dist',
    format: 'esm',
    preserveModules: true,
  },
  plugins,
};
