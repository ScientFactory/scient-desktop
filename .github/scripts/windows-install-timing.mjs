// Times a real Windows install and the installed app's first and second launch, per sample:
// install into a new folder, launch twice on a new profile, uninstall. Windows only.
// Usage: node windows-install-timing.mjs <installer.exe> <out-dir> [samples]
// Writes <out-dir>/measurement.json after every sample, and screenshots; exits 1 if any stage failed.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { median } from "./windows-install-timing-report.mjs";

// Normal stages take about 50 s to install, 15 s to ready and 10 s to uninstall.
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const READY_TIMEOUT_MS = 2 * 60_000;
const QUIT_TIMEOUT_MS = 30_000;
const FORCED_STOP_TIMEOUT_MS = 15_000;
const UNINSTALL_TIMEOUT_MS = 2 * 60_000;
const REMOVAL_TIMEOUT_MS = 2 * 60_000;
// Three samples normally take about 3 minutes; past this no new install or launch starts.
const MEASUREMENT_BUDGET_MS = 12 * 60_000;
const COMMAND_TIMEOUT_MS = 30_000;
const CDP_CONNECT_TIMEOUT_MS = 5_000;
const CDP_CALL_TIMEOUT_MS = 5_000;
const MAIN_INSPECTOR_PORT = 9229;
const POLL_MS = 100;

const [installerArg, outArg, samplesArg = "3"] = process.argv.slice(2);
// eslint-disable-next-line t3code/no-global-process-runtime -- Standalone target-host probe runs outside the Effect application runtime.
if (process.platform !== "win32") throw new Error("Run this on a Windows host");
if (!installerArg || !outArg) throw new Error("usage: <installer.exe> <out-dir> [samples]");
const samples = Number(samplesArg);
if (!Number.isInteger(samples) || samples < 1 || samples > 9) throw new Error("samples: 1-9");
const installer = NodePath.resolve(installerArg);
const outDir = NodePath.resolve(outArg);
NodeFS.mkdirSync(outDir, { recursive: true });

const now = () => performance.now();
const elapsed = (start) => Math.round(now() - start);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[${new Date().toISOString().slice(11, 23)}] ${message}`);
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const budgetEnd = now() + MEASUREMENT_BUDGET_MS;
/** A stage's bound, cut to what remains of the measurement budget; 0 when nothing remains. */
const budgeted = (ms) => Math.max(0, Math.min(ms, Math.floor(budgetEnd - now())));
const BUDGET_SPENT = `not run: the ${MEASUREMENT_BUDGET_MS / 60_000}-minute measurement budget ran out`;

/** Runs a program to completion or kills it at `timeoutMs`. */
function run(file, args, timeoutMs) {
  const result = NodeChildProcess.spawnSync(file, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  const timedOut = result.error?.code === "ETIMEDOUT";
  return {
    ok: !result.error && result.status === 0,
    timedOut,
    reason: timedOut
      ? `still running after ${seconds(timeoutMs)}`
      : (result.error?.message ?? `exit ${result.status}`),
  };
}

const powershell = (script) =>
  NodeChildProcess.execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  }).trim();

const sha256 = (file) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex").toLowerCase();

function sizeOf(dir) {
  let bytes = 0;
  let files = 0;
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    files += 1;
    bytes += NodeFS.statSync(NodePath.join(entry.parentPath, entry.name)).size;
  }
  return { bytes, files };
}

/** The app's own processes, everything running from its install folder; null when unknown. */
function appProcesses(installDir) {
  try {
    const out = powershell(
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress",
    );
    const rows = out ? JSON.parse(out) : [];
    const root = `${installDir.toLowerCase()}${NodePath.sep}`;
    return (Array.isArray(rows) ? rows : [rows])
      .filter((row) => (row.ExecutablePath ?? "").toLowerCase().startsWith(root))
      .map((row) => row.ProcessId);
  } catch {
    return null;
  }
}

const noAppProcesses = (installDir) => appProcesses(installDir)?.length === 0;

async function waitUntil(predicate, timeoutMs, intervalMs = 500) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return await predicate();
}

/** Force-stops every process from the install folder; true once none is left. */
async function stopAll(installDir) {
  for (const pid of appProcesses(installDir) ?? []) {
    run("taskkill.exe", ["/PID", String(pid), "/T", "/F"], COMMAND_TIMEOUT_MS);
  }
  return await waitUntil(() => noAppProcesses(installDir), FORCED_STOP_TIMEOUT_MS);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function json(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/** A DevTools session; the handshake and every call are bounded, and a closed one answers null. */
function connect(wsUrl) {
  return new Promise((resolve) => {
    const pending = new Map();
    let id = 0;
    let open = false;
    let socket;
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      resolve(null);
      return;
    }
    const handshake = setTimeout(() => {
      socket.close();
      resolve(null);
    }, CDP_CONNECT_TIMEOUT_MS);
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      const done = pending.get(message.id);
      if (done) {
        pending.delete(message.id);
        done(message.result ?? null);
      }
    };
    socket.onclose = () => {
      clearTimeout(handshake);
      open = false;
      for (const done of pending.values()) done(null);
      pending.clear();
      resolve(null);
    };
    socket.onerror = () => {};
    socket.onopen = () => {
      clearTimeout(handshake);
      open = true;
      resolve({
        get open() {
          return open;
        },
        send: (method, params = {}) =>
          new Promise((done) => {
            if (!open) return done(null);
            id += 1;
            const callId = id;
            const timer = setTimeout(() => {
              pending.delete(callId);
              done(null);
            }, CDP_CALL_TIMEOUT_MS);
            pending.set(callId, (result) => {
              clearTimeout(timer);
              done(result);
            });
            socket.send(JSON.stringify({ id: callId, method, params }));
          }),
        evaluate: async function (expression) {
          const reply = await this.send("Runtime.evaluate", { expression, returnByValue: true });
          return reply?.exceptionDetails ? null : (reply?.result?.value ?? null);
        },
        close: () => socket.close(),
      });
    };
  });
}

/**
 * Opens the app's main-process inspector, as Node's `inspect -p` does, to read its windows.
 * The main window is created hidden and shown once its renderer has painted; with background
 * throttling off until then, the page reports itself visible either way.
 */
async function inspectMain(pid, deadline, wanted) {
  let lastError = "it did not open";
  while (wanted() && now() < deadline) {
    try {
      process._debugProcess(pid);
      const targets = await json(`http://127.0.0.1:${MAIN_INSPECTOR_PORT}/json/list`);
      const target = targets?.find((candidate) => candidate.webSocketDebuggerUrl);
      if (target) {
        const session = await connect(target.webSocketDebuggerUrl);
        if (session && (await session.evaluate("process.pid")) === pid) return { session };
        session?.close();
        lastError = `port ${MAIN_INSPECTOR_PORT} answers for another process`;
      }
    } catch (error) {
      lastError = error.message;
    }
    await sleep(250);
  }
  return { error: `could not inspect the main process (${lastError})` };
}

// The new profile's expected view: onboarding's Getting started card, shown inside the app shell's
// main view. The root route renders the shell only after the bundled server answered its
// authentication gate; onboarding renders once the workspace snapshot and server config arrived.
// The chat loading view and an empty modal backdrop mount the same main element without it.
const PROBE = `(() => {
  const shown = (element) => {
    if (!element?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const main = document.querySelector('[data-slot="sidebar-wrapper"] main[data-slot="sidebar-inset"]');
  return {
    href: location.href,
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    shell: document.querySelector('[data-slot="sidebar-wrapper"]') !== null,
    view: shown(main?.querySelector('[data-scient-getting-started-card]')) && !document.body.inert,
  };
})()`;

const NATIVE_PROBE = `(() => {
  const { BrowserWindow } = process.getBuiltinModule("module").createRequire(process.execPath)("electron");
  return BrowserWindow.getAllWindows()
    .filter((window) => !window.isDestroyed())
    .map((window) => ({ url: window.webContents.getURL(), shown: window.isVisible() && !window.isMinimized() }));
})()`;

const site = (url) => {
  try {
    const { protocol, host } = new URL(url);
    return `${protocol}//${host}`;
  } catch {
    return url;
  }
};

async function quit(child, installDir) {
  const start = now();
  // Without /F, taskkill closes the app's windows as a person does; the app then quits.
  run("taskkill.exe", ["/PID", String(child.pid)], COMMAND_TIMEOUT_MS);
  if (await waitUntil(() => noAppProcesses(installDir), QUIT_TIMEOUT_MS)) {
    return { quitMs: elapsed(start), forcedQuit: false, stopped: true };
  }
  return { quitMs: null, forcedQuit: true, stopped: await stopAll(installDir) };
}

async function launch({ exe, installDir, profile, name }) {
  const readyTimeout = budgeted(READY_TIMEOUT_MS);
  if (readyTimeout === 0)
    return { readyMs: null, stopped: true, failure: `${name}: ${BUDGET_SPENT}` };
  if (!noAppProcesses(installDir)) {
    return { readyMs: null, stopped: false, failure: `${name}: app processes were still running` };
  }
  const port = await freePort();
  const env = { ...process.env, SCIENT_NEXT_HOME: profile.home, APPDATA: profile.appData };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ASAR;
  delete env.NODE_OPTIONS;
  const start = now();
  const child = NodeChildProcess.spawn(exe, [`--remote-debugging-port=${port}`], {
    env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const appExit = { code: null };
  child.once("error", () => {
    appExit.code ??= -1;
  });
  child.once("exit", (code) => {
    appExit.code ??= code ?? -1;
  });
  const marks = {};
  const mark = (key, label) => {
    if (marks[key] !== undefined) return;
    marks[key] = elapsed(start);
    log(`  ${name}: ${label} at ${seconds(marks[key])}`);
  };
  const deadline = start + readyTimeout;
  const sessions = new Map();
  let launching = true;
  let inspecting = null;
  let main = {};
  let readyPage = null;
  let stop = { quitMs: null, forcedQuit: false, stopped: false };
  let failure = null;
  try {
    while (readyPage === null && appExit.code === null && now() < deadline) {
      const targets = (await json(`http://127.0.0.1:${port}/json/list`)) ?? [];
      // Native window state, once the main process can be read.
      const windows = main.session ? ((await main.session.evaluate(NATIVE_PROBE)) ?? []) : [];
      for (const target of targets) {
        if (target.type !== "page" || target.url.startsWith("devtools")) continue;
        mark("windowMs", "first window");
        inspecting ??= inspectMain(child.pid, deadline, () => launching).then(
          (result) => (main = result),
        );
        let session = sessions.get(target.id);
        if (session === undefined || !session.open) {
          session = await connect(target.webSocketDebuggerUrl);
          if (session === null) continue;
          sessions.set(target.id, session);
        }
        const value = await session.evaluate(PROBE);
        if (!value) continue;
        // The connecting splash is a data: page; the main window serves the app's own origin.
        const shown = windows.some(
          (window) => window.shown && site(window.url) === site(value.href),
        );
        if (value.readyState === "complete") mark("pageLoadedMs", "page loaded");
        if (shown) mark("windowShownMs", "main window shown");
        if (value.shell) mark("appShellMs", "app shell");
        if (value.view) mark("viewMs", "Getting started view");
        if (value.view && shown && value.visibilityState === "visible") {
          mark("readyMs", "ready");
          readyPage = session;
          break;
        }
      }
      if (readyPage === null) await sleep(POLL_MS);
    }
    if (readyPage === null) {
      const seen = `window ${marks.windowShownMs === undefined ? "never shown" : "shown"}, view ${marks.viewMs === undefined ? "never shown" : "shown"}${main.error ? `; ${main.error}` : ""}`;
      failure =
        appExit.code !== null
          ? `${name}: the app exited (code ${appExit.code}) before it was ready (${seen})`
          : `${name}: the app was not ready within ${seconds(readyTimeout)} (${seen})`;
    }
    // What a person sees at readiness, or at the failure.
    const shotSession = readyPage ?? [...sessions.values()].find((session) => session.open);
    const shot = await shotSession?.send("Page.captureScreenshot", { format: "png" });
    if (shot?.data)
      NodeFS.writeFileSync(NodePath.join(outDir, `${name}.png`), Buffer.from(shot.data, "base64"));
  } catch (error) {
    failure = `${name}: ${error.message}`;
  } finally {
    launching = false;
    for (const session of sessions.values()) session.close();
    await inspecting;
    main.session?.close();
    stop = await quit(child, installDir);
    if (!stop.stopped) log(`  ${name}: app processes survived a forced stop`);
    else if (stop.forcedQuit)
      log(`  ${name}: did not quit within ${seconds(QUIT_TIMEOUT_MS)}; forced`);
    else log(`  ${name}: quit in ${seconds(stop.quitMs)}`);
  }
  if (failure === null && !stop.stopped) failure = `${name}: app processes survived a forced stop`;
  return { ...marks, readyMs: marks.readyMs ?? null, ...stop, failure };
}

/** Uninstalls and removes the install folder; the reasons it could not, if any. */
async function removeInstall(installDir) {
  const problems = [];
  if (!(await stopAll(installDir))) problems.push("app processes survived a forced stop");
  const uninstaller = NodePath.join(installDir, "Uninstall Scient.exe");
  if (NodeFS.existsSync(uninstaller)) {
    const result = run(uninstaller, ["/S"], UNINSTALL_TIMEOUT_MS);
    if (!result.ok) problems.push(`the uninstaller failed (${result.reason})`);
    // The uninstaller copies itself out and removes the folder in the background.
    else if (!(await waitUntil(() => !NodeFS.existsSync(installDir), REMOVAL_TIMEOUT_MS)))
      problems.push(
        `the install folder remained ${seconds(REMOVAL_TIMEOUT_MS)} after uninstalling`,
      );
  }
  try {
    NodeFS.rmSync(installDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (error) {
    problems.push(`the install folder could not be removed (${error.message})`);
  }
  return problems;
}

async function sample(index) {
  const name = `sample-${index}`;
  const installDir = NodePath.join(
    `${process.env.SystemDrive ?? "C:"}\\`,
    `scient-timing-${index}`,
  );
  const result = { index, installDir, installMs: null, failures: [] };
  const fail = (message) => {
    result.failures.push(`${name}: ${message}`);
    log(`${name}: ${message}`);
  };
  let profileRoot = null;
  try {
    NodeFS.rmSync(installDir, { recursive: true, force: true });
    const installTimeout = budgeted(INSTALL_TIMEOUT_MS);
    if (installTimeout === 0) {
      fail(BUDGET_SPENT);
      return result;
    }
    log(`${name}: installing into ${installDir}`);
    const start = now();
    const install = run(installer, ["/S", `/D=${installDir}`], installTimeout);
    const exe = NodePath.join(installDir, "Scient.exe");
    if (!install.ok || !NodeFS.existsSync(exe)) {
      fail(`the installer failed (${install.ok ? "no Scient.exe" : install.reason})`);
      return result;
    }
    result.installMs = elapsed(start);
    log(`${name}: installed in ${seconds(result.installMs)}`);
    result.installed = sizeOf(installDir);
    result.installedVersion = powershell(
      `(Get-Item -LiteralPath '${exe.replaceAll("'", "''")}').VersionInfo.ProductVersion`,
    );

    profileRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-timing-profile-"));
    const profile = {
      home: NodePath.join(profileRoot, "home"),
      appData: NodePath.join(profileRoot, "appdata"),
    };
    for (const launchName of ["first", "second"]) {
      const launched = await launch({ exe, installDir, profile, name: `${name}-${launchName}` });
      result[launchName] = launched;
      if (launched.failure) result.failures.push(launched.failure);
      // A second launch beside a surviving first one would time nothing real.
      if (!launched.stopped) break;
    }
  } catch (error) {
    fail(`stopped by an error (${error.message})`);
  } finally {
    const logs = profileRoot && NodePath.join(profileRoot, "home", "userdata", "logs");
    // The first sample's logs, and any failed sample's, show where the time went.
    if (logs && (index === 1 || result.failures.length > 0) && NodeFS.existsSync(logs)) {
      try {
        NodeFS.cpSync(logs, NodePath.join(outDir, `${name}-logs`), { recursive: true });
      } catch (error) {
        log(`${name}: could not keep the logs (${error.message})`);
      }
    }
    for (const problem of await removeInstall(installDir)) fail(problem);
    if (profileRoot) {
      try {
        NodeFS.rmSync(profileRoot, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 500,
        });
      } catch (error) {
        log(`${name}: could not remove the profile (${error.message})`);
      }
    }
  }
  return result;
}

const defenderRealtime = (() => {
  try {
    return powershell("(Get-MpComputerStatus).RealTimeProtectionEnabled") === "True";
  } catch {
    return null;
  }
})();
const measurement = {
  schemaVersion: 2,
  readiness:
    'the Getting started view visible in the app shell\'s main view ([data-scient-getting-started-card] in main[data-slot="sidebar-inset"]) and its native window shown',
  installer: {
    name: NodePath.basename(installer),
    bytes: NodeFS.statSync(installer).size,
    sha256: sha256(installer),
  },
  runner: {
    image: [process.env.ImageOS, process.env.ImageVersion].filter(Boolean).join(" ") || null,
    logicalCpus: NodeOS.cpus().length,
    memoryBytes: NodeOS.totalmem(),
    defenderRealtime,
  },
  bounds: {
    installMs: INSTALL_TIMEOUT_MS,
    readyMs: READY_TIMEOUT_MS,
    quitMs: QUIT_TIMEOUT_MS,
    uninstallMs: UNINSTALL_TIMEOUT_MS + REMOVAL_TIMEOUT_MS,
    measurementBudgetMs: MEASUREMENT_BUDGET_MS,
  },
  samples: [],
  errors: [],
};

/** Written after every sample, so a stopped job still leaves what it measured. */
function write() {
  const values = (pick) => measurement.samples.map(pick).filter((value) => Number.isFinite(value));
  measurement.installedVersion =
    measurement.samples.find((s) => s.installedVersion)?.installedVersion ?? null;
  measurement.median = {
    installMs: median(values((s) => s.installMs)),
    firstLaunchMs: median(values((s) => s.first?.readyMs)),
    secondLaunchMs: median(values((s) => s.second?.readyMs)),
  };
  measurement.failures = [...measurement.errors, ...measurement.samples.flatMap((s) => s.failures)];
  NodeFS.writeFileSync(
    NodePath.join(outDir, "measurement.json"),
    `${JSON.stringify(measurement, null, 2)}\n`,
  );
}

log(
  `Timing ${measurement.installer.name} (${(measurement.installer.bytes / 1e6).toFixed(0)} MB), ${samples} samples, ${measurement.runner.logicalCpus} CPUs, Defender real-time ${defenderRealtime}`,
);
try {
  write();
  for (let index = 1; index <= samples; index++) {
    measurement.samples.push(await sample(index));
    write();
  }
} catch (error) {
  measurement.errors.push(`the measurement stopped: ${error.message}`);
} finally {
  write();
  log(
    `Median install ${measurement.median.installMs} ms, first launch ${measurement.median.firstLaunchMs} ms, second launch ${measurement.median.secondLaunchMs} ms`,
  );
  for (const failure of measurement.failures) console.log(`::error::${failure}`);
  process.exitCode = measurement.failures.length > 0 ? 1 : 0;
}
