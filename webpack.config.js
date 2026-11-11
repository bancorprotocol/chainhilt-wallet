import path from "node:path";
import webpack from "webpack";
import { LicenseWebpackPlugin } from "license-webpack-plugin";

const config = {
  mode: "production",
  target: "node22",
  entry: "./src/cli.ts",
  output: {
    path: path.resolve(import.meta.dirname, "dist"),
    filename: "cli.js",
    module: true,
    chunkFormat: "module",
    clean: true,
  },
  experiments: { outputModule: true },
  // license-webpack-plugin cannot attribute concatenated ES modules to their package, so their licenses would be dropped.
  optimization: { concatenateModules: false },
  resolve: {
    extensions: [".ts", ".js"],
    extensionAlias: { ".js": [".ts", ".js"] },
  },
  // Native, so it ships as a dependency and loads at runtime, which lets a
  // platform without its binary fall back to the key file.
  externals: { "@napi-rs/keyring": "import @napi-rs/keyring" },
  module: {
    parser: {
      // Assets and skills are read relative to dist/cli.js at runtime, so keep import.meta.url live.
      javascript: { importMeta: false, url: false, dynamicImportMode: "eager" },
    },
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        loader: "esbuild-loader",
        options: { target: "node22" },
      },
    ],
  },
  plugins: [
    new webpack.BannerPlugin({ banner: "#!/usr/bin/env node", raw: true }),
    // Minification keeps only /*! banners, so collect every bundled package's license text.
    new LicenseWebpackPlugin({
      perChunkOutput: false,
      outputFilename: "THIRD-PARTY-LICENSES.txt",
    }),
  ],
};

export default config;
