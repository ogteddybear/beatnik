import replace from "@rollup/plugin-replace";
import { defineConfig } from "tsdown";

const BUILD_DIR = "dist";

export default defineConfig({
  entry: "src/index.ts",
  outDir: BUILD_DIR,
  platform: "node",
  format: "esm",
  minify: false,
  exports: true,
  fixedExtension: true,
  // Keep the unmodified LGPL dependency separately replaceable at runtime.
  deps: { neverBundle: ["icecast-metadata-js"] },
  plugins: [
    replace({
      "config.useMockProvider": JSON.stringify(false),
      preventAssignment: true,
    }),
  ],
});
