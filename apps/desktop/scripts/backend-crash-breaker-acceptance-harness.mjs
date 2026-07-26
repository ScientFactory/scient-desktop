#!/usr/bin/env electron
// Isolated native acceptance fixture for the desktop backend crash breaker.

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { app, BrowserWindow, dialog, shell } from "electron";

import {
  buildBackendRestartRecoveryDialog,
  handleBackendRestartRecoveryAction,
  shouldShowBackendRestartRecovery,
  showBackendRestartRecoveryDialog,
} from "../src/backendRestartRecovery.ts";
import { DesktopBackendSupervisor } from "../src/desktopBackendSupervisor.ts";
import { openDesktopLogsDirectory } from "../src/desktopDiagnostics.ts";

function readArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

const scenario = readArgument("--scenario");
const stateRoot = readArgument("--state-root");
const statePath = join(stateRoot, "state.json");
const shutdownSignalPath = join(stateRoot, "shutdown-requested");
const logsDirectory = join(stateRoot, "logs");
const missingLogsDirectory = join(stateRoot, "missing-logs");
mkdirSync(logsDirectory, { recursive: true });
writeFileSync(join(logsDirectory, "server-child.log"), "isolated acceptance fixture\n");

app.setName("Scient Crash Breaker Acceptance");
app.setPath("userData", join(stateRoot, "electron-user-data"));
app.disableHardwareAcceleration();

const result = {
  scenario,
  phase: "starting",
  processId: process.pid,
  childCount: 0,
  crashes: 0,
  breakerTrips: 0,
  dialogs: 0,
  dialogOptions: [],
  actions: [],
  retryCalls: 0,
  openLogsCalls: 0,
  openLogsErrors: [],
  suppressed: false,
  desiredRunning: false,
};

function publish(patch = {}) {
  Object.assign(result, patch);
  writeFileSync(statePath, `${JSON.stringify(result, null, 2)}\n`);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(10);
  }
  throw new Error("Timed out waiting for the isolated backend lifecycle.");
}

class AcceptanceBackendChild extends EventEmitter {
  connected = true;
  exitCode = null;
  signalCode = null;

  constructor(pid) {
    super();
    this.pid = pid;
  }

  send(_message, callback) {
    callback?.(null);
    return true;
  }

  crash() {
    this.exitCode = 1;
    this.emit("exit", 1, null);
  }
}

let mainWindow = null;
let supervisor = null;
let finishing = false;
let initialShutdownRequested = ["quit-before-limit", "update-before-limit"].includes(scenario);

function shutdownRequested() {
  return initialShutdownRequested || existsSync(shutdownSignalPath);
}

function finish(patch = {}) {
  if (finishing) return;
  finishing = true;
  publish({
    ...patch,
    phase: "complete",
    childCount: result.childCount,
    desiredRunning: supervisor?.desiredRunning ?? false,
  });
  setTimeout(() => app.quit(), 50);
}

async function showRecovery(input) {
  if (!shouldShowBackendRestartRecovery(shutdownRequested())) {
    result.suppressed = true;
    finish();
    return;
  }
  const logFilePath = join(logsDirectory, "server-child.log");
  const options = buildBackendRestartRecoveryDialog({
    appName: "Scient",
    failures: input.failures,
    windowMs: input.windowMs,
    logFilePath,
    ...(input.openLogsErrorMessage ? { openLogsErrorMessage: input.openLogsErrorMessage } : {}),
  });
  result.dialogs += 1;
  result.dialogOptions.push(options);
  publish({ phase: "dialog-open" });

  const action = await showBackendRestartRecoveryDialog({
    owner: mainWindow,
    options,
    focusOwner: (window) => {
      app.show();
      app.focus({ steal: true });
      window.show();
      window.focus();
    },
    showOwned: (window, dialogOptions) => dialog.showMessageBox(window, dialogOptions),
    showUnowned: (dialogOptions) => dialog.showMessageBox(dialogOptions),
  });
  result.actions.push(action);
  let reopened = false;
  let openLogsErrorMessage = null;
  await handleBackendRestartRecoveryAction({
    action,
    isQuitting: shutdownRequested,
    retry: () => {
      result.retryCalls += 1;
      void supervisor.start();
    },
    openLogs: async () => {
      result.openLogsCalls += 1;
      const target = scenario === "open-logs-failure" ? missingLogsDirectory : logsDirectory;
      await openDesktopLogsDirectory(target, (path) => shell.openPath(path));
    },
    onOpenLogsError: (error) => {
      openLogsErrorMessage = error instanceof Error ? error.message : String(error);
      result.openLogsErrors.push(openLogsErrorMessage);
    },
    reopen: () => {
      reopened = true;
      void showRecovery({ ...input, openLogsErrorMessage });
    },
  });

  if (!reopened) {
    await wait(50);
    finish();
  }
}

async function runCrashSequence() {
  const children = [];
  supervisor = new DesktopBackendSupervisor({
    prepareStart: async () => undefined,
    spawn: () => {
      const child = new AcceptanceBackendChild(20_000 + children.length);
      children.push(child);
      result.childCount = children.length;
      publish();
      return child;
    },
    requestGracefulShutdown: async () => true,
    forceTerminateTree: async () => undefined,
    restartBaseDelayMs: 20,
    restartMaxDelayMs: 20,
    restartFailureWindowMs: 5_000,
    restartMaxFailures: 5,
    restartStabilityThresholdMs: 5_000,
    onRestartLimitReached: ({ failures, windowMs }) => {
      result.breakerTrips += 1;
      publish({
        phase: shouldShowBackendRestartRecovery(shutdownRequested())
          ? "breaker-paused"
          : "breaker-suppressed",
      });
      void showRecovery({ failures, windowMs }).catch((error) => {
        finish({ failure: error instanceof Error ? error.stack : String(error) });
      });
    },
    onError: () => undefined,
  });
  await supervisor.start();

  for (let crash = 1; crash <= 5; crash += 1) {
    const child = children.at(-1);
    if (!child) throw new Error(`Backend generation ${crash} was not created.`);
    child.crash();
    result.crashes = crash;
    publish();
    if (crash < 5) {
      await waitUntil(() => children.length === crash + 1);
    }
  }
}

app.whenReady().then(async () => {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 420,
    show: false,
    title: "Scient Crash Breaker Acceptance",
    webPreferences: { sandbox: true },
  });
  await mainWindow.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(
        "<!doctype html><html><body><main><h1>Scient crash-breaker acceptance</h1><p>Isolated native-dialog fixture.</p></main></body></html>",
      ),
  );
  mainWindow.show();
  mainWindow.focus();
  publish({ phase: "window-ready" });
  await runCrashSequence();
});

app.on("window-all-closed", () => {
  if (!finishing) finish({ failure: "Acceptance owner window closed unexpectedly." });
});

process.on("uncaughtException", (error) => {
  finish({ failure: error.stack ?? error.message });
});

process.on("unhandledRejection", (error) => {
  finish({ failure: error instanceof Error ? error.stack : String(error) });
});
