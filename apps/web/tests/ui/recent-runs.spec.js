/* global window */

const { Buffer } = require("node:buffer");

const { expect, test } = require("@playwright/test");

const TD2P_V2_HEADER = Buffer.from([
  0x54, 0x44, 0x32, 0x50, 0x02, 0x02, 0x0d, 0x0a,
  0x00, 0x01, 0x19, 0x40,
]);

const RECENT_BYTES = {
  "r08-completed": Buffer.from([
    0x80, 0x00, 0x40, 0x00, 0x20, 0x00, 0x10, 0x00, 0x08, 0x00, 0x04, 0x00,
  ]).toString("base64"),
  "r08-stopped": Buffer.from([
    0x80, 0x00, 0x40, 0x00, 0x20, 0x00, 0x10, 0x00, 0x08, 0x00,
    0x04, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00, 0x80, 0x00, 0x40,
  ]).toString("base64"),
  "r08-replay-1": Buffer.from([0x80, 0x00, 0x40, 0x00, 0x20, 0x00]).toString("base64"),
  "r08-replay-2": Buffer.from([0x80, 0x00, 0x40, 0x00, 0x20, 0x00]).toString("base64"),
  "tdmask-exact": Buffer.concat([
    TD2P_V2_HEADER,
    Buffer.from([0x01, 0x00, 0x02, 0x00, 0x04, 0x00, 0x08, 0x00, 0x10, 0x00]),
  ]).toString("base64"),
  "tdmask-error": Buffer.concat([
    TD2P_V2_HEADER,
    Buffer.from([0x01, 0x00, 0x00, 0x00]),
  ]).toString("base64"),
  "r08-traced": Buffer.from([0x80, 0x00, 0x40, 0x00, 0x20, 0x00, 0x10, 0x00]).toString("base64"),
};

function recentEntries() {
  const now = Date.now();
  const startedAt = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
  const traceFiles = Array.from({ length: 7 }, (_, index) => ({
    path: `logs/trace/2026-07-29_traced-${index + 1}.trace`,
    kind: index === 0 ? "manual" : index === 1 ? "auto" : index === 2 ? "stream" : "log",
    at: startedAt(3),
  }));

  return [
    {
      id: "r08-completed",
      fileName: "shared.r08",
      fileFormat: "r08",
      contentKey: "sha256:aaaaaaaaaaaaaaaa",
      sourceAvailable: true,
      syncMode: "strobe",
      delayPolls: 1,
      skipPolls: 2,
      portCount: 2,
      totalRecords: 6,
      effectiveRecords: 4,
      recordsPlayed: 4,
      sourceFrameCount: 0,
      durationMs: 1_133_109,
      startedAt: startedAt(20),
      endedAt: startedAt(1),
      outcome: "completed",
      firmwareId: "UNO-R4",
      traceFiles: [],
    },
    {
      id: "r08-stopped",
      fileName: "shared.r08",
      fileFormat: "r08",
      contentKey: "sha256:bbbbbbbbbbbbbbbb",
      sourceAvailable: true,
      syncMode: "latch",
      delayPolls: 9,
      skipPolls: 0,
      portCount: 2,
      totalRecords: 10,
      effectiveRecords: 10,
      recordsPlayed: 5,
      durationMs: 6_000,
      startedAt: startedAt(50),
      endedAt: startedAt(49),
      outcome: "stopped",
      traceFiles: [],
    },
    {
      id: "r08-replay-1",
      fileName: "replay.r08",
      fileFormat: "r08",
      contentKey: "sha256:cccccccccccccccc",
      sourceAvailable: true,
      syncMode: "poll",
      delayPolls: 0,
      skipPolls: 0,
      portCount: 2,
      totalRecords: 3,
      effectiveRecords: 3,
      recordsPlayed: 2,
      durationMs: 2_000,
      startedAt: startedAt(80),
      endedAt: startedAt(79),
      outcome: "interrupted",
      traceFiles: [],
    },
    {
      id: "r08-replay-2",
      fileName: "replay.r08",
      fileFormat: "r08",
      contentKey: "sha256:cccccccccccccccc",
      sourceAvailable: true,
      syncMode: "poll",
      delayPolls: 0,
      skipPolls: 0,
      portCount: 2,
      totalRecords: 3,
      effectiveRecords: 3,
      recordsPlayed: 3,
      durationMs: 3_000,
      startedAt: startedAt(70),
      endedAt: startedAt(69),
      outcome: "completed",
      traceFiles: [],
    },
    {
      id: "tdmask-exact",
      fileName: "exact.tdmask",
      fileFormat: "tdmask",
      contentKey: "sha256:dddddddddddddddd",
      sourceAvailable: true,
      syncMode: "poll",
      delayPolls: 3,
      skipPolls: 3,
      portCount: 2,
      totalRecords: 5,
      effectiveRecords: 2,
      recordsPlayed: 2,
      sourceFrameCount: 72_000,
      durationMs: 20_000,
      startedAt: startedAt(10),
      endedAt: startedAt(9),
      outcome: "completed",
      traceFiles: [],
    },
    {
      id: "tdmask-error",
      fileName: "error-run.tdmask",
      fileFormat: "tdmask",
      contentKey: "sha256:eeeeeeeeeeeeeeee",
      sourceAvailable: false,
      syncMode: "poll",
      delayPolls: 0,
      skipPolls: 0,
      portCount: 2,
      totalRecords: 2,
      effectiveRecords: 2,
      recordsPlayed: 1,
      durationMs: 4_000,
      startedAt: startedAt(40),
      endedAt: startedAt(39),
      outcome: "error",
      error: "buffer underrun",
      anomalyCount: 135_934,
      anomalyKind: 4,
      bareStrobes: 12,
      tornStrobes: 3,
      traceFiles: [],
    },
    {
      id: "r08-traced",
      fileName: "traced.r08",
      fileFormat: "r08",
      contentKey: "sha256:ffffffffffffffff",
      sourceAvailable: true,
      syncMode: "strobe",
      delayPolls: 1,
      skipPolls: 1,
      portCount: 2,
      totalRecords: 4,
      effectiveRecords: 3,
      recordsPlayed: 1,
      durationMs: 0,
      startedAt: startedAt(1),
      outcome: "playing",
      traceFiles,
    },
  ];
}

function installRecentRunsBridge(page, options = {}) {
  return page.addInitScript(
    ({ entries, bytesById, serialConnected, bridgeState }) => {
      class FakeWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        constructor() {
          this.readyState = FakeWebSocket.CONNECTING;
          this.listeners = new Map();
          window.__recentBridgeSocket = this;
          window.setTimeout(() => {
            this.readyState = FakeWebSocket.OPEN;
            this.dispatch("open", {});
            this.reply({
              type: "status",
              middlewareConnected: true,
              serialConnected,
              serialPath: serialConnected ? "/dev/cu.usbmodem-recent" : "",
            });
          }, 0);
        }

        addEventListener(type, listener) {
          const listeners = this.listeners.get(type) || [];
          listeners.push(listener);
          this.listeners.set(type, listeners);
        }

        close() {
          this.readyState = FakeWebSocket.CLOSED;
          this.dispatch("close", {});
        }

        dispatch(type, event) {
          (this.listeners.get(type) || []).forEach((listener) => listener(event));
        }

        reply(message) {
          window.setTimeout(() => {
            this.dispatch("message", { data: JSON.stringify(message) });
          }, 0);
        }

        send(rawMessage) {
          const message = JSON.parse(rawMessage);
          window.__recentBridgeMessages.push(message);
          this.handle(message);
        }

        tasStatus(command, state, extra = {}) {
          this.reply({
            type: "tas_status",
            command,
            bridge_owned: 1,
            bridge_state: state,
            run_id: window.__recentRunId,
            client_run_id: window.__recentClientRunId,
            active: ["arming", "armed", "streaming", "playing", "paused"].includes(state) ? 1 : 0,
            ready: state === "armed" ? 1 : 0,
            start_requested: 0,
            started: 0,
            complete: 0,
            current: 0,
            total: window.__recentTotal,
            received: window.__recentTotal,
            buffered: window.__recentTotal,
            capacity: 512,
            error: "ok",
            message: `OK ${command}`,
            ...extra,
          });
        }

        handle(message) {
          if (message.type === "tas_status") {
            this.tasStatus("tas_status", bridgeState);
            return;
          }
          if (message.type === "connect") {
            serialConnected = true;
            this.reply({
              type: "status",
              middlewareConnected: true,
              serialConnected: true,
              serialPath: "/dev/cu.usbmodem-recent",
            });
            return;
          }
          if (message.type === "recent_runs_list") {
            this.reply({
              type: "recent_runs",
              requestId: message.requestId,
              entries: window.__recentEntries,
            });
            return;
          }
          if (message.type === "recent_run_load") {
            const entry = window.__recentEntries.find((item) => item.id === message.id);
            if (!entry || !bytesById[message.id]) {
              this.reply({
                type: "recent_runs_error",
                requestId: message.requestId,
                message: "Recent run source is unavailable.",
              });
              return;
            }
            this.reply({
              type: "recent_run_source_loaded",
              requestId: message.requestId,
              id: message.id,
              fileName: entry.fileName,
              bytesBase64: bytesById[message.id],
              restore: {
                syncMode: entry.syncMode,
                delayPolls: entry.delayPolls,
                skipPolls: entry.skipPolls,
              },
              portCount: entry.portCount,
              totalRecords: entry.totalRecords,
            });
            return;
          }
          if (message.type === "recent_run_delete") {
            window.__recentEntries = window.__recentEntries.filter((item) => item.id !== message.id);
            this.reply({
              type: "recent_runs",
              requestId: message.requestId,
              entries: window.__recentEntries,
            });
            return;
          }
          if (message.type === "recent_runs_clear") {
            window.__recentEntries = [];
            this.reply({
              type: "recent_runs",
              requestId: message.requestId,
              entries: [],
            });
            return;
          }
          if (message.type === "tas_cancel") {
            this.tasStatus("tas_cancel", "stopped");
            return;
          }
          if (message.type === "tas_upload") {
            window.__recentRunId += 1;
            window.__recentClientRunId = message.clientRunId;
            window.__recentTotal = message.frameCount;
            this.tasStatus("tas_upload", "uploaded");
            if (message.sourceKey) {
              this.reply({
                type: "recent_run_source_request",
                sourceRequestId: `source-${window.__recentRunId}`,
                sourceKey: message.sourceKey,
                bridgeRunId: window.__recentRunId,
              });
            }
            return;
          }
          if (message.type === "tas_arm") {
            this.tasStatus("tas_arm", "armed", { ready: 1 });
          }
        }
      }

      window.__recentEntries = entries;
      window.__recentBridgeMessages = [];
      window.__recentRunId = 7;
      window.__recentClientRunId = 0;
      window.__recentTotal = 0;
      window.__broadcastRecentRuns = (nextEntries) => {
        window.__recentEntries = nextEntries;
        window.__recentBridgeSocket.reply({
          type: "recent_runs",
          entries: nextEntries,
        });
      };
      window.WebSocket = FakeWebSocket;
    },
    {
      entries: recentEntries(),
      bytesById: RECENT_BYTES,
      serialConnected: options.serialConnected !== false,
      bridgeState: options.bridgeState || "idle",
    },
  );
}

async function openRecentRuns(page) {
  await page.goto("/");
  await page.click("#recentRunsButton");
  await expect(page.locator("#recentRunsDialog")).toBeVisible();
  await expect(page.locator(".recent-run-row")).toHaveCount(7);
}

async function clientMessages(page, type) {
  return page.evaluate(
    (messageType) =>
      window.__recentBridgeMessages.filter((message) => message.type === messageType),
    type,
  );
}

test.describe("recent runs picker", () => {
  test("renders run details and persists the completed-only filter", async ({ page }) => {
    await installRecentRunsBridge(page);
    await openRecentRuns(page);

    const completed = page.locator('[data-recent-run-id="r08-completed"]');
    await expect(completed).toContainText("Completed");
    await expect(completed).toContainText("Played 18:53");
    await expect(completed).toContainText("4 / 4 records (100%)");
    await expect(completed).toContainText("per strobe");
    await expect(completed).toContainText("delay 1");
    await expect(completed).toContainText("skip 2");

    await page.check("#recentRunsCompletedOnly");
    await expect(page.locator(".recent-run-row")).toHaveCount(3);
    await expect(page.locator("#recentRunsCount")).toHaveText("3 of 7 runs");
    await page.click("#recentRunsClose");
    await page.click("#recentRunsButton");
    await expect(page.locator("#recentRunsCompletedOnly")).toBeChecked();
    await expect(page.locator(".recent-run-row")).toHaveCount(3);
  });

  test("applies every sort key and flips sort direction", async ({ page }) => {
    await installRecentRunsBridge(page);
    await openRecentRuns(page);

    const descendingFirst = {
      date: "r08-traced",
      name: "r08-traced",
      played: "r08-completed",
      length: "tdmask-exact",
      completed: "tdmask-exact",
      mode: "r08-stopped",
      delay: "r08-stopped",
      skip: "tdmask-exact",
    };
    for (const [sortKey, firstId] of Object.entries(descendingFirst)) {
      await page.selectOption("#recentRunsSort", sortKey);
      await expect(page.locator(".recent-run-row").first()).toHaveAttribute(
        "data-recent-run-id",
        firstId,
      );
    }

    await page.selectOption("#recentRunsSort", "name");
    await page.click("#recentRunsSortDirection");
    await expect(page.locator("#recentRunsSortDirection")).toHaveAttribute(
      "aria-label",
      "Sort ascending",
    );
    await expect(page.locator(".recent-run-row").first()).toHaveAttribute(
      "data-recent-run-id",
      "tdmask-error",
    );
  });

  test("loads R08 settings and keeps TD2P in completed-read mode", async ({ page }) => {
    await installRecentRunsBridge(page);
    await openRecentRuns(page);

    await page.locator('[data-recent-run-id="r08-completed"] .recent-run-load').click();
    await expect(page.locator("#recentRunsDialog")).toBeHidden();
    await expect(page.locator("#fileName")).toHaveText("shared.r08");
    await expect(page.locator("#playbackStatusText")).toContainText("Manual controls stay active");
    await expect(page.locator("#syncMode")).toHaveValue("strobe");
    await expect(page.locator("#syncDelayPolls")).toHaveValue("1");
    await expect(page.locator("#syncSkipPolls")).toHaveValue("2");
    await expect.poll(async () => (await clientMessages(page, "tas_upload")).length).toBe(1);
    let upload = (await clientMessages(page, "tas_upload")).at(-1);
    expect(upload.syncMode).toBe("strobe");
    expect(upload.skipPolls).toBe(2);
    expect(upload.sourceKey).toMatch(/^fnv1a32:/);
    expect(upload.sourceByteLength).toBe(12);
    await expect.poll(async () => (await clientMessages(page, "recent_run_source")).length).toBe(1);
    const archived = (await clientMessages(page, "recent_run_source")).at(-1);
    expect(archived.fileName).toBe("shared.r08");
    expect(archived.bytesBase64).toBe(RECENT_BYTES["r08-completed"]);

    await page.click("#recentRunsButton");
    await page.locator('[data-recent-run-id="tdmask-exact"] .recent-run-load').click();
    await expect(page.locator("#fileName")).toHaveText("exact.tdmask");
    await expect(page.locator("#syncMode")).toHaveValue("poll");
    await expect(page.locator("#syncModeField")).toBeHidden();
    await expect(page.locator("#syncDelayPolls")).toHaveValue("3");
    await expect(page.locator("#syncSkipPolls")).toHaveValue("3");
    await expect.poll(async () => (await clientMessages(page, "tas_upload")).length).toBe(2);
    upload = (await clientMessages(page, "tas_upload")).at(-1);
    expect(upload.syncMode).toBe("poll");
    expect(upload.skipPolls).toBe(3);
  });

  test("re-runs once, cancels displaced local work, and stops armed", async ({ page }) => {
    await installRecentRunsBridge(page);
    await openRecentRuns(page);

    await page.locator('[data-recent-run-id="r08-completed"] .recent-run-rerun').click();
    await expect(page.locator("#recentRunsDialog")).toBeHidden();
    await expect(page.locator("#playButton")).toHaveText("Start");
    await expect.poll(async () => (await clientMessages(page, "tas_arm")).length).toBe(1);
    expect((await clientMessages(page, "tas_upload")).length).toBe(1);
    expect((await clientMessages(page, "tas_start")).length).toBe(0);

    await page.click("#recentRunsButton");
    await page.locator('[data-recent-run-id="tdmask-exact"] .recent-run-load').click();
    const types = await page.evaluate(() =>
      window.__recentBridgeMessages.map((message) => message.type),
    );
    expect(types.lastIndexOf("tas_cancel")).toBeLessThan(types.lastIndexOf("tas_upload"));
  });

  test("guards a cross-device active re-run with two clicks", async ({ page }) => {
    await installRecentRunsBridge(page, { bridgeState: "armed" });
    await openRecentRuns(page);
    const rerun = page.locator('[data-recent-run-id="r08-completed"] .recent-run-rerun');

    await rerun.click();
    await expect(rerun).toHaveText("Confirm re-run");
    expect((await clientMessages(page, "recent_run_load")).length).toBe(0);
    await rerun.click();
    await expect(page.locator("#recentRunsDialog")).toBeHidden();
    await expect.poll(async () => (await clientMessages(page, "tas_arm")).length).toBe(1);
  });

  test("keeps load available offline and explains disabled re-run and missing sources", async ({ page }) => {
    await installRecentRunsBridge(page, { serialConnected: false });
    await openRecentRuns(page);

    const available = page.locator('[data-recent-run-id="r08-completed"]');
    await expect(available.locator(".recent-run-load")).toBeEnabled();
    await expect(available.locator(".recent-run-rerun")).toBeDisabled();
    await expect(available.locator(".recent-run-rerun")).toHaveAttribute(
      "title",
      "Connect the Arduino USB bridge to re-run.",
    );

    const unavailable = page.locator('[data-recent-run-id="tdmask-error"]');
    await expect(unavailable.locator(".recent-run-load")).toBeDisabled();
    await expect(unavailable.locator(".recent-run-rerun")).toBeDisabled();
    await expect(unavailable.locator(".recent-run-source-note")).toHaveText(
      "Stream not archived — open the file with Open.",
    );
  });

  test("renders anomalies, duplicate tags, and expandable copyable traces", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    await installRecentRunsBridge(page);
    await openRecentRuns(page);

    const errorRow = page.locator('[data-recent-run-id="tdmask-error"]');
    await expect(errorRow.locator(".recent-run-anomaly")).toHaveCount(3);
    await expect(errorRow).toContainText("135,934 anomalies (kind 4)");
    await expect(errorRow.locator(".recent-run-outcome")).toHaveText("Error");
    await expect(page.locator('[data-recent-run-id="r08-completed"] .recent-run-anomaly')).toHaveCount(0);

    await expect(page.locator('[data-recent-run-id="r08-completed"] .recent-run-name-tag')).toHaveText("aaaaaaa");
    await expect(page.locator('[data-recent-run-id="r08-stopped"] .recent-run-name-tag')).toHaveText("bbbbbbb");
    await expect(page.locator('[data-recent-run-id="r08-replay-1"] .recent-run-name-tag')).toHaveCount(0);
    await expect(page.locator('[data-recent-run-id="r08-replay-2"] .recent-run-name-tag')).toHaveCount(0);
    await expect(page.locator('[data-recent-run-id="tdmask-exact"] .recent-run-name-tag')).toHaveCount(0);

    const traced = page.locator('[data-recent-run-id="r08-traced"]');
    await expect(traced.locator(".recent-run-trace")).toHaveCount(5);
    await expect(traced.locator(".recent-run-trace").first()).toContainText("(manual)");
    await traced.locator(".recent-run-trace-toggle").click();
    await expect(traced.locator(".recent-run-trace")).toHaveCount(7);
    await traced.locator(".recent-run-copy-path").first().click();
    await expect.poll(() => page.evaluate(() => window.navigator.clipboard.readText())).toBe(
      "logs/trace/2026-07-29_traced-1.trace",
    );
    await expect(page.locator('[data-recent-run-id="tdmask-exact"] .recent-run-diagnostics')).toHaveCount(0);
    await context.close();
  });

  test("updates from broadcasts, deletes rows, confirms clear, and shows both empty states", async ({
    page,
  }) => {
    await installRecentRunsBridge(page);
    await openRecentRuns(page);

    await page.evaluate(() => {
      window.__broadcastRecentRuns(
        window.__recentEntries.filter((entry) => entry.id !== "r08-stopped"),
      );
    });
    await expect(page.locator('[data-recent-run-id="r08-stopped"]')).toHaveCount(0);
    await page.locator('[data-recent-run-id="r08-completed"] .recent-run-delete').click();
    await expect(page.locator('[data-recent-run-id="r08-completed"]')).toHaveCount(0);

    await page.click("#recentRunsClear");
    await expect(page.locator("#recentRunsClear")).toHaveText("Confirm clear");
    await page.click("#recentRunsClear");
    await expect(page.locator("#recentRunsMessage")).toHaveText(
      "No runs played yet. Open a .tdmask or .r08 file and press Play.",
    );

    await page.evaluate(() => {
      window.__broadcastRecentRuns([
        {
          ...window.__recentEntries[0],
          id: "not-complete",
          fileName: "not-complete.r08",
          outcome: "stopped",
        },
      ]);
    });
    await page.check("#recentRunsCompletedOnly");
    await expect(page.locator("#recentRunsMessage")).toHaveText(
      'No completed runs yet. Uncheck "Completed runs only" to see every run.',
    );
  });

  test("closes on Escape, returns focus, and stays contained at phone sizes", async ({ page }) => {
    await installRecentRunsBridge(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openRecentRuns(page);

    const portraitBounds = await page.locator("#recentRunsDialog").boundingBox();
    const toolbarBounds = await page.locator(".recent-runs-toolbar").boundingBox();
    const widestRow = await page.locator(".recent-run-row").evaluateAll((rows) =>
      Math.max(...rows.map((row) => row.getBoundingClientRect().width)),
    );
    expect(toolbarBounds.width).toBeLessThanOrEqual(portraitBounds.width);
    expect(widestRow).toBeLessThanOrEqual(portraitBounds.width);

    await page.keyboard.press("Escape");
    await expect(page.locator("#recentRunsDialog")).toBeHidden();
    await expect(page.locator("#recentRunsButton")).toBeFocused();
    await page.click("#recentRunsButton");
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.locator("#recentRunsDialog")).toBeVisible();
    const landscapeBounds = await page.locator("#recentRunsDialog").boundingBox();
    expect(landscapeBounds.height).toBeLessThanOrEqual(390);
    await page.keyboard.press("Escape");
    await expect(page.locator("#recentRunsDialog")).toBeHidden();
  });
});
