import { sentryVitePlugin } from "@sentry/vite-plugin";
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
  plugins: [react(), sentryVitePlugin({
    disable: process.env.DATABAKER_SENTRY_PLUGIN_DISABLED === '1',
    org: "vsoul",
    project: "databaker-record-desktop",
    telemetry: false,
    sourcemaps: {
      filesToDeleteAfterUpload: ['./dist/**/*.map'],
    },
  })],

  base: './',

  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        '**/engine/target/**',
        '**/build/**',
        '**/dist/**',
        '**/dist-electron/**',
        '**/doc/**',
        '**/移动app 参考/**',
      ],
    },
  },

  build: {
    sourcemap: 'hidden'
  }
});
