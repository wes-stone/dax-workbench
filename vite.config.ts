import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react(), {
    name: "release-dependency-inputs",
    generateBundle(_options, bundle) {
      const inputs = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const id of Object.keys(output.modules)) {
          if (id.includes("\0") || !id.replaceAll("\\", "/").includes("/node_modules/")) continue;
          const relative = path.relative(process.cwd(), id.split("?")[0]).replaceAll("\\", "/");
          if (!relative.startsWith("node_modules/"))
            throw new Error(`Cannot identify bundled dependency input: ${relative}`);
          inputs.add(relative);
        }
      }
      this.emitFile({ type: "asset", fileName: "build-dependencies.json",
        source: JSON.stringify({ inputs: [...inputs].sort() }, null, 2) + "\n" });
    },
  }],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: {
          editor: ["monaco-editor/esm/vs/editor/editor.api.js"],
          charts: ["echarts/core", "echarts/charts", "echarts/components", "echarts/renderers"],
        },
      },
    },
  },
  server: { host: "127.0.0.1", strictPort: true },
});
