import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { apiPort, webPort } from "../../packages/config/index.js";
export default defineConfig({
  root: "apps/web",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: {
      "/v1": `http://127.0.0.1:${apiPort}`,
      "/health": `http://127.0.0.1:${apiPort}`,
    },
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            /\/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom)\//.test(
              id,
            )
          )
            return "framework";
        },
      },
    },
  },
});
