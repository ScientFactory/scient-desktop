// Times a real Windows install and the first launches of the installed app.
// Usage: node windows-install-timing.mjs <installer.exe> <out-dir> <label>
// Writes <out-dir>/<label>.json and screenshots. Run on a Windows runner only.
import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

const [installer, outDir, label] = process.argv.slice(2);
if (!installer || !outDir || !label) throw new Error("usage: <installer> <out-dir> <label>");
FS.mkdirSync(outDir, { recursive: true });
const result = { label, installer: Path.basename(installer), steps: {} };
const now = () => performance.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ms = (start) => Math.round(now() - start);

const run = (command, args) =>
  ChildProcess.spawnSync(command, args, { encoding: "utf8", windowsHide: true });

// Install silently, per user, as a person double-clicking would get it.
{
  const start = now();
  const install = run(installer, ["/S"]);
  result.steps.installMs = ms(start);
  result.steps.installExit = install.status;
}
const installDir = Path.join(process.env.LOCALAPPDATA, "Programs", "Scient");
const exe = Path.join(installDir, "Scient.exe");
if (!FS.existsSync(exe)) throw new Error(`Installed app missing at ${exe}`);
const sizeOf = (dir) => {
  let bytes = 0;
  let files = 0;
  for (const entry of FS.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      files += 1;
      bytes += FS.statSync(Path.join(entry.parentPath, entry.name)).size;
    }
  }
  return { bytes, files };
};
result.installed = sizeOf(installDir);

const kill = () => run("taskkill.exe", ["/IM", "Scient.exe", "/F", "/T"]);

const json = async (url) => {
  try {
    const response = await fetch(url);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
};

/** One CDP session on the page target, for evaluate and screenshot. */
const connect = (wsUrl) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const callback = pending.get(message.id);
      if (callback) {
        pending.delete(message.id);
        callback(message);
      }
    };
    socket.onerror = () => reject(new Error("CDP socket error"));
    socket.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((done) => {
            id += 1;
            pending.set(id, done);
            socket.send(JSON.stringify({ id, method, params }));
          }),
        close: () => socket.close(),
      });
  });

const PROBE = `(() => ({
  href: location.href,
  readyState: document.readyState,
  shell: !!document.querySelector('[data-slot="sidebar-wrapper"]'),
  composer: !!document.querySelector('[data-slot="composer-shell"]'),
  textLength: (document.body?.innerText ?? "").trim().length,
  text: (document.body?.innerText ?? "").trim().slice(0, 300),
}))()`;

const launch = async (name, profile) => {
  const port = 9333;
  const env = { ...process.env, SCIENT_NEXT_HOME: profile.home, APPDATA: profile.appData };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const start = now();
  const child = ChildProcess.spawn(exe, [`--remote-debugging-port=${port}`], {
    env,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  const marks = {};
  const mark = (key) => {
    if (marks[key] === undefined) marks[key] = ms(start);
  };
  let last = null;
  let session = null;
  const deadline = start + 240_000;
  while (now() < deadline) {
    if ((await json(`http://127.0.0.1:${port}/json/version`)) !== null) mark("debuggerMs");
    const targets = (await json(`http://127.0.0.1:${port}/json/list`)) ?? [];
    const page = targets.find((target) => target.type === "page" && !target.url.startsWith("devtools"));
    if (page) {
      mark("windowMs");
      if (session === null) session = await connect(page.webSocketDebuggerUrl).catch(() => null);
      if (session !== null) {
        const reply = await session.send("Runtime.evaluate", { expression: PROBE, returnByValue: true });
        const value = reply.result?.result?.value;
        if (value) {
          last = value;
          if (value.readyState === "complete") mark("pageLoadedMs");
          if (value.textLength > 20) mark("firstContentMs");
          if (value.shell) mark("appShellMs");
          if (value.composer) {
            mark("composerMs");
            break;
          }
        }
      }
    }
    await sleep(100);
  }
  // Settle so the screenshot shows what a person sees after readiness.
  await sleep(1500);
  if (session !== null) {
    const shot = await session.send("Page.captureScreenshot", { format: "png" });
    if (shot.result?.data) {
      FS.writeFileSync(Path.join(outDir, `${label}-${name}.png`), Buffer.from(shot.result.data, "base64"));
    }
    const reply = await session.send("Runtime.evaluate", { expression: PROBE, returnByValue: true });
    last = reply.result?.result?.value ?? last;
    session.close();
  }
  kill();
  await sleep(3000);
  return { ...marks, timedOut: marks.composerMs === undefined, last };
};

const profileRoot = FS.mkdtempSync(Path.join(OS.tmpdir(), "scient-timing-"));
const profile = {
  home: Path.join(profileRoot, "home"),
  appData: Path.join(profileRoot, "appdata"),
};
result.launches = {};
result.launches.first = await launch("first", profile);
result.launches.second = await launch("second", profile);
result.launches.third = await launch("third", profile);

// Logs from the profile, for the timeline of the first launch.
const logs = Path.join(profile.home, "userdata", "logs");
if (FS.existsSync(logs)) FS.cpSync(logs, Path.join(outDir, `${label}-logs`), { recursive: true });

FS.writeFileSync(Path.join(outDir, `${label}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
