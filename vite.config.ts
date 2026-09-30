import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    cors: true,
    // Expo WebView needs to load Vite dev server; HMR overlay can be noisy on mobile
    hmr: {
      clientPort: 5173,
    },
    watch: {
      ignored: ['**/mobile/**', '**/dist/**', '**/.expo/**', '**/node_modules/**'],
    },
  },
  // vite build --watch also watches mobile/dist by default and creates infinite loop
  // (vite -> dist -> sync -> mobile/src/gameHtml.ts -> vite). Ignore them.
  // @ts-ignore - build.watch is Rollup watchOptions, not typed in Vite but passed through
  builder: undefined,
});
