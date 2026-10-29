import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The packaged app loads the renderer from file://, so the production build gets a strict CSP.
// The dev server keeps it off because React refresh injects inline scripts.
const csp: Plugin = {
  name: 'cleanly-csp',
  apply: 'build',
  transformIndexHtml(html) {
    const policy = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
    ].join('; ');
    return html.replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${policy}">`);
  },
};

export default defineConfig({
  base: './',
  plugins: [react(), csp],
  server: { port: 5174, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome130' },
});
