/* global document, window */

const { devices, expect, test } = require("@playwright/test");

const iPhone = devices["iPhone 14"];

function installFakeBridge(page) {
  return page.addInitScript(() => {
    class FakeWebSocket {
      static OPEN = 1;

      constructor() {
        this.readyState = 0;
        this.listeners = new Map();
        window.__fakeBridgeMessages = [];
        window.setTimeout(() => {
          this.readyState = FakeWebSocket.OPEN;
          this.dispatch("open", {});
          this.sendBridgeMessage({
            type: "status",
            middlewareConnected: true,
            serialConnected: false,
          });
        }, 0);
      }

      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      dispatch(type, event) {
        (this.listeners.get(type) || []).forEach((listener) => listener(event));
      }

      sendBridgeMessage(message) {
        window.setTimeout(() => {
          this.dispatch("message", { data: JSON.stringify(message) });
        }, 0);
      }

      send(rawMessage) {
        const message = JSON.parse(rawMessage);
        window.__fakeBridgeMessages.push(message);
        if (message.type === "connect") {
          this.sendBridgeMessage({
            type: "status",
            middlewareConnected: true,
            serialConnected: true,
            serialPath: "/dev/cu.usbmodem-test",
          });
        }
      }
    }

    window.WebSocket = FakeWebSocket;
  });
}

async function connectFakeBridge(page) {
  await page.goto("/");
  await page.click("#toggleConnection");
  await expect(page.locator("#connectionLabel")).toHaveText("Arduino USB online");
}

function fitsWithin(inner, outer, allowance = 1) {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - allowance);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y - allowance);
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + allowance);
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height + allowance);
}

async function viewportRect(page) {
  const size = page.viewportSize();
  return { x: 0, y: 0, width: size.width, height: size.height };
}

async function elementRect(page, selector) {
  return page.locator(selector).boundingBox();
}

async function controllerFaceplateRect(page) {
  return page.locator(".controller-shell").evaluate((controller) => {
    const rect = controller.getBoundingClientRect();
    const shellStyle = window.getComputedStyle(controller);
    const faceplateStyle = window.getComputedStyle(controller, "::before");
    return {
      top:
        rect.top +
        Number.parseFloat(shellStyle.borderTopWidth) +
        Number.parseFloat(faceplateStyle.top),
      right:
        rect.right -
        Number.parseFloat(shellStyle.borderRightWidth) -
        Number.parseFloat(faceplateStyle.right),
    };
  });
}

test("groups playback offsets without leaving an empty grid cell", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");

  const grid = await elementRect(page, ".info-grid");
  const startDelay = await elementRect(page, ".info-grid > div:has(#syncDelayPolls)");
  const skipFirst = await elementRect(page, ".info-grid > div:has(#syncSkipPolls)");
  const syncMode = await elementRect(page, ".sync-mode-field");

  expect(skipFirst.y).toBeCloseTo(startDelay.y, 0);
  expect(syncMode.x).toBeCloseTo(grid.x, 0);
  expect(syncMode.width).toBeCloseTo(grid.width, 0);
  expect(syncMode.y + syncMode.height).toBeLessThan(startDelay.y);
});

test.describe("iPhone portrait controller", () => {
  test.use({
    deviceScaleFactor: iPhone.deviceScaleFactor,
    hasTouch: iPhone.hasTouch,
    isMobile: iPhone.isMobile,
    userAgent: iPhone.userAgent,
    viewport: { width: 390, height: 844 },
  });

  test("shows the whole controller without horizontal overflow", async ({ page }) => {
    await page.goto("/");

    const viewport = await viewportRect(page);
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const panel = await elementRect(page, ".connection-panel");
    const controller = await elementRect(page, ".controller-shell");
    const portToggle = await elementRect(page, ".controller-port-toggle");
    const portTwoButton = await elementRect(page, '[data-controller-port="2"]');
    const faceplate = await controllerFaceplateRect(page);
    const menuLabels = await elementRect(page, ".menu-labels");
    const menuPocket = await elementRect(page, ".menu-pocket");
    const shortcutNote = await elementRect(page, ".shortcut-note");
    const eventConsole = await elementRect(page, ".event-console");
    const clearButton = await elementRect(page, "#clearLog");
    const playbackHeading = await elementRect(
      page,
      ".playback-panel .section-heading > div:first-child",
    );
    const openButton = await elementRect(page, ".playback-panel .file-picker");

    expect(bodyWidth).toBeLessThanOrEqual(viewport.width + 1);
    expect(panel.height).toBeLessThan(80);
    fitsWithin(controller, viewport);
    fitsWithin(portToggle, controller);
    fitsWithin(shortcutNote, viewport);
    fitsWithin(clearButton, eventConsole);
    expect(portToggle.width).toBeLessThanOrEqual(controller.width * 0.2);
    expect(portToggle.y + portToggle.height).toBeLessThanOrEqual(faceplate.top);
    expect(portTwoButton.x + portTwoButton.width).toBeLessThanOrEqual(faceplate.right);
    expect(menuLabels.y + menuLabels.height).toBeLessThanOrEqual(menuPocket.y + 1);
    expect(controller.width).toBeGreaterThan(viewport.width * 0.9);
    expect(openButton.x).toBeGreaterThan(playbackHeading.x + playbackHeading.width);
    expect(openButton.y).toBeLessThan(playbackHeading.y + playbackHeading.height);
    expect(openButton.y + openButton.height).toBeGreaterThan(playbackHeading.y);
    await expect(page.locator(".device-state")).toBeVisible();
    await expect(page.locator(".shortcut-note")).toContainText("Keyboard:");
    await expect(page.locator(".playback-panel")).toBeVisible();
    await expect(page.locator(".event-console")).toBeVisible();
  });

  test("rapid taps send button events without selecting controller text", async ({ page }) => {
    await installFakeBridge(page);
    await connectFakeBridge(page);

    await page.locator('[data-button="a"]').tap();
    await page.locator('[data-button="a"]').tap();

    const logText = await page.locator("#eventLog").innerText();
    const buttonEventCount = (logText.match(/button/g) || []).length;
    const selectedText = await page.evaluate(() => window.getSelection().toString());

    expect(buttonEventCount).toBe(4);
    expect(selectedText).toBe("");
  });
});

test.describe("iPhone landscape controller", () => {
  test.use({
    deviceScaleFactor: iPhone.deviceScaleFactor,
    hasTouch: iPhone.hasTouch,
    isMobile: iPhone.isMobile,
    userAgent: iPhone.userAgent,
    viewport: { width: 844, height: 390 },
  });

  test("fills the controller view", async ({ page }) => {
    await page.goto("/");

    const viewport = await viewportRect(page);
    const controller = await elementRect(page, ".controller-shell");
    const portToggle = await elementRect(page, ".controller-port-toggle");
    const portTwoButton = await elementRect(page, '[data-controller-port="2"]');
    const faceplate = await controllerFaceplateRect(page);

    fitsWithin(controller, viewport);
    fitsWithin(portToggle, controller);
    expect(controller.width).toBeGreaterThan(viewport.width * 0.95);
    expect(controller.height).toBeGreaterThan(viewport.height * 0.7);
    expect(portToggle.y + portToggle.height).toBeLessThanOrEqual(faceplate.top);
    expect(portToggle.x).toBeGreaterThanOrEqual(controller.x + controller.width * 0.72);
    expect(portTwoButton.x + portTwoButton.width).toBeCloseTo(faceplate.right, 0);
    await expect(page.locator('[data-controller-port="1"]')).toBeVisible();
    await expect(page.locator('[data-controller-port="2"]')).toBeVisible();
    await page.locator('[data-controller-port="2"]').tap();
    await expect(page.locator('[data-controller-port="2"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".top-bar")).toBeHidden();
    await expect(page.locator(".playback-panel")).toBeHidden();
    await expect(page.locator(".event-console")).toBeHidden();
    await expect(page.locator(".shortcut-note")).toBeHidden();
  });
});

test.describe("desktop controller", () => {
  test.use({
    viewport: { width: 900, height: 640 },
  });

  test("keeps controller labels proportionate", async ({ page }) => {
    await page.goto("/");

    const controller = await elementRect(page, ".controller-shell");
    const menuLabels = await elementRect(page, ".menu-labels");
    const brand = await elementRect(page, ".controller-brand");
    const actions = await elementRect(page, ".action-buttons");

    expect(menuLabels.height).toBeLessThan(controller.height * 0.12);
    expect(brand.width).toBeLessThan(controller.width * 0.26);
    expect(brand.x + brand.width).toBeLessThan(actions.x + actions.width);
  });

  test("supports keyboard chords for controller input", async ({ page }) => {
    await installFakeBridge(page);
    await connectFakeBridge(page);

    await expect(page.locator(".shortcut-note")).toContainText("Arrows");
    await expect(page.locator(".shortcut-note")).toContainText("Shift");

    await page.keyboard.down("ArrowRight");
    await page.keyboard.down("x");

    await expect(page.locator("#controllerState")).toHaveText("P1: RIGHT + A");

    await page.keyboard.up("x");
    await page.keyboard.up("ArrowRight");

    await expect(page.locator("#controllerState")).toHaveText("P1: None");

    const logText = await page.locator("#eventLog").innerText();
    expect(logText).toContain("P1 RIGHT down");
    expect(logText).toContain("P1 A down");
    expect(logText).toContain("P1 A up");
    expect(logText).toContain("P1 RIGHT up");
  });

  test("routes selected controller port through the shared controller", async ({ page }) => {
    await installFakeBridge(page);
    await connectFakeBridge(page);

    await page.click('[data-controller-port="2"]');
    await expect(page.locator('[data-controller-port="2"]')).toHaveAttribute("aria-pressed", "true");

    await page.keyboard.down("x");
    await expect(page.locator("#controllerState")).toHaveText("P2: A");
    await page.keyboard.up("x");
    await expect(page.locator("#controllerState")).toHaveText("P2: None");

    const buttonEvents = await page.evaluate(() =>
      window.__fakeBridgeMessages
        .filter((message) => message.type === "event")
        .map((message) => message.event),
    );
    expect(buttonEvents.at(-2)).toMatchObject({ button: "a", action: "down", controllerPort: 2 });
    expect(buttonEvents.at(-1)).toMatchObject({ button: "a", action: "up", controllerPort: 2 });

    const logText = await page.locator("#eventLog").innerText();
    expect(logText).toContain("P2 A down");
    expect(logText).toContain("P2 A up");
  });

  test("releases held input before switching controller ports", async ({ page }) => {
    await installFakeBridge(page);
    await connectFakeBridge(page);

    await page.keyboard.down("x");
    await expect(page.locator("#controllerState")).toHaveText("P1: A");
    await page.click('[data-controller-port="2"]');
    await expect(page.locator("#controllerState")).toHaveText("P2: None");
    await page.keyboard.up("x");
    await page.keyboard.press("x");

    const buttonEvents = await page.evaluate(() =>
      window.__fakeBridgeMessages
        .filter((message) => message.type === "event")
        .map((message) => message.event),
    );
    expect(buttonEvents).toMatchObject([
      { button: "a", action: "down", controllerPort: 1 },
      { button: "a", action: "up", controllerPort: 1, source: "controller_switch" },
      { button: "a", action: "down", controllerPort: 2 },
      { button: "a", action: "up", controllerPort: 2 },
    ]);
  });

  test("copies the visible event log text", async ({ page }) => {
    await installFakeBridge(page);
    await connectFakeBridge(page);
    await page.evaluate(() => {
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.__copiedEventLog = text;
          },
        },
      });
    });

    await page.keyboard.down("ArrowRight");
    await page.keyboard.up("ArrowRight");
    await page.click("#copyLog");

    await expect(page.locator("#copyLog")).toHaveText("Copied");
    const copiedLog = await page.evaluate(() => window.__copiedEventLog);
    expect(copiedLog).toContain("NES Event Log");
    expect(copiedLog).toContain("RIGHT down");
    expect(copiedLog).toContain("RIGHT up");

    await page.click("#clearLog", { force: true });
    await expect(page.locator("#copyLog")).toBeDisabled();
  });
});
