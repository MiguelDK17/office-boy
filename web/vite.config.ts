import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Porta do backend do Office Boy (control server) — a mesma da UI na 1717.
const BACKEND = process.env.OFFICEBOY_BACKEND_URL || "http://localhost:1717";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // API do backend em dev: o front chama /api/* e /events sem CORS.
      "/api": { target: BACKEND, changeOrigin: true },
      "/events": { target: BACKEND, changeOrigin: true },
      "/legacy": { target: BACKEND, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
  },
});
