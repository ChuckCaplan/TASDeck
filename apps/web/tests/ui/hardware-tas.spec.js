/* global window */

const { Buffer } = require("node:buffer");

const { expect, test } = require("@playwright/test");

const TD2P_V1_HEADER = Buffer.from([0x54, 0x44, 0x32, 0x50, 0x01, 0x02, 0x0d, 0x0a]);

function tdmaskBuffer(port1Masks) {
  return Buffer.concat([TD2P_V1_HEADER, Buffer.from(port1Masks.flatMap((mask) => [mask, 0]))]);
}

function installFakeBridge(page, options = {}) {
  return page.addInitScript((fakeOptions) => {
    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor() {
        this.readyState = FakeWebSocket.CONNECTING;
        this.listeners = new Map();
        window.__fakeBridgeSocket = this;
        window.setTimeout(() => {
          this.readyState = FakeWebSocket.OPEN;
          this.dispatch("open", {});
          const initialStatus = {
            type: "status",
            middlewareConnected: true,
            serialConnected: false,
          };
          if (fakeOptions.syncConnectStatus) {
            this.dispatch("message", { data: JSON.stringify(initialStatus) });
          } else {
            this.sendBridgeMessage(initialStatus);
          }
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

      send(rawMessage) {
        const message = JSON.parse(rawMessage);
        window.__fakeBridgeMessages.push(message);
        this.handleClientMessage(message);
      }

      dispatch(type, event) {
        (this.listeners.get(type) || []).forEach((listener) => listener(event));
      }

      sendBridgeMessage(message) {
        window.setTimeout(() => {
          this.dispatch("message", { data: JSON.stringify(message) });
        }, 0);
      }

      handleClientMessage(message) {
        if (message.type === "connect") {
          const status = {
            type: "status",
            middlewareConnected: true,
            serialConnected: true,
            serialPath: "/dev/cu.usbmodem-test",
          };
          if (fakeOptions.syncConnectStatus) {
            this.dispatch("message", { data: JSON.stringify(status) });
          } else {
            this.sendBridgeMessage(status);
          }
          return;
        }

        if (message.type === "tas_upload") {
          window.__fakeBridgeState.runId += 1;
          window.__fakeBridgeState.clientRunId = message.clientRunId || 0;
          window.__fakeBridgeState.total = message.frameCount;
          window.__fakeBridgeState.masks = message.masks;
          window.__fakeBridgeState.checksum = message.checksum;
          window.__fakeBridgeState.skipPolls = message.skipPolls || 0;
          window.__fakeBridgeState.received = 0;
          window.__fakeBridgeState.buffered = 0;
          window.__fakeBridgeState.started = false;
          window.__fakeBridgeState.ended = false;
          if (window.__fakeBridgeState.deferUpload) {
            window.__fakeBridgeState.pendingUploadStatus = {
              bridge_state: "uploaded",
              active: 0,
              run_id: window.__fakeBridgeState.runId,
              client_run_id: window.__fakeBridgeState.clientRunId,
            };
            return;
          }
          this.sendTasStatus("tas_upload", { bridge_state: "uploaded", active: 0 });
          return;
        }

        if (message.type === "tas_arm") {
          window.__fakeBridgeState.received = Math.min(window.__fakeBridgeState.total, 120);
          window.__fakeBridgeState.buffered = window.__fakeBridgeState.received;
          if (window.__fakeBridgeState.deferArm) {
            window.__fakeBridgeState.pendingArmStatus = {
              bridge_state: "armed",
              ready: 1,
              buffered: window.__fakeBridgeState.buffered,
              run_id: window.__fakeBridgeState.runId,
              client_run_id: window.__fakeBridgeState.clientRunId,
            };
            return;
          }
          this.sendTasStatus("tas_arm", {
            bridge_state: "armed",
            ready: 1,
            buffered: window.__fakeBridgeState.buffered,
          });
          return;
        }

        if (message.type === "tas_pause") {
          window.__fakeBridgeState.paused = true;
          this.sendTasStatus("tas_pause", {
            bridge_state: "paused",
            ready: 1,
          });
          return;
        }

        if (message.type === "tas_resume") {
          window.__fakeBridgeState.paused = false;
          window.__fakeBridgeState.received = window.__fakeBridgeState.total;
          this.sendTasStatus("tas_resume", {
            bridge_state: "streaming",
            ready: 1,
          });
          return;
        }

        if (message.type === "tas_start") {
          window.__fakeBridgeState.started = true;
          this.sendTasStatus("tas_start", {
            bridge_state: "streaming",
            ready: 1,
            start_requested: 1,
            buffered: window.__fakeBridgeState.buffered,
          });
          return;
        }

        if (message.type === "tas_cancel") {
          window.__fakeBridgeState.cancelled = true;
          const cancelStatus = {
            bridge_state: "stopped",
            active: 0,
            ready: 0,
            buffered: 0,
            capacity: 512,
            run_id: window.__fakeBridgeState.runId,
            client_run_id: window.__fakeBridgeState.clientRunId,
          };
          if (window.__fakeBridgeState.deferCancel) {
            window.__fakeBridgeState.pendingCancelStatus = cancelStatus;
            return;
          }
          this.sendTasStatus("tas_cancel", {
            ...cancelStatus,
          });
          return;
        }

        if (message.type === "tas_status") {
          window.__fakeBridgeState.statusPolls += 1;
          this.sendTasStatus("tas_status", {
            bridge_state:
              window.__fakeBridgeState.runId === 0
                ? "idle"
                : window.__fakeBridgeState.started
                  ? "streaming"
                  : "uploaded",
            ready: window.__fakeBridgeState.runId === 0 ? 0 : 1,
            current: window.__fakeBridgeState.current,
            buffered: 48,
            capacity: 120,
            latch: window.__fakeBridgeState.latch,
            clock: window.__fakeBridgeState.clock,
          });
          return;
        }

        if (message.type === "save_event_log") {
          window.__savedEventLogRequest = message;
          this.sendBridgeMessage({
            type: "event_log_saved",
            requestId: message.requestId,
            path: "logs/trace/2026-07-03T20-39-34-149Z_test.trace",
            fileName: "2026-07-03T20-39-34-149Z_test.trace",
            bytes: message.text.length,
          });
          return;
        }

        if (message.type === "tas_trace") {
          const rows = Array.isArray(fakeOptions.traceRows)
            ? fakeOptions.traceRows
            : [
                {
                  sequence: 10,
                  tasFrame: 8,
                  latchCount: 20,
                  clockCount: 160,
                  clocksSinceLatch: 8,
                  polledMask: 0x01,
                  nextMask: 0x00,
                  clockedMask: 0x01,
                  result: "ok",
                },
                {
                  sequence: 11,
                  tasFrame: 9,
                  latchCount: 24,
                  clockCount: 176,
                  clocksSinceLatch: 8,
                  polledMask: 0x00,
                  nextMask: 0x80,
                  clockedMask: 0x00,
                  result: "ok",
                },
              ];
          const firstSequence = rows.length > 0 ? rows[0].sequence : 10;
          const nextSequence = rows.length > 0 ? rows[rows.length - 1].sequence + 1 : firstSequence;
          this.sendBridgeMessage({
            type: "tas_trace",
            command: "tas_trace",
            bridge_owned: 1,
            total: rows.length,
            capacity: 512,
            first: firstSequence,
            next: nextSequence,
            start: firstSequence,
            count: rows.length,
            rows,
          });
        }
      }

      sendTasStatus(command, overrides = {}) {
        window.__fakeBridgeState.current = overrides.current ?? window.__fakeBridgeState.current;
        window.__fakeBridgeState.latch = overrides.latch ?? window.__fakeBridgeState.latch;
        window.__fakeBridgeState.clock = overrides.clock ?? window.__fakeBridgeState.clock;
        this.sendBridgeMessage({
          type: "tas_status",
          command,
          bridge_owned: 1,
          bridge_state: overrides.bridge_state ?? "uploaded",
          run_id: overrides.run_id ?? window.__fakeBridgeState.runId,
          client_run_id: overrides.client_run_id ?? window.__fakeBridgeState.clientRunId,
          active: overrides.active ?? 1,
          ready: overrides.ready ?? 0,
          start_requested: overrides.start_requested ?? 0,
          started: overrides.started ?? (window.__fakeBridgeState.started ? 1 : 0),
          complete: overrides.complete ?? 0,
          receiving_complete: overrides.receiving_complete ?? 0,
          current: window.__fakeBridgeState.current,
          total: window.__fakeBridgeState.total,
          received: overrides.received ?? window.__fakeBridgeState.received,
          buffered: overrides.buffered ?? window.__fakeBridgeState.buffered,
          capacity: overrides.capacity ?? 512,
          mask: overrides.mask ?? 0,
          latch: window.__fakeBridgeState.latch,
          clock: window.__fakeBridgeState.clock,
          error: "ok",
          message: `OK ${command}`,
        });
      }
    }

    window.__fakeBridgeMessages = [];
    window.__fakeBridgeState = {
      total: 0,
      received: 0,
      buffered: 0,
      masks: [],
      checksum: 0,
      current: 0,
      latch: 0,
      clock: 0,
      started: false,
      ended: false,
      cancelled: false,
      paused: false,
      statusPolls: 0,
      runId: 0,
      clientRunId: 0,
      deferUpload: false,
      pendingUploadStatus: null,
      deferArm: false,
      pendingArmStatus: null,
      deferCancel: false,
      pendingCancelStatus: null,
    };
    window.WebSocket = FakeWebSocket;
  }, options);
}

async function connectFakeNetworkBridge(page) {
  await page.goto("/");
  await expect(page.locator("#connectionLabel")).toHaveText("Arduino USB offline");
  await page.click("#toggleConnection");
  await expect(page.locator("#connectionLabel")).toHaveText("Arduino USB online");
}

async function uploadShortTas(page) {
  await page.setInputFiles("#tasFile", {
    name: "short.tdmask",
    mimeType: "application/octet-stream",
    buffer: tdmaskBuffer([0x08, 0x01, 0x00]),
  });
}

async function messageTypes(page) {
  return page.evaluate(() => window.__fakeBridgeMessages.map((message) => message.type));
}

test.describe("hardware TAS streaming UI", () => {
  test("keeps loaded file details compact at desktop width", async ({ page }) => {
    await installFakeBridge(page);
    await page.setViewportSize({ width: 1390, height: 720 });
    await page.goto("/");

    await page.setInputFiles("#tasFile", {
      name: "Nightshade.tdmask",
      mimeType: "application/octet-stream",
      buffer: tdmaskBuffer(Array.from({ length: 28779 }, (_, index) => (index === 0 ? 0x01 : 0x00))),
    });

    await expect(page.locator("#playbackStatusText")).toHaveText(
      "Ready · TD2P · 28779 masks · completed reads",
    );
    await expect(page.locator("#syncModeField")).toBeHidden();
    await expect(page.locator('#syncMode option[value="strobe"]')).toHaveText("per strobe (r08 replay)");
    const tdmaskLayout = await page.locator(".layout-grid").boundingBox();
    const tdmaskShortcuts = await page.locator(".shortcut-note").boundingBox();
    const tdmaskGap =
      tdmaskLayout.y + tdmaskLayout.height - (tdmaskShortcuts.y + tdmaskShortcuts.height);
    expect(tdmaskGap).toBeLessThan(60);

    await page.setInputFiles("#tasFile", {
      name: "Nightshade.r08",
      mimeType: "application/octet-stream",
      buffer: Buffer.from([0x80, 0x00, 0x00, 0x00]),
    });
    await expect(page.locator("#playbackStatusText")).toHaveText("Ready · R08 · 2 records");
    await expect(page.locator("#syncModeField")).toBeVisible();
    await expect(page.locator(".file-actions #syncMode")).toHaveCount(0);
    await expect(page.locator("#playbackStatus #syncMode")).toBeVisible();
    await expect(page.locator("#syncMode")).toHaveValue("poll");
    await expect(page.locator("#syncMode option:checked")).toHaveText("completed reads");
    const r08Layout = await page.locator(".layout-grid").boundingBox();
    const r08Shortcuts = await page.locator(".shortcut-note").boundingBox();
    const r08Gap = r08Layout.y + r08Layout.height - (r08Shortcuts.y + r08Shortcuts.height);
    expect(r08Gap).toBeLessThan(60);
  });

  test("connect handles an immediate serial-ready status", async ({ page }) => {
    await installFakeBridge(page, { syncConnectStatus: true });

    await connectFakeNetworkBridge(page);

    expect(await messageTypes(page)).toContain("connect");
  });

  test("uploads TAS without arming so manual controls remain usable", async ({ page }) => {
    await installFakeBridge(page);
    await connectFakeNetworkBridge(page);

    await uploadShortTas(page);

    await expect(page.locator("#playButton")).toHaveText("Play");
    await expect(page.locator("#playbackStatus")).toContainText("Manual controls stay active");

    expect(await messageTypes(page)).toContain("tas_upload");
    expect(await messageTypes(page)).not.toContain("tas_arm");
    expect(await messageTypes(page)).not.toContain("tas_chunk");
    expect(await messageTypes(page)).not.toContain("tas_start");

    await page.locator('[data-button="a"]').click();
    const events = await page.evaluate(() =>
      window.__fakeBridgeMessages.filter((message) => message.type === "event").map((message) => message.event),
    );
    expect(events.map((event) => `${event.button}:${event.action}`)).toEqual(["a:down", "a:up"]);
  });

  test("parses and uploads a binary two-controller mask stream", async ({ page }) => {
    await installFakeBridge(page);
    await connectFakeNetworkBridge(page);

    await page.setInputFiles("#tasFile", {
      name: "two-player.tdmask",
      mimeType: "application/octet-stream",
      buffer: Buffer.concat([
        TD2P_V1_HEADER,
        Buffer.from([0x01, 0x02, 0x00, 0x08]),
      ]),
    });

    await expect.poll(async () => (await messageTypes(page)).includes("tas_upload")).toBe(true);
    const upload = await page.evaluate(() =>
      window.__fakeBridgeMessages.filter((message) => message.type === "tas_upload").at(-1),
    );
    expect(upload.portCount).toBe(2);
    expect(upload.frameCount).toBe(2);
    expect(upload.syncMode).toBe("poll");
    // Two-port masks travel as flat interleaved p1,p2 bytes on the wire.
    expect(upload.masks).toEqual([0x01, 0x02, 0x00, 0x08]);
  });

  test("sends skip-first poll count with TAS upload", async ({ page }) => {
    await installFakeBridge(page);
    await connectFakeNetworkBridge(page);

    await page.setInputFiles("#tasFile", {
      name: "skip-test.tdmask",
      mimeType: "application/octet-stream",
      buffer: tdmaskBuffer(Array.from({ length: 12 }, (_, index) => (index === 0 ? 0x08 : 0x01))),
    });
    await page.fill("#syncSkipPolls", "2");
    await page.click("#playButton");

    await expect.poll(async () => (await messageTypes(page)).includes("tas_upload")).toBe(true);
    const upload = await page.evaluate(() =>
      window.__fakeBridgeMessages.filter((message) => message.type === "tas_upload").at(-1),
    );
    expect(upload.skipPolls).toBe(2);
    expect(upload.frameCount).toBe(12);
  });

  test("parses and uploads R08 records with poll synchronization by default", async ({ page }) => {
    await installFakeBridge(page);
    await connectFakeNetworkBridge(page);

    await page.setInputFiles("#tasFile", {
      name: "movie.r08",
      mimeType: "application/octet-stream",
      buffer: Buffer.from([0x80, 0x40, 0x01, 0x00]),
    });

    await expect.poll(async () => (await messageTypes(page)).includes("tas_upload")).toBe(true);
    const upload = await page.evaluate(() =>
      window.__fakeBridgeMessages.filter((message) => message.type === "tas_upload").at(-1),
    );
    expect(upload.syncMode).toBe("poll");
    expect(upload.portCount).toBe(2);
    expect(upload.frameCount).toBe(2);
    expect(upload.masks).toEqual([0x01, 0x02, 0x80, 0x00]);
    await expect(page.locator("#currentFrame")).toContainText("R08 two-controller stream");
  });

  test("lets R08 loads use latch synchronization", async ({ page }) => {
    await installFakeBridge(page);
    await connectFakeNetworkBridge(page);

    await page.setInputFiles("#tasFile", {
      name: "movie.r08",
      mimeType: "application/octet-stream",
      buffer: Buffer.from([0x80, 0x40, 0x01, 0x00]),
    });

    await expect(page.locator("#syncMode")).toBeEnabled();
    await page.locator("#syncMode").selectOption("latch");
    await expect(page.locator("#playbackStatusText")).toHaveText("Ready · R08 · 2 records");
    await expect(page.locator("#syncMode option:checked")).toHaveText("per accepted latch");
    await page.click("#playButton");
    await expect.poll(async () =>
      page.evaluate(() => window.__fakeBridgeMessages.filter((message) => message.type === "tas_upload").length),
    ).toBe(2);
    const upload = await page.evaluate(() =>
      window.__fakeBridgeMessages.filter((message) => message.type === "tas_upload").at(-1),
    );
    expect(upload.syncMode).toBe("latch");
  });

  test("lets R08 loads use per-strobe synchronization with mode-aware controls", async ({ page }) => {
    await installFakeBridge(page);
    await connectFakeNetworkBridge(page);

    await page.setInputFiles("#tasFile", {
      name: "movie.r08",
      mimeType: "application/octet-stream",
      buffer: Buffer.from([0x80, 0x40, 0x01, 0x00]),
    });

    await expect(page.locator("#syncDelayUnit")).toHaveText("windows");
    await expect(page.locator("#syncSkipUnit")).toHaveText("frames");
    await page.locator("#syncMode").selectOption("strobe");
    await expect(page.locator("#syncMode option:checked")).toHaveText("per strobe (r08 replay)");
    await expect(page.locator("#syncDelayUnit")).toHaveText("strobes");
    await expect(page.locator("#syncSkipUnit")).toHaveText("records");

    await page.locator("#syncMode").selectOption("poll");
    await expect(page.locator("#syncDelayUnit")).toHaveText("windows");
    await expect(page.locator("#syncSkipUnit")).toHaveText("frames");

    await page.locator("#syncMode").selectOption("strobe");
    await page.click("#playButton");
    await expect(page.locator("#playButton")).toHaveText("Start");
    await expect(page.locator("#playbackStatus")).toContainText("at the next latch strobe");

    const upload = await page.evaluate(() =>
      window.__fakeBridgeMessages.filter((message) => message.type === "tas_upload").at(-1),
    );
    expect(upload.syncMode).toBe("strobe");
  });

  test("play arms the Arduino, then Start begins playback", async ({ page }) => {
    await installFakeBridge(page);
    await connectFakeNetworkBridge(page);

    await uploadShortTas(page);
    await expect(page.locator("#playButton")).toHaveText("Play");

    await page.click("#playButton");
    await expect.poll(async () => (await messageTypes(page)).includes("tas_arm")).toBe(true);
    await expect(page.locator("#playButton")).toHaveText("Start");
    expect(await messageTypes(page)).not.toContain("tas_start");

    await page.click("#playButton");
    await expect.poll(async () => (await messageTypes(page)).includes("tas_start")).toBe(true);
    const types = await messageTypes(page);
    expect(types).toContain("tas_arm");
    expect(types.indexOf("tas_arm")).toBeLessThan(types.indexOf("tas_start"));
  });

  test("stop cancels an arming run before TAS_START", async ({ page }) => {
    await installFakeBridge(page);
    await connectFakeNetworkBridge(page);

    await page.evaluate(() => {
      window.__fakeBridgeState.deferArm = true;
    });
    await uploadShortTas(page);
    await page.click("#playButton");
    await expect(page.locator("#playbackStatus")).toContainText("prebuffering");

    await page.click("#stopButton");
    await expect(page.locator("#playbackStatus")).toContainText("already buffered");

    await expect.poll(async () => (await messageTypes(page)).includes("tas_cancel")).toBe(true);
    expect(await messageTypes(page)).not.toContain("tas_start");
  });

  test("pause and resume control bridge-owned streaming", async ({ page }) => {
    await installFakeBridge(page);
    await connectFakeNetworkBridge(page);

    await page.setInputFiles("#tasFile", {
      name: "long.tdmask",
      mimeType: "application/octet-stream",
      buffer: tdmaskBuffer(Array.from({ length: 200 }, () => 0x01)),
    });
    await expect(page.locator("#playButton")).toHaveText("Play");

    await page.click("#playButton");
    await expect(page.locator("#playButton")).toHaveText("Start");
    await page.click("#playButton");
    await expect.poll(async () => (await messageTypes(page)).includes("tas_start")).toBe(true);
    await page.click("#pauseButton");
    await expect.poll(async () => (await messageTypes(page)).includes("tas_pause")).toBe(true);
    expect(await messageTypes(page)).not.toContain("tas_chunk");

    await page.click("#playButton");
    await expect.poll(async () => (await messageTypes(page)).includes("tas_resume")).toBe(true);
  });

  test("uploads TAS masks once so the bridge owns chunk streaming", async ({ page }) => {
    await installFakeBridge(page);
    await connectFakeNetworkBridge(page);

    await page.setInputFiles("#tasFile", {
      name: "long.tdmask",
      mimeType: "application/octet-stream",
      buffer: tdmaskBuffer(Array.from({ length: 200 }, () => 0x01)),
    });
    await expect(page.locator("#playButton")).toHaveText("Play");

    await page.click("#playButton");
    await expect(page.locator("#playButton")).toHaveText("Start");
    await page.click("#playButton");
    await expect.poll(async () => (await messageTypes(page)).includes("tas_start")).toBe(true);

    const state = await page.evaluate(() => window.__fakeBridgeState);

    expect(state.masks).toHaveLength(400);
    expect(state.checksum).toBeGreaterThan(0);
    expect(await messageTypes(page)).not.toContain("tas_chunk");
  });

  test("marks bridge-owned TAS complete from final firmware status", async ({ page }) => {
    await installFakeBridge(page);
    await connectFakeNetworkBridge(page);

    await uploadShortTas(page);
    await expect(page.locator("#playButton")).toHaveText("Play");

    await page.click("#playButton");
    await expect(page.locator("#playButton")).toHaveText("Start");
    await page.click("#playButton");
    await expect.poll(async () => (await messageTypes(page)).includes("tas_start")).toBe(true);

    await page.evaluate(() => {
      window.__fakeBridgeState.received = window.__fakeBridgeState.total;
      window.__fakeBridgeSocket.sendTasStatus("tas_status", {
        bridge_state: "streaming",
        active: 0,
        ready: 0,
        started: 1,
        complete: 1,
        current: window.__fakeBridgeState.total,
        received: window.__fakeBridgeState.total,
        buffered: 0,
        mask: 0x80,
        latch: 180,
        clock: 1440,
      });
    });

    await expect(page.locator("#playbackStatus")).toContainText("Hardware TAS playback complete");
    await expect(page.locator("#diagTasFrame")).toHaveCount(0);
    await expect(page.locator("#eventLog")).toContainText("Hardware TAS playback complete");
  });

  test("trace captures the full ring and saves the event log", async ({ page }) => {
    await installFakeBridge(page);
    await connectFakeNetworkBridge(page);

    await page.click("#dumpTrace");

    await expect.poll(async () => (await messageTypes(page)).includes("tas_trace")).toBe(true);
    await expect.poll(async () => (await messageTypes(page)).includes("save_event_log")).toBe(true);
    await expect(page.locator("#eventLog")).toContainText("TAS trace captured 2 rows");
    await expect(page.locator("#eventLog")).toContainText("TAS trace anomalies: p=1 #11 after #10 dc=+16 dl=+4");
    await expect(page.locator("#eventLog")).toContainText("Saved event log to logs/trace/2026-07-03T20-39-34-149Z_test.trace");
    await expect(page.locator("#copyLog")).toHaveText("Copy");

    const traceRequest = await page.evaluate(() =>
      window.__fakeBridgeMessages.find((message) => message.type === "tas_trace"),
    );
    expect(traceRequest.count).toBe(512);

    const saveRequest = await page.evaluate(() => window.__savedEventLogRequest);
    expect(saveRequest.reason).toBe("tas-trace");
    expect(saveRequest.metadata).toMatchObject({
      tasFileName: "None",
      skipPolls: 0,
      delayPolls: 0,
      traceCount: 2,
    });
    expect(saveRequest.text).toContain("NES Event Log");
    expect(saveRequest.text).toContain("TAS trace captured 2 rows");
    expect(saveRequest.text).toContain("TAS trace anomalies: p=1 #11 after #10 dc=+16 dl=+4");
    expect(saveRequest.text).toContain("#10 p=1 f=8");
    expect(saveRequest.text).toContain("mask=0x01");
    expect(saveRequest.text).toContain("line=0x01");
  });

  test("trace handles legacy firmware rows without line values", async ({ page }) => {
    await installFakeBridge(page, {
      traceRows: [
        {
          sequence: 10,
          tasFrame: 8,
          latchCount: 20,
          clockCount: 160,
          clocksSinceLatch: 8,
          polledMask: 0x01,
          nextMask: 0x01,
          result: "ok",
        },
        {
          sequence: 11,
          tasFrame: 9,
          latchCount: 22,
          clockCount: 168,
          clocksSinceLatch: 8,
          polledMask: 0x01,
          nextMask: 0x00,
          result: "ok",
        },
      ],
    });
    await connectFakeNetworkBridge(page);

    await page.click("#dumpTrace");

    await expect.poll(async () => (await messageTypes(page)).includes("save_event_log")).toBe(true);
    await expect(page.locator("#eventLog")).toContainText("TAS trace anomalies: none detected");

    const saveRequest = await page.evaluate(() => window.__savedEventLogRequest);
    expect(saveRequest.text).toContain("mask=0x01");
    expect(saveRequest.text).not.toContain("line=");
  });

  test("trace analysis treats strobe-edge rows by edge kind", async ({ page }) => {
    await installFakeBridge(page, {
      traceRows: [
        { sequence: 10, port: 1, latchCount: 1, clockCount: 0, clocksSinceLatch: 0, polledMask: 0x00, clockedMask: 0x00, result: "waiting", diag: 0x2c },
        { sequence: 11, port: 2, latchCount: 1, clockCount: 0, clocksSinceLatch: 0, polledMask: 0x00, clockedMask: 0x00, result: "waiting", diag: 0x2c },
        { sequence: 12, port: 1, latchCount: 2, clockCount: 8, clocksSinceLatch: 8, polledMask: 0x01, clockedMask: 0x00, result: "ok", diag: 0x28 },
        { sequence: 13, port: 2, latchCount: 2, clockCount: 8, clocksSinceLatch: 8, polledMask: 0x02, clockedMask: 0x00, result: "ok", diag: 0x28 },
        { sequence: 14, port: 1, latchCount: 3, clockCount: 16, clocksSinceLatch: 8, polledMask: 0x00, clockedMask: 0x01, result: "ok", diag: 0x24 },
        { sequence: 15, port: 2, latchCount: 3, clockCount: 16, clocksSinceLatch: 8, polledMask: 0x00, clockedMask: 0x02, result: "ok", diag: 0x24 },
        { sequence: 17, port: 1, latchCount: 4, clockCount: 16, clocksSinceLatch: 0, polledMask: 0x80, clockedMask: 0x00, result: "ok", diag: 0x24 },
        { sequence: 18, port: 2, latchCount: 4, clockCount: 16, clocksSinceLatch: 0, polledMask: 0x00, clockedMask: 0x00, result: "ok", diag: 0x24 },
        { sequence: 19, port: 1, latchCount: 5, clockCount: 24, clocksSinceLatch: 8, polledMask: 0x00, clockedMask: 0x80, result: "complete", diag: 0x2e },
        { sequence: 20, port: 2, latchCount: 5, clockCount: 24, clocksSinceLatch: 8, polledMask: 0x00, clockedMask: 0x00, result: "complete", diag: 0x2e },
        { sequence: 21, port: 1, latchCount: 6, clockCount: 24, clocksSinceLatch: 0, polledMask: 0x00, clockedMask: 0x00, result: "underrun", diag: 0x2e },
      ],
    });
    await connectFakeNetworkBridge(page);

    await page.click("#dumpTrace");
    await expect.poll(async () => (await messageTypes(page)).includes("save_event_log")).toBe(true);

    const anomalies = await page.evaluate(() => window.__lastTasTraceAnomalies);
    expect(anomalies).toHaveLength(2);
    expect(anomalies.map((anomaly) => anomaly.sequence)).toEqual([17, 21]);
    expect(anomalies[0].sequenceDelta).toBe(2);
    expect(anomalies[1].result).toBe("underrun");
    await expect(page.locator("#eventLog")).toContainText("from sequence 10 to 22");
  });

  test("ignores stale cancel status after replacing a TAS file", async ({ page }) => {
    await installFakeBridge(page);
    await connectFakeNetworkBridge(page);

    await page.evaluate(() => {
      window.__fakeBridgeState.deferCancel = true;
    });
    await uploadShortTas(page);
    await expect(page.locator("#playButton")).toHaveText("Play");

    await page.setInputFiles("#tasFile", {
      name: "invalid.tdmask",
      mimeType: "application/octet-stream",
      buffer: tdmaskBuffer([0x00]),
    });
    await expect(page.locator("#playbackStatus")).toContainText("no recognized NES controller input");

    await page.evaluate(() => {
      window.__fakeBridgeSocket.sendTasStatus("tas_cancel", window.__fakeBridgeState.pendingCancelStatus);
    });

    await expect(page.locator("#playbackStatus")).toContainText("no recognized NES controller input");
    await expect(page.locator("#fileName")).toHaveText("invalid.tdmask");
  });

  test("ignores stale upload status after replacing a TAS file", async ({ page }) => {
    await installFakeBridge(page);
    await connectFakeNetworkBridge(page);

    await page.evaluate(() => {
      window.__fakeBridgeState.deferUpload = true;
    });
    await uploadShortTas(page);
    await expect(page.locator("#playbackStatus")).toContainText("Uploading TAS");

    await page.setInputFiles("#tasFile", {
      name: "invalid.tdmask",
      mimeType: "application/octet-stream",
      buffer: tdmaskBuffer([0x00]),
    });
    await expect(page.locator("#playbackStatus")).toContainText("no recognized NES controller input");

    await page.evaluate(() => {
      window.__fakeBridgeSocket.sendTasStatus("tas_upload", window.__fakeBridgeState.pendingUploadStatus);
    });

    await expect(page.locator("#playbackStatus")).toContainText("no recognized NES controller input");
    await expect(page.locator("#fileName")).toHaveText("invalid.tdmask");
  });
});
