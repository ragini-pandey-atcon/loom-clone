import { defineConfig } from '@playwright/test';

// Runs against the servers started by scripts/start.ps1 (web 5310, API 7310).
// Chromium's fake devices stand in for the camera, the microphone and the screen picker.
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5310',
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen',
      ],
    },
  },
});
