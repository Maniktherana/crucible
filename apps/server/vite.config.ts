import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  pack: {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    checks: {
      legacyCjs: false,
    },
    outDir: "dist",
    sourcemap: true,
    clean: true,
    noExternal: (id) => id.startsWith("@t3tools/"),
    inlineOnly: false,
    banner: {
      js: "#!/usr/bin/env node\n",
    },
  },
  test: {
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
