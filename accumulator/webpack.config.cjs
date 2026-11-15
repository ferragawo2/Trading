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
  resolve: {
    extensions: ['.js', '.jsx'],
    // The Quill UI stylesheet exists in the installed package but is not exported
    // as a package subpath. Resolve that exact import straight to its installed file.
    alias: {
      '@deriv-com/quill-ui/dist/assets/quill-ui.css$': path.resolve(
        __dirname,
        'node_modules/@deriv-com/quill-ui/dist/assets/quill-ui.css'
      )
    }
  },
  module: {
    rules: [
      {
        test: /\\.jsx?$/,
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
      { test: /\\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] },
      {
        test: /\\.(woff2?|ttf|eot|png|jpe?g|gif|svg)$/i,
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
          // SmartCharts requests these hashed chunks directly from /dist/.
          from: path.resolve(__dirname, 'node_modules/@deriv-com/smartcharts-champion/dist/*.smartcharts.*'),
          context: path.resolve(__dirname, 'node_modules/@deriv-com/smartcharts-champion/dist'),
          to: path.resolve(__dirname, 'dist')
        },
        {
          // The Flutter chart engine is loaded at runtime from /dist/chart/.
          from: path.resolve(__dirname, 'node_modules/@deriv-com/smartcharts-champion/dist/chart'),
          to: path.resolve(__dirname, 'dist/chart'),
          noErrorOnMissing: true
        },
        {
          // Flutter receives assetBase='/dist/', so its assets must live at /dist/assets/.
          from: path.resolve(__dirname, 'node_modules/@deriv-com/smartcharts-champion/dist/chart/assets'),
          to: path.resolve(__dirname, 'dist/assets'),
          noErrorOnMissing: true
        }
      ]
    })
  ]
};
