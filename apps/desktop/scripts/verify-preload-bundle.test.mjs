import { assert, describe, it } from "vite-plus/test";

import { verifyPreloadBundle, verifyConversationReviewPreload } from "./verify-preload-bundle.mjs";

const validReview = `
const {ipcRenderer} = require("electron");
window.addEventListener("DOMContentLoaded", () => {
  for (const action of ["cancel", "continue"]) document.getElementById(action).addEventListener("click", () => ipcRenderer.send("scient:conversation-review-action", action));
  const read = document.getElementById("read");
  read.addEventListener("toggle", () => ipcRenderer.send("scient:conversation-review-action", read instanceof HTMLDetailsElement && read.open ? "expand" : "collapse"));
  document.addEventListener("keydown", event => { if(event.key === "Escape") ipcRenderer.send("scient:conversation-review-action", "cancel"); });
});`;

describe("conversation review preload verifier", () => {
  it("checks executable actions in the built isolated preload", () =>
    assert.doesNotThrow(() => verifyConversationReviewPreload(validReview)));
  it("requires the read toggle actions", () =>
    assert.throws(
      () =>
        verifyConversationReviewPreload(
          validReview.replace(/  const read = .*\n  read.addEventListener\(.*\n/, ""),
        ),
      /missing read toggle/,
    ));
  it("rejects file access and bridge exposure", () => {
    assert.throws(
      () => verifyConversationReviewPreload('require("node:fs");'),
      /only Electron IPC/,
    );
    assert.throws(
      () =>
        verifyConversationReviewPreload(
          'require("electron").contextBridge.exposeInMainWorld("desktopBridge", {});',
        ),
      /exposed a bridge/,
    );
  });
  it("rejects an unexpected action channel", () =>
    assert.throws(
      () =>
        verifyConversationReviewPreload(
          validReview.replaceAll("scient:conversation-review-action", "unrelated"),
        ),
      /unexpected actions/,
    ));
});

const validPreload = `
  const electron = require("electron");
  const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
  electron.contextBridge.exposeInMainWorld("__clerk_internal_electron_passkeys", {});
  electron.contextBridge.exposeInMainWorld("desktopBridge", {
    getClientPlatform: () => process.platform,
    getLocalEnvironmentBootstraps: () => [],
    getPathForFile: () => "",
    pickFolder: (options) => electron.ipcRenderer.invoke(PICK_FOLDER_CHANNEL, options),
  });
`;

describe("desktop preload bundle verifier", () => {
  it("executes macOS window-control inset setup in its DOM sandbox", () => {
    assert.doesNotThrow(() =>
      verifyPreloadBundle(`${validPreload}
      window.addEventListener("DOMContentLoaded", () => document.documentElement.style.setProperty("--inset", String(electron.webFrame.getZoomFactor())));
    `),
    );
  });
  it("rejects required API names that only appear in strings", () => {
    assert.throws(
      () =>
        verifyPreloadBundle(`
          "desktopBridge getClientPlatform getLocalEnvironmentBootstraps pickFolder";
          "__clerk_internal_electron_passkeys";
          require("electron");
        `),
      /missing executable APIs/,
    );
  });

  it("rejects a required API whose exposed value is not callable", () => {
    assert.throws(
      () =>
        verifyPreloadBundle(
          validPreload.replace(
            "getClientPlatform: () => process.platform,",
            "getClientPlatform: undefined,",
          ),
        ),
      /missing executable APIs: getClientPlatform/,
    );
  });

  it("accepts a required API exposed through a function alias", () => {
    assert.doesNotThrow(() =>
      verifyPreloadBundle(`
        const readClientPlatform = () => process.platform;
        ${validPreload.replace(
          "getClientPlatform: () => process.platform,",
          "getClientPlatform: readClientPlatform,",
        )}
      `),
    );
  });

  it("rejects dynamic imports with comments before the opening parenthesis", () => {
    assert.throws(
      () =>
        verifyPreloadBundle(`${validPreload}\nimport /* @vite-ignore */("unsupported-module");`),
      /dynamic import\(\)/,
    );
  });

  it("ignores import-like text in strings", () => {
    assert.doesNotThrow(() =>
      verifyPreloadBundle(`${validPreload}\nconst message = 'import /* comment */("module")';`),
    );
  });

  it("rejects unsupported require calls with comments before the opening parenthesis", () => {
    assert.throws(
      () => verifyPreloadBundle(`${validPreload}\nrequire /* @__PURE__ */ ("node:fs");`),
      /unsupported sandbox imports: node:fs/,
    );
  });

  it("rejects unsupported optional require calls", () => {
    assert.throws(
      () => verifyPreloadBundle(`${validPreload}\nrequire?.("node:fs");`),
      /unsupported sandbox imports: node:fs/,
    );
  });

  it("accepts Electron sandbox module aliases", () => {
    assert.doesNotThrow(() =>
      verifyPreloadBundle(`
        ${validPreload}
        require("electron/common");
        require("electron/renderer");
        require("node:events");
        require("node:timers");
        require("node:url");
      `),
    );
  });

  it("ignores require-like text in strings and comments", () => {
    assert.doesNotThrow(() =>
      verifyPreloadBundle(`
        ${validPreload}
        const message = 'require("node:fs")';
        // require("node:path")
      `),
    );
  });
});
