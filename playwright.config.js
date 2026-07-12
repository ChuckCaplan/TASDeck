const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "apps/web/tests/ui",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:8000",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/bridge-server.js --host 127.0.0.1 --no-open",
    url: "http://127.0.0.1:8000",
    reuseExistingServer: true,
  },
});
