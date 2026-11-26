// Times a real Windows install and the installed app's first and second launch, per sample:
// install into a new folder, launch twice on a new profile, uninstall. Windows only.
// Usage: node windows-install-timing.mjs <installer.exe> <out-dir> [samples]
// Writes <out-dir>/measurement.json and screenshots; exits 1 if any stage failed.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { median } from "./windows-install-timing-report.mjs";

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const READY_TIMEOUT_MS = 3 * 60_000;
const QUIT_TIMEOUT_MS = 30_000;
const UNINSTALL_TIMEOUT_MS = 5 * 60_000;
const CDP_CALL_TIMEOUT_MS = 5_000;
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

const powershell = (script) =>
  NodeChildProcess.execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
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

/** The app's own processes: everything running from its install folder. */
function appProcesses(installDir) {
  const out = powershell(
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress",
  );
  const rows = out ? JSON.parse(out) : [];
  const root = `${installDir.toLowerCase()}${NodePath.sep}`;
  return (Array.isArray(rows) ? rows : [rows])
    .filter((row) => (row.ExecutablePath ?? "").toLowerCase().startsWith(root))
    .map((row) => row.ProcessId);
}

async function waitUntil(predicate, timeoutMs, intervalMs = 500) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return await predicate();
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

/** A DevTools session on one page; every call is bounded, and a closed page answers null. */
function connect(wsUrl) {
  return new Promise((resolve) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    let open = false;
    const settleAll = () => {
      for (const done of pending.values()) done(null);
      pending.clear();
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      const done = pending.get(message.id);
      if (done) {
        pending.delete(message.id);
        done(message.result ?? null);
      }
    };
    socket.onclose = () => {
      open = false;
      settleAll();
      resolve(null);
    };
    socket.onerror = () => {};
    socket.onopen = () => {
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
        close: () => socket.close(),
      });
    };
  });
}

// Ready: the renderer mounted the app shell, which the root route renders only after the
// bundled server answered its authentication gate.
const PROBE = `(() => ({
  href: location.href,
  readyState: document.readyState,
  shell: document.querySelector('[data-slot="sidebar-wrapper"]') !== null,
}))()`;

async function quit(child, installDir) {
  const start = now();
  // Without /F, taskkill closes the app's windows as a person does; the app then quits.
  NodeChildProcess.spawnSync("taskkill.exe", ["/PID", String(child.pid)], { windowsHide: true });
  const quitCleanly = await waitUntil(() => appProcesses(installDir).length === 0, QUIT_TIMEOUT_MS);
  if (quitCleanly) return { quitMs: elapsed(start), forcedQuit: false };
  for (const pid of appProcesses(installDir)) {
    NodeChildProcess.spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
    });
  }
  await waitUntil(() => appProcesses(installDir).length === 0, 10_000);
  return { quitMs: null, forcedQuit: true };
}

async function launch({ exe, installDir, profile, name }) {
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
  child.once("exit", (code) => {
    appExit.code = code ?? -1;
  });
  const marks = {};
  const mark = (key, label) => {
    if (marks[key] !== undefined) return;
    marks[key] = elapsed(start);
    log(`  ${name}: ${label} at ${seconds(marks[key])}`);
  };
  const sessions = new Map();
  let readyPage = null;
  const deadline = start + READY_TIMEOUT_MS;
  while (readyPage === null && appExit.code === null && now() < deadline) {
    const targets = (await json(`http://127.0.0.1:${port}/json/list`)) ?? [];
    for (const target of targets) {
      if (target.type !== "page" || target.url.startsWith("devtools")) continue;
      mark("windowMs", "first window");
      let session = sessions.get(target.id);
      if (session === undefined || !session.open) {
        session = await connect(target.webSocketDebuggerUrl);
        if (session === null) continue;
        sessions.set(target.id, session);
      }
      const reply = await session.send("Runtime.evaluate", {
        expression: PROBE,
        returnByValue: true,
      });
      const value = reply?.result?.value;
      if (!value) continue;
      if (value.readyState === "complete") mark("pageLoadedMs", "page loaded");
      if (value.shell) {
        mark("readyMs", "app shell ready");
        readyPage = session;
        break;
      }
    }
    if (readyPage === null) await sleep(POLL_MS);
  }
  const failure =
    readyPage !== null
      ? null
      : appExit.code !== null
        ? `${name}: the app exited (code ${appExit.code}) before its app shell was ready`
        : `${name}: the app shell was not ready within ${seconds(READY_TIMEOUT_MS)}`;
  // What a person sees at readiness, or at the failure.
  const shotSession = readyPage ?? [...sessions.values()].find((session) => session.open);
  const shot = await shotSession?.send("Page.captureScreenshot", { format: "png" });
  if (shot?.data)
    NodeFS.writeFileSync(NodePath.join(outDir, `${name}.png`), Buffer.from(shot.data, "base64"));
  for (const session of sessions.values()) session.close();
  const stop = await quit(child, installDir);
  if (stop.forcedQuit) log(`  ${name}: did not quit within ${seconds(QUIT_TIMEOUT_MS)}; forced`);
  else log(`  ${name}: quit in ${seconds(stop.quitMs)}`);
  return { ...marks, readyMs: marks.readyMs ?? null, ...stop, failure };
}

async function uninstall(installDir) {
  const uninstaller = NodePath.join(installDir, "Uninstall Scient.exe");
  if (!NodeFS.existsSync(uninstaller)) return "no uninstaller";
  const result = NodeChildProcess.spawnSync(uninstaller, ["/S"], {
    timeout: UNINSTALL_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.status !== 0) return `uninstaller exited ${result.status ?? result.error?.message}`;
  // The uninstaller copies itself out and removes the folder in the background.
  const gone = await waitUntil(() => !NodeFS.existsSync(installDir), 2 * 60_000);
  return gone ? null : "the install folder remained after uninstalling";
}

async function sample(index) {
  const name = `sample-${index}`;
  const installDir = NodePath.join(
    `${process.env.SystemDrive ?? "C:"}\\`,
    `scient-timing-${index}`,
  );
  NodeFS.rmSync(installDir, { recursive: true, force: true });
  const result = { index, installDir, failures: [] };
  log(`${name}: installing into ${installDir}`);
  const start = now();
  const install = NodeChildProcess.spawnSync(installer, ["/S", `/D=${installDir}`], {
    timeout: INSTALL_TIMEOUT_MS,
    windowsHide: true,
  });
  result.installMs = elapsed(start);
  const exe = NodePath.join(installDir, "Scient.exe");
  if (install.status !== 0 || !NodeFS.existsSync(exe)) {
    const reason = install.error?.message ?? `exit ${install.status}`;
    result.installMs = null;
    result.failures.push(`${name}: the installer failed (${reason})`);
    log(`${name}: install failed (${reason})`);
    return result;
  }
  log(`${name}: installed in ${seconds(result.installMs)}`);
  result.installed = sizeOf(installDir);
  result.installedVersion = powershell(
    `(Get-Item -LiteralPath '${exe.replaceAll("'", "''")}').VersionInfo.ProductVersion`,
  );

  const profileRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-timing-profile-"));
  const profile = {
    home: NodePath.join(profileRoot, "home"),
    appData: NodePath.join(profileRoot, "appdata"),
  };
  for (const launchName of ["first", "second"]) {
    const launched = await launch({ exe, installDir, profile, name: `${name}-${launchName}` });
    result[launchName] = launched;
    if (launched.failure) result.failures.push(launched.failure);
  }
  // The first sample's logs show where a slow launch spent its time.
  const logs = NodePath.join(profile.home, "userdata", "logs");
  if (index === 1 && NodeFS.existsSync(logs)) {
    NodeFS.cpSync(logs, NodePath.join(outDir, `${name}-logs`), { recursive: true });
  }
  const uninstallFailure = await uninstall(installDir);
  if (uninstallFailure) result.failures.push(`${name}: ${uninstallFailure}`);
  NodeFS.rmSync(profileRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
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
  schemaVersion: 1,
  readiness: 'app shell mounted ([data-slot="sidebar-wrapper"]) after the server auth gate',
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
  samples: [],
};
log(
  `Timing ${measurement.installer.name} (${(measurement.installer.bytes / 1e6).toFixed(0)} MB), ${samples} samples, ${measurement.runner.logicalCpus} CPUs, Defender real-time ${defenderRealtime}`,
);
for (let index = 1; index <= samples; index++) measurement.samples.push(await sample(index));

const values = (pick) => measurement.samples.map(pick).filter((value) => Number.isFinite(value));
measurement.installedVersion = measurement.samples.find(
  (s) => s.installedVersion,
)?.installedVersion;
measurement.median = {
  installMs: median(values((s) => s.installMs)),
  firstLaunchMs: median(values((s) => s.first?.readyMs)),
  secondLaunchMs: median(values((s) => s.second?.readyMs)),
};
measurement.failures = measurement.samples.flatMap((s) => s.failures);
NodeFS.writeFileSync(
  NodePath.join(outDir, "measurement.json"),
  `${JSON.stringify(measurement, null, 2)}\n`,
);
log(
  `Median install ${measurement.median.installMs} ms, first launch ${measurement.median.firstLaunchMs} ms, second launch ${measurement.median.secondLaunchMs} ms`,
);
for (const failure of measurement.failures) console.log(`::error::${failure}`);
process.exitCode = measurement.failures.length > 0 ? 1 : 0;
