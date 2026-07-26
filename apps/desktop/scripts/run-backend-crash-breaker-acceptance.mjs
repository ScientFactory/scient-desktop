#!/usr/bin/env node
// Drives the isolated Electron crash-breaker fixture through macOS Accessibility.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const electronPath = require("electron");
const harnessPath = join(desktopRoot, "scripts", "backend-crash-breaker-acceptance-harness.mjs");

if (process.platform !== "darwin") {
  throw new Error("Native crash-breaker acceptance currently requires macOS Accessibility.");
}
if (!existsSync(electronPath)) {
  throw new Error(`Electron binary is missing at ${electronPath}. Run bun install first.`);
}

const AX_INSPECTION_SCRIPT = String.raw`
function attributeValue(element, name) {
  try { return element.attributes.byName(name).value(); } catch (_) { return null; }
}
function elementName(element) {
  try { return element.name(); } catch (_) { return null; }
}
function run(argv) {
  const pid = Number(argv[0]);
  const systemEvents = Application("System Events");
  const matches = systemEvents.applicationProcesses.whose({ unixId: pid })();
  if (matches.length !== 1) throw new Error("Expected one accessibility process for pid " + pid);
  const process = matches[0];
  const windows = process.windows();
  if (windows.length === 0) throw new Error("Acceptance process has no accessibility window.");
  const window = windows[0];
  const sheets = window.sheets();
  const root = sheets.length > 0 ? sheets[0] : window;
  const buttons = root.buttons().map((button) => ({
    title: elementName(button),
    role: attributeValue(button, "AXRole"),
    enabled: attributeValue(button, "AXEnabled"),
  }));
  const staticTexts = root.staticTexts().map((text) => elementName(text)).filter(Boolean);
  const defaultButton = attributeValue(root, "AXDefaultButton");
  const cancelButton = attributeValue(root, "AXCancelButton");
  const focusedElement = attributeValue(process, "AXFocusedUIElement");
  return JSON.stringify({
    processFrontmost: process.frontmost(),
    windowFocused: attributeValue(window, "AXFocused"),
    rootFocused: attributeValue(root, "AXFocused"),
    rootRole: attributeValue(root, "AXRole"),
    rootSubrole: attributeValue(root, "AXSubrole"),
    buttons,
    staticTexts,
    defaultButton: defaultButton ? elementName(defaultButton) : null,
    cancelButton: cancelButton ? elementName(cancelButton) : null,
    focusedElement: focusedElement ? {
      title: elementName(focusedElement),
      role: attributeValue(focusedElement, "AXRole"),
    } : null,
  });
}
`;

const AX_ACTION_SCRIPT = String.raw`
function run(argv) {
  const pid = Number(argv[0]);
  const action = argv[1];
  const systemEvents = Application("System Events");
  const process = systemEvents.applicationProcesses.whose({ unixId: pid })()[0];
  process.frontmost = true;
  if (action === "return") { systemEvents.keyCode(36); return; }
  if (action === "escape") { systemEvents.keyCode(53); return; }
  const window = process.windows()[0];
  const sheets = window.sheets();
  const root = sheets.length > 0 ? sheets[0] : window;
  const buttons = root.buttons.whose({ name: action })();
  if (buttons.length !== 1) throw new Error("Expected one button named " + action);
  buttons[0].actions.byName("AXPress").perform();
}
`;

function runAppleScript(script, ...args) {
  try {
    return execFileSync("osascript", ["-l", "JavaScript", "-e", script, ...args], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
  } catch (error) {
    const detail = `${error.stderr ?? ""}${error.stdout ?? ""}${error.message ?? ""}`;
    throw new Error(
      `macOS Accessibility could not inspect or control the native dialog. ` +
        `Grant Accessibility permission to the terminal/Codex host and retry.\n${detail}`,
      { cause: error },
    );
  }
}

function readState(root) {
  try {
    return JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
  } catch {
    return null;
  }
}

async function waitUntil(read, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value && predicate(value)) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("Timed out waiting for the native crash-breaker acceptance fixture.");
}

async function waitForAccessibleDialog(inspect, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const snapshot = inspect();
      if (
        snapshot.processFrontmost === true &&
        snapshot.focusedElement &&
        snapshot.buttons.length === 3 &&
        snapshot.defaultButton === "Try again"
      ) {
        return snapshot;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(
    `Timed out waiting for the native recovery dialog to become accessibility-ready.${
      lastError instanceof Error ? ` Last error: ${lastError.message}` : ""
    }`,
  );
}

async function waitForFixtureExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolveExit) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    child.once("exit", onExit);
  });
}

async function stopFixture(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForFixtureExit(child, 2_000)) return;
  child.kill("SIGKILL");
  if (!(await waitForFixtureExit(child, 2_000))) {
    throw new Error("Electron fixture did not terminate after SIGKILL.");
  }
}

function assertDialogAccessibility(snapshot, state) {
  const options = state.dialogOptions.at(-1);
  assert.equal(snapshot.processFrontmost, true);
  assert.ok(snapshot.focusedElement, JSON.stringify(snapshot));
  assert.ok(
    ["AXButton", "AXSheet", "AXWindow"].includes(snapshot.focusedElement.role),
    JSON.stringify(snapshot),
  );
  assert.ok(["AXSheet", "AXDialog", "AXWindow"].includes(snapshot.rootRole));
  assert.deepEqual(
    snapshot.buttons.map((button) => button.title).toSorted(),
    ["Keep Scient open", "Open logs", "Try again"].toSorted(),
  );
  assert.ok(
    snapshot.buttons.every((button) => button.role === "AXButton" && button.enabled === true),
  );
  assert.equal(snapshot.defaultButton, "Try again");
  assert.equal(snapshot.cancelButton, "Keep Scient open");
  const accessibleCopy = snapshot.staticTexts.join("\n");
  assert.match(accessibleCopy, /Automatic backend restarts are paused\./u);
  assert.match(accessibleCopy, /5 failures in 5 seconds/u);
  assert.match(accessibleCopy, /server-child\.log/u);
  assert.equal(options.title, "Scient backend stopped repeatedly");
  assert.equal(options.message, "Automatic backend restarts are paused.");
  assert.deepEqual(options.buttons, ["Try again", "Open logs", "Keep Scient open"]);
  assert.match(options.detail, /5 failures in 5 seconds/u);
  assert.match(options.detail, /server-child\.log/u);
  assert.equal(options.type, "error");
  assert.equal(options.defaultId, 0);
  assert.equal(options.cancelId, 2);
  assert.equal(options.noLink, true);
}

async function runScenario(scenario, drive) {
  const root = mkdtempSync(join(tmpdir(), `scient-crash-breaker-${scenario}-`));
  const stderr = [];
  const child = spawn(electronPath, [harnessPath, "--scenario", scenario, "--state-root", root], {
    cwd: desktopRoot,
    env: {
      PATH: process.env.PATH,
      TMPDIR: root,
      SCIENT_DISABLE_SHELL_ENV_SYNC: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  try {
    const dialogState = await waitUntil(
      () => readState(root),
      (state) => state.phase === "dialog-open" || state.phase === "complete",
    );
    const nativeProcessId = dialogState.processId;
    assert.ok(Number.isInteger(nativeProcessId) && nativeProcessId > 0);
    assert.equal(nativeProcessId, child.pid, "Electron fixture identity changed unexpectedly.");
    const inspectLive = () =>
      JSON.parse(runAppleScript(AX_INSPECTION_SCRIPT, String(nativeProcessId)));
    const initialSnapshot =
      dialogState.phase === "dialog-open" ? await waitForAccessibleDialog(inspectLive) : null;
    let initialSnapshotAvailable = initialSnapshot !== null;
    await drive({
      root,
      child,
      dialogState,
      inspect: () => {
        if (initialSnapshotAvailable) {
          initialSnapshotAvailable = false;
          return initialSnapshot;
        }
        return inspectLive();
      },
      act: (action) => runAppleScript(AX_ACTION_SCRIPT, String(nativeProcessId), action),
      signalShutdown: () => writeFileSync(join(root, "shutdown-requested"), "1\n"),
      waitForDialogCount: (dialogs) =>
        waitUntil(
          () => readState(root),
          (state) => state.dialogs >= dialogs,
        ),
    });
    const finalState = await waitUntil(
      () => readState(root),
      (state) => state.phase === "complete",
    );
    assert.equal(finalState.failure, undefined, finalState.failure);
    assert.equal(finalState.crashes, 5);
    assert.equal(finalState.breakerTrips, 1);
    await new Promise((resolveExit, rejectExit) => {
      const timeout = setTimeout(
        () => rejectExit(new Error("Electron fixture did not exit.")),
        5_000,
      );
      child.once("exit", () => {
        clearTimeout(timeout);
        resolveExit();
      });
    });
    return finalState;
  } catch (error) {
    await stopFixture(child);
    throw new Error(`${error.message}\nElectron stderr:\n${stderr.join("")}`, { cause: error });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

const evidence = {};

evidence.tryAgain = await runScenario("try-again", async ({ dialogState, inspect, act }) => {
  assert.equal(dialogState.childCount, 5);
  assert.equal(dialogState.desiredRunning, false);
  assertDialogAccessibility(inspect(), dialogState);
  act("return");
});
assert.equal(evidence.tryAgain.actions[0], "retry");
assert.equal(evidence.tryAgain.retryCalls, 1);
assert.equal(evidence.tryAgain.childCount, 6);
assert.equal(evidence.tryAgain.desiredRunning, true);

evidence.keepOpen = await runScenario("keep-open", async ({ dialogState, inspect, act }) => {
  assertDialogAccessibility(inspect(), dialogState);
  act("escape");
});
assert.equal(evidence.keepOpen.actions[0], "dismiss");
assert.equal(evidence.keepOpen.retryCalls, 0);
assert.equal(evidence.keepOpen.desiredRunning, false);

for (const scenario of ["open-logs-success", "open-logs-failure"]) {
  evidence[scenario] = await runScenario(
    scenario,
    async ({ dialogState, inspect, act, waitForDialogCount }) => {
      assertDialogAccessibility(inspect(), dialogState);
      act("Open logs");
      const reopened = await waitForDialogCount(2);
      const reopenedSnapshot = await waitForAccessibleDialog(inspect);
      assertDialogAccessibility(reopenedSnapshot, reopened);
      if (scenario === "open-logs-failure") {
        assert.equal(reopened.openLogsErrors.length, 1);
        assert.match(
          reopened.dialogOptions.at(-1).detail,
          /Scient could not open the logs folder:/u,
        );
      }
      act("escape");
    },
  );
  assert.equal(evidence[scenario].openLogsCalls, 1);
  assert.deepEqual(evidence[scenario].actions, ["open-logs", "dismiss"]);
  assert.equal(evidence[scenario].dialogs, 2);
}

for (const scenario of ["quit-while-open", "update-while-open"]) {
  evidence[scenario] = await runScenario(
    scenario,
    async ({ dialogState, inspect, act, signalShutdown }) => {
      assertDialogAccessibility(inspect(), dialogState);
      signalShutdown();
      act("return");
    },
  );
  assert.equal(evidence[scenario].actions[0], "retry");
  assert.equal(evidence[scenario].retryCalls, 0);
  assert.equal(evidence[scenario].childCount, 5);
  assert.equal(evidence[scenario].desiredRunning, false);
}

for (const scenario of ["quit-before-limit", "update-before-limit"]) {
  evidence[scenario] = await runScenario(scenario, async ({ dialogState }) => {
    assert.equal(dialogState.phase, "complete");
    assert.equal(dialogState.dialogs, 0);
  });
  assert.equal(evidence[scenario].suppressed, true);
  assert.equal(evidence[scenario].desiredRunning, false);
}

process.stdout.write(
  `${JSON.stringify(
    Object.fromEntries(
      Object.entries(evidence).map(([scenario, state]) => [
        scenario,
        {
          crashes: state.crashes,
          breakerTrips: state.breakerTrips,
          dialogs: state.dialogs,
          actions: state.actions,
          retryCalls: state.retryCalls,
          openLogsCalls: state.openLogsCalls,
          openLogsErrors: state.openLogsErrors.length,
          childCount: state.childCount,
          desiredRunning: state.desiredRunning,
          suppressed: state.suppressed,
        },
      ]),
    ),
    null,
    2,
  )}\n`,
);
