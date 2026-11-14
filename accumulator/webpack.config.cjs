const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

module.exports = {
  mode: 'production',
  entry: './src/deriv-smartchart.jsx',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'deriv-smartchart.js',
    publicPath: '/dist/',
    clean: true
  },
  resolve: { extensions: ['.js', '.jsx'] },
  module: {
    rules: [
      {
        test: /\.jsx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [
              ['@babel/preset-env', { targets: 'defaults' }],
              ['@babel/preset-react', { runtime: 'automatic' }]
            ]
          }
        }
      },
      { test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] },
      {
        test: /\.(woff2?|ttf|eot|png|jpe?g|gif|svg)$/i,
        type: 'asset/resource',
        generator: { filename: 'assets/[name][contenthash:6][ext]' }
      }
    ]
  },
  plugins: [
    new MiniCssExtractPlugin({ filename: 'deriv-smartchart.css' }),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: path.resolve(__dirname, 'node_modules/@deriv-com/smartcharts-champion/dist/*.smartcharts.*'),
          to: path.resolve(__dirname, 'dist'),
          noErrorOnMissing: true
        },
        {
          from: path.resolve(__dirname, 'node_modules/@deriv-com/smartcharts-champion/dist/chart/assets'),
          to: path.resolve(__dirname, 'assets'),
          noErrorOnMissing: true
        }
      ]
    })
  ]
};
