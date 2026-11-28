// Chromium's password eye in a real Electron <webview> tab with the tab's Blink features: what was
// typed shows an eye that reveals it; a value a script set, as Scient's fills do, never has one.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const require = NodeModule.createRequire(import.meta.url);
const STATE_ENV = "SCIENT_PASSWORD_REVEAL_SMOKE_STATE";
const STEP_TIMEOUT_MS = 20_000;

if (!process.versions.electron) {
  const state = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-password-reveal-"));
  const environment = { ...process.env, [STATE_ENV]: state };
  delete environment.ELECTRON_RUN_AS_NODE;
  // Use the dependency runtime, never the Scient launcher or a user's app. GitHub's Linux runner
  // does not support Electron's OS sandbox; the flag is limited to this disposable process.
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone regression harness has no Effect runtime.
  const args = NodeOS.platform() === "linux" && process.env.CI ? ["--no-sandbox"] : [];
  let result;
  try {
    result = NodeChildProcess.spawnSync(
      require("electron"),
      [...args, NodeURL.fileURLToPath(import.meta.url)],
      { env: environment, stdio: "inherit", timeout: 120_000, killSignal: "SIGTERM" },
    );
  } finally {
    NodeFS.rmSync(state, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require("electron");

async function withTimeout(promise, describeStep) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${describeStep}`)), STEP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const PAGE = `data:text/html,${encodeURIComponent(
  '<!doctype html><input id="box" type="password" style="width:300px;height:30px">',
)}`;

/** The box's eye and whether its text shows, read from Chromium's own shadow tree. */
async function boxState(cdp) {
  const { root } = await cdp.sendCommand("DOM.getDocument", { depth: -1, pierce: true });
  const find = (node, test) => {
    if (test(node)) return node;
    for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) {
      const found = find(child, test);
      if (found) return found;
    }
    return undefined;
  };
  const hasId = (id) => (node) => (node.attributes ?? []).includes(id);
  const eye = find(root, hasId("password-reveal"));
  const editor = find(root, hasId("editing-view-port"))?.children?.[0];
  const style = async (node, name) =>
    (
      await cdp.sendCommand("CSS.getComputedStyleForNode", { nodeId: node.nodeId })
    ).computedStyle.find((property) => property.name === name)?.value;
  const shown = eye !== undefined && (await style(eye, "display")) !== "none";
  return {
    eye: shown,
    textShown: editor !== undefined && (await style(editor, "-webkit-text-security")) === "none",
    eyeBox: shown
      ? (await cdp.sendCommand("DOM.getBoxModel", { nodeId: eye.nodeId })).model.content
      : undefined,
  };
}

async function freshBox(tab, cdp) {
  await withTimeout(tab.loadURL(PAGE), "the page to load");
  await tab.executeJavaScript(`document.getElementById("box").focus()`);
  return boxState(cdp);
}

// As the account fills do: the value setter, then input and change events.
const scriptSets = (tab, value) =>
  tab.executeJavaScript(`(() => {
    const box = document.getElementById("box");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(box, ${JSON.stringify(value)});
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);

async function run() {
  const state = process.env[STATE_ENV];
  NodeAssert.ok(state, `Missing ${STATE_ENV}`);
  app.setPath("userData", state);
  app.dock?.hide();
  app.on("window-all-closed", () => {});
  await app.whenReady();

  const { BROWSER_TAB_BLINK_FEATURES } = await import("../src/scient/browser/passwordReveal.ts");

  const host = new BrowserWindow({
    show: false,
    width: 600,
    height: 200,
    webPreferences: { contextIsolation: true, sandbox: true, webviewTag: true },
  });
  host.webContents.on("will-attach-webview", (_event, webPreferences) => {
    webPreferences.sandbox = true;
    webPreferences.contextIsolation = true;
    webPreferences.enableBlinkFeatures = BROWSER_TAB_BLINK_FEATURES;
  });
  let phase = "attaching the tab";
  try {
    const attached = new Promise((resolve) =>
      host.webContents.once("did-attach-webview", (_event, guest) => resolve(guest)),
    );
    await host.loadURL(
      `data:text/html,${encodeURIComponent(
        '<!doctype html><webview partition="scient-password-reveal-smoke" src="about:blank" style="width:500px;height:150px"></webview>',
      )}`,
    );
    const tab = await withTimeout(attached, "the <webview> tab to attach");
    const cdp = tab.debugger;
    cdp.attach("1.3");
    await cdp.sendCommand("DOM.enable");
    await cdp.sendCommand("CSS.enable");

    phase = "an empty box";
    NodeAssert.deepEqual(await freshBox(tab, cdp), {
      eye: false,
      textShown: false,
      eyeBox: undefined,
    });
    phase = "what the person types";
    await tab.insertText("typed");
    const typed = await boxState(cdp);
    NodeAssert.equal(typed.eye, true, "no eye for a typed password");
    NodeAssert.equal(typed.textShown, false);

    phase = "clicking the eye";
    const [left, top, , , right, bottom] = typed.eyeBox;
    for (const type of ["mousePressed", "mouseReleased"])
      await cdp.sendCommand("Input.dispatchMouseEvent", {
        type,
        x: (left + right) / 2,
        y: (top + bottom) / 2,
        button: "left",
        clickCount: 1,
      });
    NodeAssert.equal((await boxState(cdp)).textShown, true, "the eye did not reveal the password");

    phase = "a fill into a revealed box";
    await scriptSets(tab, "filled");
    NodeAssert.deepEqual(await boxState(cdp), { eye: false, textShown: false, eyeBox: undefined });

    phase = "a filled box the person then types into";
    await freshBox(tab, cdp);
    await scriptSets(tab, "filled");
    await tab.insertText("more");
    NodeAssert.equal(
      await tab.executeJavaScript(`document.getElementById("box").value`),
      "filledmore",
    );
    NodeAssert.equal((await boxState(cdp)).eye, false, "a filled password got an eye");
    console.log("[scient-password-reveal-smoke] passed");
  } catch (error) {
    throw new Error(`Failed during ${phase}`, { cause: error });
  } finally {
    host.destroy();
  }
}

void run().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
