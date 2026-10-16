var path = require('path');

var config = {
  mode: 'production',
  devtool: 'source-map',
  entry: {
    index: './index.jsx',
  },
  output: {
    path: path.join(__dirname, 'build'),
    publicPath: './build',
    filename: 'index.js',
    sourceMapFilename: 'index.map',
    library: {
      name: 'Spinner',
      type: 'umd',
    },
    globalObject: 'this',
  },
  module: {
    rules: [{
      test: /\.jsx?$/,
      exclude: /node_modules/,
      use: 'babel-loader',
    }],
  },
  resolve: {
    extensions: ['.js', '.jsx'],
  },
  externals: {
    'react': {
      root: 'React',
      commonjs2: 'react',
      commonjs: 'react',
      amd: 'react',
    },
  },
};

module.exports = config;
