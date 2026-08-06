import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",
  // Keep server-only .env secrets out of the browser build environment.
  envDir: "config/vite",
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3001",
    },
  },
});
