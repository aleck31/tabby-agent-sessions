const path = require('path')

module.exports = {
  target: 'node',
  entry: './src/index.ts',
  context: __dirname,
  mode: 'production',
  devtool: 'source-map',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'index.js',
    library: 'tabbyAgentSessions',
    libraryTarget: 'umd',
    devtoolModuleFilenameTemplate: 'webpack-tabby-agent-sessions:///[resource-path]',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [{ test: /\.ts$/, use: { loader: 'ts-loader', options: { transpileOnly: false } } }],
  },
  // Tabby provides these at runtime; bundling them would create a second Angular instance.
  externals: [
    'fs', 'path', 'os', 'util', 'child_process', 'electron',
    /^@angular\//, /^@ng-bootstrap\//, /^rxjs/, /^tabby-/,
  ],
}
