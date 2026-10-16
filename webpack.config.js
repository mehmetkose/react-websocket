var path = require('path');

module.exports = {
  mode: 'development',
  devtool: 'eval-source-map',
  entry: './example/index.jsx',
  output: {
    path: path.join(__dirname, 'example', 'static'),
    filename: 'bundle.js',
  },
  resolve: {
    extensions: ['.js', '.jsx'],
  },
  module: {
    rules: [{
      test: /\.jsx?$/,
      exclude: /build|node_modules/,
      use: 'babel-loader',
    }],
  },
};
