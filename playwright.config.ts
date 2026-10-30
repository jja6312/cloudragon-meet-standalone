import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  timeout: 40_000,
  use: {
    baseURL: "http://127.0.0.1:4189",
    headless: true,
    permissions: ["microphone"],
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
  },
  webServer: {
    command: "node tests/serve.mjs",
    url: "http://127.0.0.1:4189/api/health",
    reuseExistingServer: false,
  },
});
