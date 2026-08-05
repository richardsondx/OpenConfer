/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "OpenConfer",
        short_name: "OpenConfer",
        description: "Human decision sessions for AI agents",
        theme_color: "#1a4d4a",
        background_color: "#f7f4ef",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/v1": "http://127.0.0.1:8787",
    },
  },
});
