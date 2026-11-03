import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'apps/web/e2e',
  timeout: 90_000,
  workers: 1,
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:4173/',
    launchOptions: {
      // Software WebGL so the tests run on machines without a GPU (slow, but deterministic).
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
      ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
    },
  },
  webServer: {
    command: 'npm run build -w @cr/web && npm run preview -w @cr/web -- --port 4173 --strictPort',
    port: Number(process.env.PORT ?? 4173),
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
