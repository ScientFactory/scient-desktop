import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttps from "node:https";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const TIMEOUT = 300_000;
// One external command or shutdown step; a hang fails at that step, not at the job's timeout.
const STEP_TIMEOUT = 60_000;
// Windows builds are unsigned until Trusted Signing has a certificate profile. "optional" accepts an
// unsigned installer (such a build pins no publisher, so updates are not signature-checked) but
// never a damaged signature; it is recorded in the receipt.
let windowsSignature = "required";
let windowsInstallerSignature = "authenticode";
const platformManifest = {
  darwin: "latest-mac.yml",
  win32: "latest.yml",
  linux: "latest-linux.yml",
};
const policyPaths = {
  darwin: "/Library/Application Support/Scient/policy.json",
  win32: "C:\\Program Files\\Scient\\policy.json",
  linux: "/etc/scient/policy.json",
};

export function timingEvents(text) {
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    for (const event of record.events ?? []) {
      const fields = event.attributes;
      if (
        event.name === "restart timing" &&
        fields?.component === "desktop-restart" &&
        typeof fields.event === "string"
      ) {
        events.push({
          ...fields,
          ...(typeof event.timeUnixNano === "string"
            ? { atMs: Number(BigInt(event.timeUnixNano) / 1_000_000n) }
            : {}),
        });
      }
    }
  }
  return events;
}

export function qualifyTiming(events, fromVersion, targetVersion) {
  const confirmed = events.filter(
    (event) =>
      event.event === "confirmed" &&
      event.fromVersion === fromVersion &&
      event.targetVersion === targetVersion,
  );
  NodeAssert.equal(confirmed.length, 1, "Exactly one matching restart confirmation is required");
  const attempt = events.filter((event) => event.attemptId === confirmed[0].attemptId);
  NodeAssert.ok(
    attempt.every(
      (event) => event.fromVersion === fromVersion && event.targetVersion === targetVersion,
    ),
    "An attempt cannot change version identity",
  );
  NodeAssert.equal(
    attempt.some((event) => event.event === "abandoned"),
    false,
    "Restart attempt was abandoned",
  );
  const named = (name) => {
    const found = attempt.filter((event) => event.event === name);
    NodeAssert.equal(found.length, 1, `Exactly one ${name} receipt is required`);
    return found[0];
  };
  const shutdown = named("shutdown-started");
  const handoff = named("native-handoff");
  const launched = named("launched");
  const backend = named("backend-ready");
  const ready = named("workspace-ready");
  const settled = named("workspace-settled");
  NodeAssert.ok(Number.isFinite(shutdown.elapsedMs) && shutdown.elapsedMs >= 0);
  NodeAssert.ok(Number.isFinite(handoff.elapsedMs) && handoff.elapsedMs >= shutdown.elapsedMs);
  for (const event of [launched, backend, ready, settled]) {
    NodeAssert.equal(
      event.launchId,
      launched.launchId,
      "Readiness must belong to the updated launch",
    );
    NodeAssert.equal(
      event.processId,
      launched.processId,
      "Readiness must belong to the updated process",
    );
  }
  NodeAssert.equal(typeof launched.launchId, "string");
  NodeAssert.ok(Number.isSafeInteger(launched.processId) && launched.processId > 0);
  NodeAssert.equal(ready.projectRestored, true, "A selected project must really be restored");
  // The natively relaunched process itself showed the project and took input, at readiness and
  // once settled; a lock its restart left behind would be gone by the harness's next launch.
  for (const event of [ready, settled])
    for (const field of ["projectControlsVisible", "composerUsable", "windowUnlocked"])
      NodeAssert.equal(event[field], true, `The relaunched app's ${event.event} needs ${field}`);
  for (const [field, value] of Object.entries({
    confirmToLaunchMs: launched.confirmToLaunchMs,
    handoffToLaunchMs: launched.handoffToLaunchMs,
    launchToBackendMs: backend.launchToBackendMs,
    confirmToReadyMs: ready.confirmToReadyMs,
    launchToReadyMs: ready.launchToReadyMs,
  }))
    NodeAssert.ok(Number.isFinite(value) && value >= 0, `Missing or invalid ${field}`);
  NodeAssert.ok(
    Number.isFinite(settled.settledAfterReadyMs) && settled.settledAfterReadyMs >= 0,
    "Missing or invalid settledAfterReadyMs",
  );
  NodeAssert.ok(
    ready.launchToReadyMs >= backend.launchToBackendMs,
    "Workspace readiness preceded its backend",
  );
  return {
    attemptId: confirmed[0].attemptId,
    processId: launched.processId,
    preparationAndSaveMs: shutdown.elapsedMs,
    shutdownMs: handoff.elapsedMs - shutdown.elapsedMs,
    handoffToLaunchMs: launched.handoffToLaunchMs,
    launchToBackendMs: backend.launchToBackendMs,
    launchToReadyMs: ready.launchToReadyMs,
    confirmToReadyMs: ready.confirmToReadyMs,
    settledAfterReadyMs: settled.settledAfterReadyMs,
  };
}

function digestFile(filename, algorithm, encoding) {
  const hash = NodeCrypto.createHash(algorithm);
  const fd = NodeFS.openSync(filename, "r");
  const chunk = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    let count;
    while ((count = NodeFS.readSync(fd, chunk)) > 0) hash.update(chunk.subarray(0, count));
  } finally {
    NodeFS.closeSync(fd);
  }
  return hash.digest(encoding);
}

export function verifyHandoff(directory, expectedCommit) {
  NodeAssert.match(expectedCommit, /^[0-9a-f]{40}$/);
  const handoff = JSON.parse(
    NodeFS.readFileSync(NodePath.join(directory, "scient-release-handoff.json"), "utf8"),
  );
  NodeAssert.equal(handoff.schemaVersion, 1);
  NodeAssert.equal(handoff.product, "Scient");
  NodeAssert.equal(handoff.source.repository, "ScientFactory/scient-desktop");
  NodeAssert.equal(
    handoff.source.commit,
    expectedCommit,
    "Artifact does not belong to the requested source commit",
  );
  NodeAssert.deepEqual(
    NodeFS.readdirSync(directory)
      .filter((name) => !["scient-release-handoff.json", "SHA256SUMS.txt"].includes(name))
      .sort(),
    handoff.assets.map((asset) => asset.name).sort(),
    "Candidate contains unsealed or missing assets",
  );
  for (const asset of handoff.assets) {
    NodeAssert.equal(
      NodePath.basename(asset.name),
      asset.name,
      "Artifact names cannot escape their immutable candidate",
    );
    const filename = NodePath.join(directory, asset.name);
    NodeAssert.ok(NodeFS.lstatSync(filename).isFile(), "An artifact must be a file, not a symlink");
    NodeAssert.equal(NodeFS.statSync(filename).size, asset.size);
    NodeAssert.equal(
      digestFile(filename, "sha256", "hex"),
      asset.sha256,
      `Changed candidate asset: ${asset.name}`,
    );
  }
  return handoff;
}

export function payload(directory, platform, arch) {
  const manifest = parseYaml(
    NodeFS.readFileSync(NodePath.join(directory, platformManifest[platform]), "utf8"),
  );
  NodeAssert.equal(typeof manifest.version, "string");
  const extension = { darwin: ".zip", win32: ".exe", linux: ".AppImage" }[platform];
  const artifactArch = platform === "linux" && arch === "x64" ? "x86_64" : arch;
  const file = manifest.files.find(
    (entry) => entry.url.endsWith(extension) && entry.url.includes(`-${artifactArch}`),
  );
  NodeAssert.ok(file, `Manifest has no ${platform}/${arch} ${extension} payload`);
  NodeAssert.equal(
    NodePath.basename(file.url),
    file.url,
    "Qualification feeds must contain local filenames, not external URLs",
  );
  const filename = NodePath.join(directory, file.url);
  NodeAssert.equal(
    NodeFS.statSync(filename).size,
    file.size,
    "Payload size must match the immutable manifest",
  );
  NodeAssert.equal(
    digestFile(filename, "sha512", "base64"),
    file.sha512,
    "Payload hash must match the immutable manifest",
  );
  return { filename, manifest, file };
}

function userDataPath(platform) {
  return platform === "darwin"
    ? NodePath.join(NodeOS.homedir(), "Library", "Application Support", "scient-next")
    : platform === "win32"
      ? NodePath.join(process.env.APPDATA, "scient-next")
      : NodePath.join(
          process.env.XDG_CONFIG_HOME ?? NodePath.join(NodeOS.homedir(), ".config"),
          "scient-next",
        );
}

function requireDisposableRunner() {
  NodeAssert.equal(
    process.env.GITHUB_ACTIONS,
    "true",
    "Native qualification runs only on disposable GitHub-hosted runners",
  );
  NodeAssert.ok(process.env.RUNNER_TEMP && NodePath.isAbsolute(process.env.RUNNER_TEMP));
  NodeAssert.ok(process.env.ImageOS, "Self-hosted machines are not disposable qualification hosts");
  const baseDir = NodePath.join(NodeOS.homedir(), ".scient-next");
  const userData = userDataPath(HostProcess.Platform.defaultValue());
  NodeAssert.equal(
    NodeFS.existsSync(baseDir),
    false,
    "Refusing to read or reuse an existing Scient profile",
  );
  NodeAssert.equal(
    NodeFS.existsSync(userData),
    false,
    "Refusing to read or reuse existing Electron user data",
  );
  for (const key of [
    "SCIENT_NEXT_HOME",
    "T3CODE_HOME",
    "VITE_DEV_SERVER_URL",
    "NODE_OPTIONS",
    "ELECTRON_RUN_AS_NODE",
  ])
    NodeAssert.ok(
      !process.env[key],
      `Remove ambient ${key}; the native relaunch must use the same default synthetic profile`,
    );
  return { baseDir, userData };
}

function verifySignature(filename, platform) {
  if (platform === "darwin") {
    NodeChildProcess.execFileSync("codesign", ["--verify", "--deep", "--strict", filename], {
      stdio: "pipe",
    });
    NodeChildProcess.execFileSync("spctl", ["--assess", "--type", "execute", filename], {
      stdio: "pipe",
    });
    NodeChildProcess.execFileSync("xcrun", ["stapler", "validate", filename], { stdio: "pipe" });
  } else if (platform === "win32") {
    const escaped = filename.replaceAll("'", "''");
    const status = NodeChildProcess.execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status`],
      { stdio: "pipe", encoding: "utf8" },
    ).trim();
    if (status === "Valid") return;
    NodeAssert.ok(
      status === "NotSigned" && windowsSignature === "optional",
      `Installer signature is not valid (${status})`,
    );
    windowsInstallerSignature = "unsigned";
  }
}

function installSource(source, directory, platform) {
  NodeFS.mkdirSync(directory, { recursive: true });
  if (platform === "darwin") {
    NodeChildProcess.execFileSync("ditto", ["-x", "-k", source, directory], { stdio: "pipe" });
    const bundle = NodeFS.readdirSync(directory).find((name) => name.endsWith(".app"));
    NodeAssert.ok(bundle, "Source archive has no application bundle");
    const app = NodePath.join(directory, bundle);
    verifySignature(app, platform);
    return NodePath.join(app, "Contents", "MacOS", "Scient");
  }
  if (platform === "win32") {
    verifySignature(source, platform);
    NodeChildProcess.execFileSync(source, ["/S", `/D=${directory}`], {
      stdio: "pipe",
      timeout: TIMEOUT,
    });
    return NodePath.join(directory, "Scient.exe");
  }
  const executable = NodePath.join(directory, "Scient.AppImage");
  NodeFS.copyFileSync(source, executable);
  NodeFS.chmodSync(executable, 0o755);
  return executable;
}

function invalidSignatureFixture(target, root) {
  const unpacked = NodePath.join(root, "invalid-signature");
  NodeFS.mkdirSync(unpacked);
  NodeChildProcess.execFileSync("ditto", ["-x", "-k", target.filename, unpacked], {
    stdio: "pipe",
  });
  const bundle = NodeFS.readdirSync(unpacked).find((name) => name.endsWith(".app"));
  NodeAssert.ok(bundle);
  NodeFS.appendFileSync(NodePath.join(unpacked, bundle, "Contents", "Info.plist"), "\n");
  const zip = NodePath.join(root, "invalid-signature.zip");
  NodeChildProcess.execFileSync(
    "ditto",
    ["-c", "-k", "--sequesterRsrc", "--keepParent", NodePath.join(unpacked, bundle), zip],
    { stdio: "pipe" },
  );
  const size = NodeFS.statSync(zip).size;
  const sha512 = digestFile(zip, "sha512", "base64");
  const manifest = structuredClone(target.manifest);
  Object.assign(
    manifest.files.find((entry) => entry.url === target.file.url),
    { size, sha512 },
  );
  if (manifest.path === target.file.url) manifest.sha512 = sha512;
  return new Map([
    [target.file.url, zip],
    // Quoted, as electron-builder writes it: electron-updater's YAML 1.1 reader would turn an
    // unquoted releaseDate into a Date, which the app's feed schema rejects.
    ["latest-mac.yml", Buffer.from(stringifyYaml(manifest, { defaultStringType: "QUOTE_SINGLE" }))],
  ]);
}

function serveFeed(root, port, corrupt, overrides, tlsDir) {
  const tls = {
    cert: NodeFS.readFileSync(NodePath.join(tlsDir, "feed-cert.pem")),
    key: NodeFS.readFileSync(NodePath.join(tlsDir, "feed-key.pem")),
  };
  const server = NodeHttps.createServer(tls, (request, response) => {
    const name = new URL(request.url, "http://127.0.0.1").pathname.slice(1);
    if (name !== NodePath.basename(name) || !name || name.includes("%") || name.includes("\\")) {
      response.writeHead(404).end();
      return;
    }
    const override = overrides.get(name);
    if (Buffer.isBuffer(override)) {
      response.writeHead(200, { "Content-Length": override.length, "Cache-Control": "no-store" });
      response.end(override);
      return;
    }
    const filename = override ?? NodePath.join(root, name);
    if (!NodeFS.existsSync(filename) || !NodeFS.lstatSync(filename).isFile()) {
      response.writeHead(404).end();
      return;
    }
    const size = NodeFS.statSync(filename).size;
    response.writeHead(200, { "Content-Length": size, "Cache-Control": "no-store" });
    if (corrupt.value && /\.(zip|exe|AppImage)$/.test(name) && size > 0) {
      const fd = NodeFS.openSync(filename, "r");
      const byte = Buffer.alloc(1);
      try {
        NodeFS.readSync(fd, byte);
      } finally {
        NodeFS.closeSync(fd);
      }
      byte[0] ^= 0xff;
      response.write(byte);
      NodeFS.createReadStream(filename, { start: 1 })
        .on("error", () => response.destroy())
        .pipe(response);
    } else
      NodeFS.createReadStream(filename)
        .on("error", () => response.destroy())
        .pipe(response);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function waitForTrace(filename, predicate, signal, timeout = TIMEOUT) {
  return new Promise((resolve, reject) => {
    const directory = NodePath.dirname(filename);
    NodeFS.mkdirSync(directory, { recursive: true });
    const watcher = NodeFS.watch(directory, inspect);
    const deadline = setTimeout(
      () => finish(new Error("Timed out waiting for a native restart receipt")),
      timeout,
    );
    const abort = () => finish(new Error("Native receipt observation cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    function finish(error, result) {
      clearTimeout(deadline);
      watcher.close();
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result);
    }
    function inspect() {
      try {
        const events = timingEvents(
          NodeFS.existsSync(filename) ? NodeFS.readFileSync(filename, "utf8") : "",
        );
        if (predicate(events)) finish(undefined, events);
      } catch (error) {
        finish(error);
      }
    }
    inspect();
  });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function waitForFileText(filename, pattern, timeout = TIMEOUT) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (NodeFS.existsSync(filename) && pattern.test(NodeFS.readFileSync(filename, "utf8"))) return;
    NodeAssert.ok(Date.now() < deadline, `Timed out waiting for ${pattern} in ${filename}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// Polls from Node: waitForFunction does not await an async predicate, so its promise passed at once.
async function waitForUpdateState(page, predicate, timeout = TIMEOUT) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const state = await page.evaluate(() => window.desktopBridge.getUpdateState());
    if (predicate(state)) return state;
    const { status, errorContext, availableVersion, downloadedVersion } = state;
    NodeAssert.ok(
      Date.now() < deadline,
      `Timed out waiting for an update state; last ${JSON.stringify({ status, errorContext, availableVersion, downloadedVersion })}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// A normal quit (as from the menu), not a kill: the app that quits here is relaunched afterwards.
function quitOwnedUpdatedProcess(pid, executable, platform) {
  let actual;
  if (platform === "win32") {
    actual = NodeChildProcess.execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ExecutablePath`,
      ],
      { encoding: "utf8", timeout: STEP_TIMEOUT },
    ).trim();
  } else if (platform === "darwin") {
    actual = NodeChildProcess.execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf8",
      timeout: STEP_TIMEOUT,
    }).trim();
  } else {
    const environment = NodeFS.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    const appImage = environment.find((entry) => entry.startsWith("APPIMAGE="))?.slice(9);
    const exe = NodeFS.readlinkSync(`/proc/${pid}/exe`);
    // A relaunched AppImage can run from its FUSE mount or, under APPIMAGE_EXTRACT_AND_RUN, its
    // extracted copy, without APPIMAGE; requireSingleMain already tied this PID to the trace the
    // synthetic profile recorded, so such a copy is the owner.
    const appImageCopy = /\/(\.mount_[^/]+|appimage_extracted_[0-9a-f]+)\//.test(exe);
    NodeAssert.ok(
      appImage === undefined
        ? appImageCopy
        : NodeFS.realpathSync(appImage) === NodeFS.realpathSync(executable),
      `Updated PID is not this qualification AppImage (APPIMAGE=${appImage ?? "unset"}, exe=${exe})`,
    );
    actual = executable;
  }
  NodeAssert.equal(
    NodePath.resolve(actual).toLowerCase(),
    NodePath.resolve(executable).toLowerCase(),
    "Refusing to stop a PID not owned by the installed qualification app",
  );
  // Without /F, taskkill asks the windows to close; the app then quits as it does for any window close.
  if (platform === "win32")
    NodeChildProcess.execFileSync("taskkill", ["/PID", String(pid)], {
      stdio: "pipe",
      timeout: STEP_TIMEOUT,
    });
  else process.kill(pid, "SIGTERM");
}

// /proc/<pid>/stat is "pid (comm) state ppid …"; comm may itself contain ") ".
function linuxParentOf(child) {
  try {
    const stat = NodeFS.readFileSync(`/proc/${child}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[1]);
  } catch {
    return 0;
  }
}

// The app's own children (its backend runs the app's executable as Node) are not another main.
function descendsFrom(candidate, ancestor, parentOf) {
  for (let current = candidate, depth = 0; current > 1 && depth < 64; depth++) {
    current = parentOf(current);
    if (current === ancestor) return true;
  }
  return false;
}

// Every instance of the app counts, whichever AppImage mount or extraction it runs from;
// Chromium's helper processes carry --type=.
export function linuxMainCandidates(processes, executableName) {
  return processes
    .filter(
      (entry) =>
        NodePath.posix.basename(entry.exe) === executableName && !entry.command.includes("--type="),
    )
    .map(({ pid, command }) => ({ pid, command }));
}

function requireSingleMain(pid, executable, platform) {
  let candidates;
  let parentOf;
  if (platform === "win32") {
    const rows = JSON.parse(
      NodeChildProcess.execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
        ],
        { encoding: "utf8", timeout: STEP_TIMEOUT },
      ),
    );
    const parents = new Map(rows.map((row) => [row.ProcessId, row.ParentProcessId]));
    parentOf = (child) => parents.get(child) ?? 0;
    candidates = rows
      .filter(
        (row) =>
          row.ExecutablePath?.toLowerCase() === executable.toLowerCase() &&
          !row.CommandLine?.includes("--type="),
      )
      .map((row) => ({ pid: row.ProcessId, command: row.CommandLine }));
  } else if (platform === "darwin") {
    const rows = NodeChildProcess.execFileSync("ps", ["-axo", "pid=,ppid=,comm="], {
      encoding: "utf8",
      timeout: STEP_TIMEOUT,
    })
      .split("\n")
      .map((row) => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(row))
      .filter((row) => row !== null)
      .map((row) => ({ pid: Number(row[1]), ppid: Number(row[2]), command: row[3] }));
    const parents = new Map(rows.map((row) => [row.pid, row.ppid]));
    parentOf = (child) => parents.get(child) ?? 0;
    candidates = rows.filter((row) => row.command === executable);
  } else {
    parentOf = linuxParentOf;
    candidates = linuxMainCandidates(
      NodeFS.readdirSync("/proc")
        .filter((name) => /^\d+$/.test(name))
        .flatMap((name) => {
          try {
            return [
              {
                pid: Number(name),
                exe: NodeFS.readlinkSync(`/proc/${name}/exe`),
                command: NodeFS.readFileSync(`/proc/${name}/cmdline`, "utf8").replaceAll("\0", " "),
              },
            ];
          } catch {
            return [];
          }
        }),
      NodePath.posix.basename(NodeFS.readlinkSync(`/proc/${pid}/exe`)),
    );
  }
  const mains = candidates.filter((candidate) => !descendsFrom(candidate.pid, pid, parentOf));
  if (mains.length !== 1 || mains[0].pid !== pid)
    console.error(
      "Main-process candidates:",
      mains.map((candidate) => ({ ...candidate, parent: parentOf(candidate.pid) })),
    );
  NodeAssert.deepEqual(
    mains.map((candidate) => candidate.pid),
    [pid],
    "Exactly one updated main process must be running",
  );
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll(check, message, timeout = TIMEOUT) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    NodeAssert.ok(Date.now() < deadline, message);
    await delay(250);
  }
}

// Packaged builds ignore the Node inspector switches, so the harness drives the installed app's
// renderer over Chromium's DevTools endpoint, which Electron announces on stderr.
export function devToolsEndpoint(output) {
  const match =
    /^DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)(\/devtools\/browser\/[\w-]+))\s*$/m.exec(
      output,
    );
  return match ? { url: match[1], port: Number(match[2]), path: match[3] } : undefined;
}

// Chromium writes the endpoint into the user data directory it actually uses.
export function devToolsActivePort(text) {
  const [port, path] = text.split(/\r?\n/);
  return /^\d+$/.test(port) && /^\/devtools\/browser\/[\w-]+$/.test(path ?? "")
    ? { port: Number(port), path }
    : undefined;
}

export function browserProcessId(processInfo) {
  const browsers = processInfo.filter((entry) => entry.type === "browser");
  NodeAssert.equal(browsers.length, 1, "DevTools must report exactly one browser process");
  NodeAssert.ok(Number.isSafeInteger(browsers[0].id) && browsers[0].id > 0);
  return browsers[0].id;
}

async function waitForExit(pid, timeout) {
  const deadline = Date.now() + timeout;
  while (processAlive(pid) && Date.now() < deadline) await delay(250);
  return !processAlive(pid);
}

// Rejects with `message` if `promise` has not settled in time; the timer never outlives the race.
async function deadline(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Browser.close quits through the app's own before-quit and shutdown; a kill skips both.
export function requireGracefulQuit(output, exit) {
  NodeAssert.deepEqual(
    exit,
    { code: 0, signal: null },
    `The app must exit normally when asked to quit, not ${JSON.stringify(exit)}`,
  );
  NodeAssert.match(output, /\bbefore-quit received\b/, "The app's own quit path must run");
  NodeAssert.doesNotMatch(
    output,
    /exiting before shutdown completed/,
    "The app must finish its shutdown before it exits",
  );
}

// Ownership comes first: a DevTools endpoint answering for a process this harness did not start
// is only disconnected (closing a browser reached over CDP closes just the connection).
export async function attachOwnedBrowser({ connect, spawnedPid, platform, parentOf }) {
  const browser = await connect();
  try {
    const session = await browser.newBrowserCDPSession();
    const pid = browserProcessId((await session.send("SystemInfo.getProcessInfo")).processInfo);
    await session.detach();
    // An AppImage runtime may start the Electron main process as its own child.
    NodeAssert.ok(
      pid === spawnedPid || (platform === "linux" && descendsFrom(pid, spawnedPid, parentOf)),
      `DevTools answered for process ${pid}, which this harness did not start (${spawnedPid})`,
    );
    return { browser, pid };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

export async function launchInstalled({ executable, env, userData, platform, log, connect }) {
  const activePort = NodePath.join(userData, "DevToolsActivePort");
  NodeFS.rmSync(activePort, { force: true });
  const child = NodeChildProcess.spawn(executable, ["--remote-debugging-port=0"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let failure;
  let exit;
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      resolve();
    }),
  );
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.once("error", (error) => (failure = error));
  const collect = (chunk) => {
    output += chunk;
    NodeFS.appendFileSync(log, chunk);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const running = () => failure === undefined && exit === undefined;
  let owned;
  // An ordinary quit, as the app menu's Quit, and only of the app this harness owns; never a kill.
  const quit = async () => {
    NodeAssert.ok(owned && running(), "Only a running app this harness started can be quit");
    const session = await owned.browser.newBrowserCDPSession();
    // The reply may not outlive the app.
    void session.send("Browser.close").catch(() => {});
    await deadline(exited, 60_000, "The app did not quit when asked");
    NodeAssert.ok(await waitForExit(owned.pid, 30_000), "The app's main process outlived its quit");
    // Its last output may still be in the pipe; a surviving grandchild may hold it open.
    await deadline(closed, 10_000, "").catch(() => {});
    await owned.browser.close().catch(() => {});
    requireGracefulQuit(output, exit);
  };
  // Cleanup after a failure; it may force the exit, so it is never a scenario's quit.
  const stop = async () => {
    const session =
      owned && running()
        ? await owned.browser.newBrowserCDPSession().catch(() => undefined)
        : undefined;
    if (session) {
      void session.send("Browser.close").catch(() => {});
      await deadline(exited, 30_000, "").catch(() => {});
    }
    if (running()) {
      child.kill("SIGKILL");
      await deadline(exited, STEP_TIMEOUT, "").catch(() => {});
    }
    if (owned && !(await waitForExit(owned.pid, 10_000))) process.kill(owned.pid, "SIGKILL");
    await owned?.browser.close().catch(() => {});
  };
  try {
    const endpoint = await poll(() => {
      NodeAssert.ok(running(), `The app exited before its DevTools endpoint opened:\n${output}`);
      return devToolsEndpoint(output);
    }, "Timed out waiting for the app's DevTools endpoint");
    // The native relaunch passes no switches, so it can find the same profile only by default.
    await poll(
      () => {
        const written = NodeFS.existsSync(activePort)
          ? devToolsActivePort(NodeFS.readFileSync(activePort, "utf8"))
          : undefined;
        return written?.port === endpoint.port && written.path === endpoint.path;
      },
      `The app did not use the synthetic Electron user data at ${userData}`,
      30_000,
    );
    owned = await attachOwnedBrowser({
      connect:
        connect ??
        (async () =>
          (await import("playwright-core")).chromium.connectOverCDP(endpoint.url, {
            timeout: TIMEOUT,
          })),
      spawnedPid: child.pid,
      platform,
      parentOf: linuxParentOf,
    });
    console.log(`Launched ${executable}: started process ${child.pid}, main process ${owned.pid}`);
    const page = await poll(async () => {
      for (const candidate of owned.browser.contexts().flatMap((context) => context.pages()))
        if (
          await candidate
            .evaluate(() => typeof window.desktopBridge?.checkForUpdate === "function")
            .catch(() => false)
        )
          return candidate;
    }, "The app opened no Scient window");
    return { pid: owned.pid, page, quit, stop };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}

async function appVersion(page) {
  return (await page.evaluate(() => window.desktopBridge.getUpdateState())).currentVersion;
}

async function requireRestoredWorkspace(page, projectName) {
  await poll(
    () =>
      page.evaluate((name) => {
        const visible = (element) =>
          element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        return (
          [...document.querySelectorAll("button, a, span")].some(
            (element) => element.textContent.trim() === name && visible(element),
          ) &&
          [...document.querySelectorAll('[contenteditable="true"]')].some(visible) &&
          !document.body.inert
        );
      }, projectName),
    "The relaunched app must show the restored project's controls and accept input",
  );
}

// The workflow installs the encoder Playwright pins; its own recorder needs a launched browser.
function ffmpegExecutable(platform) {
  const require = NodeModule.createRequire(import.meta.url);
  const browsers = JSON.parse(
    NodeFS.readFileSync(
      NodePath.join(
        NodePath.dirname(require.resolve("playwright-core/package.json")),
        "browsers.json",
      ),
      "utf8",
    ),
  );
  const { revision } = browsers.browsers.find((entry) => entry.name === "ffmpeg");
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    NodePath.join(
      platform === "darwin"
        ? NodePath.join(NodeOS.homedir(), "Library", "Caches")
        : platform === "win32"
          ? process.env.LOCALAPPDATA
          : (process.env.XDG_CACHE_HOME ?? NodePath.join(NodeOS.homedir(), ".cache")),
      "ms-playwright",
    );
  const filename = NodePath.join(
    cache,
    `ffmpeg-${revision}`,
    { darwin: "ffmpeg-mac", linux: "ffmpeg-linux", win32: "ffmpeg-win64.exe" }[platform],
  );
  NodeAssert.ok(NodeFS.existsSync(filename), `Playwright's video encoder is missing: ${filename}`);
  return filename;
}

// Chromium sends a screencast frame only when the window changes; each frame is held until the
// next one so the video keeps real time.
async function recordWindow(page, filename, platform) {
  const fps = 10;
  const encoder = NodeChildProcess.spawn(
    ffmpegExecutable(platform),
    [
      "-loglevel",
      "error",
      "-f",
      "image2pipe",
      "-framerate",
      String(fps),
      "-c:v",
      "mjpeg",
      "-i",
      "pipe:0",
      "-y",
      "-an",
      "-c:v",
      "libvpx-vp9",
      "-deadline",
      "realtime",
      "-speed",
      "8",
      "-crf",
      "32",
      "-b:v",
      "0",
      "-vf",
      "pad=1280:800:0:0:gray,crop=1280:800:0:0",
      filename,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let errors = "";
  encoder.stderr.on("data", (chunk) => (errors += chunk));
  encoder.stdin.on("error", () => {});
  const finished = new Promise((resolve) => {
    encoder.once("exit", resolve);
    encoder.once("error", (error) => resolve(error.message));
  });
  let last;
  let frames = 0;
  const write = (frame, count) => {
    for (let index = 0; index < count; index++) encoder.stdin.write(frame.data);
    frames += count;
  };
  await page.screencast.start({
    size: { width: 1280, height: 800 },
    onFrame: (frame) => {
      if (last)
        write(last, Math.max(1, Math.round(((frame.timestamp - last.timestamp) * fps) / 1000)));
      last = frame;
    },
  });
  return async () => {
    // After a native restart the page is gone and stopping fails; only a hang is an error here.
    await deadline(
      page.screencast.stop().catch(() => {}),
      STEP_TIMEOUT,
      "Stopping the window screencast hung",
    );
    if (last) write(last, fps);
    encoder.stdin.end();
    const status = await deadline(
      finished,
      STEP_TIMEOUT,
      `The video encoder did not finish: ${errors}`,
    ).catch((error) => {
      encoder.kill("SIGKILL");
      throw error;
    });
    NodeAssert.equal(status, 0, `Recording the window failed: ${errors}`);
    return frames;
  };
}

export function largestWindow(windows) {
  const shown = windows.filter((window) => window.width > 0 && window.height > 0);
  NodeAssert.ok(shown.length > 0, "The relaunched app shows no window");
  return shown.reduce((largest, window) =>
    window.width * window.height > largest.width * largest.height ? window : largest,
  );
}

const windowsCapture = `Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class ScientWindows {
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  delegate bool EnumProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  public static string List(uint pid) {
    SetProcessDPIAware();
    var rows = new List<string>();
    EnumWindows((window, parameter) => {
      uint owner; Rect rect;
      GetWindowThreadProcessId(window, out owner);
      if (owner == pid && IsWindowVisible(window) && GetWindowRect(window, out rect))
        rows.Add("{\\"id\\":" + window.ToInt64() + ",\\"width\\":" + (rect.Right - rect.Left) + ",\\"height\\":" + (rect.Bottom - rect.Top) + "}");
      return true;
    }, IntPtr.Zero);
    return "[" + string.Join(",", rows) + "]";
  }
  public static void Capture(long id, string path) {
    SetProcessDPIAware();
    var window = new IntPtr(id); Rect rect;
    if (!GetWindowRect(window, out rect)) throw new Exception("GetWindowRect failed");
    using (var bitmap = new Bitmap(rect.Right - rect.Left, rect.Bottom - rect.Top)) {
      using (var graphics = Graphics.FromImage(bitmap)) {
        var hdc = graphics.GetHdc();
        // PW_RENDERFULLCONTENT: Chromium draws with DirectComposition, which plain PrintWindow misses.
        try { if (!PrintWindow(window, hdc, 2)) throw new Exception("PrintWindow failed"); }
        finally { graphics.ReleaseHdc(hdc); }
      }
      bitmap.Save(path, ImageFormat.Png);
    }
  }
}
'@`;

function powershell(script) {
  return NodeChildProcess.execFileSync(
    "powershell.exe",
    ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", timeout: STEP_TIMEOUT },
  ).trim();
}

const macWindows = `ObjC.import("CoreGraphics");
function run(argv) {
  const pid = Number(argv[0]);
  const list = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
  return JSON.stringify(ObjC.deepUnwrap(ObjC.castRefToObject(list))
    .filter((window) => window.kCGWindowOwnerPID === pid && window.kCGWindowLayer === 0)
    .map((window) => ({ id: window.kCGWindowNumber, width: window.kCGWindowBounds.Width, height: window.kCGWindowBounds.Height })));
}`;

// The natively relaunched app has no DevTools endpoint, so its own window is captured by the OS.
function captureWindow(pid, filename, platform) {
  if (platform === "darwin") {
    const window = largestWindow(
      JSON.parse(
        NodeChildProcess.execFileSync(
          "osascript",
          ["-l", "JavaScript", "-e", macWindows, String(pid)],
          { encoding: "utf8", timeout: STEP_TIMEOUT },
        ),
      ),
    );
    NodeChildProcess.execFileSync("screencapture", ["-x", "-o", `-l${window.id}`, filename], {
      stdio: "pipe",
      timeout: STEP_TIMEOUT,
    });
  } else if (platform === "win32") {
    const window = largestWindow(
      JSON.parse(powershell(`${windowsCapture}\n[ScientWindows]::List(${pid})`)),
    );
    powershell(
      `${windowsCapture}\n[ScientWindows]::Capture(${window.id}, '${filename.replaceAll("'", "''")}')`,
    );
  } else {
    let ids = [];
    try {
      ids = NodeChildProcess.execFileSync(
        "xdotool",
        ["search", "--onlyvisible", "--pid", String(pid)],
        { encoding: "utf8", timeout: STEP_TIMEOUT },
      )
        .split("\n")
        .filter((id) => /^\d+$/.test(id));
    } catch {}
    const window = largestWindow(
      ids.map((id) => {
        const geometry = NodeChildProcess.execFileSync(
          "xdotool",
          ["getwindowgeometry", "--shell", id],
          { encoding: "utf8", timeout: STEP_TIMEOUT },
        );
        const field = (name) => Number(new RegExp(`^${name}=(\\d+)$`, "m").exec(geometry)?.[1]);
        return { id, width: field("WIDTH"), height: field("HEIGHT") };
      }),
    );
    NodeChildProcess.execFileSync("import", ["-window", window.id, filename], {
      stdio: "pipe",
      timeout: STEP_TIMEOUT,
    });
  }
  NodeAssert.ok(NodeFS.statSync(filename).size > 0, "The relaunched window capture is empty");
}

async function qualify(options) {
  const platform = HostProcess.Platform.defaultValue();
  NodeAssert.ok(platformManifest[platform], "Unsupported native qualification platform");
  const profiles = requireDisposableRunner();
  const sourceRoot = NodePath.resolve(options.source);
  const targetRoot = NodePath.resolve(options.target);
  const source = payload(sourceRoot, platform, HostProcess.Architecture.defaultValue());
  const target = payload(targetRoot, platform, HostProcess.Architecture.defaultValue());
  NodeAssert.ok(
    /^0\.0\.[1-9]\d*$/.test(source.manifest.version) &&
      /^0\.0\.[1-9]\d*$/.test(target.manifest.version) &&
      BigInt(target.manifest.version.slice(4)) > BigInt(source.manifest.version.slice(4)),
    "Qualification requires a newer 0.0.N rehearsal target, not swapped or publishing runs",
  );
  windowsSignature = options["windows-signature"];
  const policy = JSON.parse(NodeFS.readFileSync(policyPaths[platform], "utf8"));
  const port = Number(options.port);
  NodeAssert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  NodeAssert.equal(
    policy.limits?.updates?.feedUrl,
    `https://127.0.0.1:${port}`,
    "Install the isolated loopback managed policy before launching; the native relaunch must keep it",
  );
  const root = NodeFS.mkdtempSync(NodePath.join(process.env.RUNNER_TEMP, "scient-native-upgrade-"));
  // Windows: directly under the system drive, whose new folders other users may change, so the
  // installer must protect the install folder; the drive root itself is one they cannot replace.
  const install =
    platform === "win32"
      ? NodeFS.mkdtempSync(NodePath.join(`${process.env.SystemDrive}\\`, "scient-native-upgrade-"))
      : NodePath.join(root, "installed");
  const project = NodePath.join(root, "restart-qualification-project");
  NodeFS.mkdirSync(project);
  const sentinel = "Synthetic restart qualification. No live user data.\n";
  NodeFS.writeFileSync(NodePath.join(project, "sentinel.txt"), sentinel);
  const executable = installSource(source.filename, install, platform);
  // Node in the app trusts the runner's feed certificate too; Chromium reads the OS store.
  const appEnv = {
    ...process.env,
    NODE_EXTRA_CA_CERTS: NodePath.join(options["tls-dir"], "ca.pem"),
    ...(platform === "linux" ? { APPIMAGE_EXTRACT_AND_RUN: "1" } : {}),
  };
  if (platform === "win32") verifySignature(target.filename, platform);
  const corrupt = { value: options.scenario === "checksum-recovery" };
  NodeAssert.ok(options.scenario !== "preparation-recovery" || platform === "darwin");
  const overrides =
    options.scenario === "preparation-recovery" ? invalidSignatureFixture(target, root) : new Map();
  const evidence = NodePath.dirname(NodePath.resolve(options.output));
  NodeFS.mkdirSync(evidence, { recursive: true });
  const server = await serveFeed(targetRoot, port, corrupt, overrides, options["tls-dir"]);
  let app;
  let relaunched;
  let stopRecording;
  let keepConsole = () => {};
  let keepUpdateUi = async () => {};
  let updatedPid;
  let updatedPidQuit = false;
  let receipt;
  const launch = (name) =>
    launchInstalled({
      executable,
      env: appEnv,
      userData: profiles.userData,
      platform,
      log: NodePath.join(evidence, `${name}-output.log`),
    });
  try {
    app = await launch("source-app");
    const { page } = app;
    // The old app must exit; one that survives beside the relaunch is a failed handoff.
    const sourceMainPid = app.pid;
    stopRecording = await recordWindow(page, NodePath.join(evidence, "restart.webm"), platform);
    NodeAssert.equal(await appVersion(page), source.manifest.version);
    // The synthetic profile holds no user data; its console and logs explain a failed run.
    const consoleLines = [];
    page.on("console", (message) => consoleLines.push(`[${message.type()}] ${message.text()}`));
    page.on("pageerror", (error) => consoleLines.push(`[pageerror] ${error.message}`));
    keepConsole = () =>
      NodeFS.writeFileSync(
        NodePath.join(evidence, "renderer-console.log"),
        consoleLines.join("\n"),
      );
    // Every update state this renderer receives, to explain a control that shows the wrong one.
    await page.evaluate(() => {
      window.__qualificationUpdateStates = [];
      window.desktopBridge.onUpdateState((state) =>
        window.__qualificationUpdateStates.push({
          status: state.status,
          errorContext: state.errorContext,
          availableVersion: state.availableVersion,
          downloadedVersion: state.downloadedVersion,
          message: state.message,
        }),
      );
    });
    keepUpdateUi = async () => {
      const ui = await page.evaluate(async () => ({
        received: window.__qualificationUpdateStates,
        current: await window.desktopBridge.getUpdateState(),
        controls: [...document.querySelectorAll("button[aria-label]")]
          .map((button) => button.getAttribute("aria-label"))
          .filter((label) => /update|retry|restart|download/i.test(label)),
      }));
      NodeFS.writeFileSync(NodePath.join(evidence, "update-ui.json"), JSON.stringify(ui, null, 2));
    };
    // A fresh profile opens Scient's first-run welcome; skip it to reach the empty workspace.
    const addProject = page.getByRole("button", { name: "Add project", exact: true }).first();
    const skipOnboarding = page.getByRole("button", { name: "Skip", exact: true }).first();
    for (let step = 0; step < 4; step++) {
      await addProject.or(skipOnboarding).first().waitFor({ state: "visible", timeout: TIMEOUT });
      if (await addProject.isVisible()) break;
      await skipOnboarding.click();
    }
    await addProject.click();
    await page.getByText("Local folder", { exact: true }).click();
    // The picker fills in its starting folder once it has read it; a path typed before that is
    // merged into it (seen once on Windows), so wait for it, then require the typed path.
    const pathInput = page.getByRole("combobox");
    await pathInput.waitFor({ state: "visible", timeout: TIMEOUT });
    for (let wait = 0; wait < 60 && (await pathInput.inputValue()) === ""; wait++)
      await new Promise((resolve) => setTimeout(resolve, 250));
    for (let attempt = 1; ; attempt++) {
      await pathInput.fill(project);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const typed = await pathInput.inputValue();
      if (typed === project) break;
      NodeAssert.ok(attempt < 5, `The folder picker kept rewriting the typed path: ${typed}`);
    }
    await pathInput.press("Enter");
    // Opening a plain folder asks whether to add Scient's project files; the synthetic project
    // stays an ordinary folder.
    const composer = page.locator('[contenteditable="true"]').first();
    const openWithoutSetup = page.getByRole("button", { name: /^Open without setup/ }).first();
    await composer.or(openWithoutSetup).first().waitFor({ state: "visible", timeout: TIMEOUT });
    if (await openWithoutSetup.isVisible()) await openWithoutSetup.click();
    await page
      .getByText(NodePath.basename(project), { exact: true })
      .first()
      .waitFor({ state: "visible", timeout: TIMEOUT });
    await composer.waitFor({ state: "visible", timeout: TIMEOUT });
    await page.evaluate(() => window.desktopBridge.checkForUpdate());
    if (corrupt.value) {
      // Only the injected fault counts: a transport error that a retry fixes would prove nothing.
      await waitForUpdateState(
        page,
        (state) =>
          state.errorContext === "download" &&
          state.downloadedVersion === null &&
          /ERR_CHECKSUM_MISMATCH|checksum mismatch/.test(state.message ?? ""),
      );
      NodeAssert.equal(await appVersion(page), source.manifest.version);
      corrupt.value = false;
      await page.evaluate(() => window.desktopBridge.downloadUpdate());
    }
    await waitForUpdateState(
      page,
      (state) =>
        state.status === "downloaded" && state.downloadedVersion === target.manifest.version,
    );
    await page.screenshot({ path: NodePath.join(evidence, "before-restart.png") });
    let recoveredPreparationAttempt;
    if (options.scenario === "preparation-recovery") {
      await page.getByRole("button", { name: /^Update:/ }).click();
      await page.getByRole("button", { name: "Restart now", exact: true }).click();
      await waitForUpdateState(
        page,
        (state) => state.errorContext === "download" && state.downloadedVersion === null,
      );
      overrides.clear();
      NodeAssert.ok(
        processAlive(sourceMainPid) && (await appVersion(page)) === source.manifest.version,
        "Native signature rejection must leave the original app running",
      );
      const trace = NodePath.join(profiles.baseDir, "userdata", "logs", "desktop.trace.ndjson");
      // Squirrel must have rejected the damaged signature itself, not failed some other way.
      await waitForFileText(trace, /Code signature at URL .* did not pass validation/);
      const observation = new AbortController();
      try {
        const events = await waitForTrace(
          trace,
          (events) => events.some((event) => event.event === "abandoned"),
          observation.signal,
        );
        const failed = events.filter((event) => event.event === "abandoned");
        NodeAssert.equal(failed.length, 1);
        recoveredPreparationAttempt = failed[0].attemptId;
        NodeAssert.equal(
          events.some(
            (event) =>
              event.attemptId === recoveredPreparationAttempt &&
              ["shutdown-started", "native-handoff", "launched"].includes(event.event),
          ),
          false,
          "Native preparation rejection must not stop the backend or hand off installation",
        );
      } finally {
        observation.abort();
      }
      await page.evaluate(() => window.desktopBridge.checkForUpdate());
      await page.evaluate(() => window.desktopBridge.downloadUpdate());
      await waitForUpdateState(
        page,
        (state) =>
          state.status === "downloaded" && state.downloadedVersion === target.manifest.version,
      );
    }
    if (options.scenario === "ordinary-quit") {
      let shipItState;
      let bundleInfo;
      if (platform === "darwin") {
        bundleInfo = NodePath.join(
          NodePath.resolve(executable, "../../.."),
          "Contents",
          "Info.plist",
        );
        const identifier = NodeChildProcess.execFileSync(
          "plutil",
          ["-extract", "CFBundleIdentifier", "raw", "-o", "-", bundleInfo],
          { encoding: "utf8" },
        ).trim();
        shipItState = NodePath.join(
          NodeOS.homedir(),
          "Library",
          "Caches",
          `${identifier}.ShipIt`,
          "ShipItState.plist",
        );
        NodeAssert.equal(
          NodeFS.existsSync(shipItState),
          false,
          "No native install request may be armed before consent",
        );
      }
      await app.quit();
      if (platform === "darwin") {
        NodeAssert.equal(
          NodeFS.existsSync(shipItState),
          false,
          "Ordinary quit must not create a native install request",
        );
        NodeAssert.equal(
          NodeChildProcess.execFileSync(
            "plutil",
            ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", bundleInfo],
            { encoding: "utf8" },
          ).trim(),
          source.manifest.version,
        );
      }
      relaunched = await launch("relaunched-app");
      NodeAssert.equal(
        await appVersion(relaunched.page),
        source.manifest.version,
        "Downloading without explicit consent must not install on ordinary quit",
      );
      await relaunched.page.screenshot({ path: NodePath.join(evidence, "restored-workspace.png") });
      await relaunched.quit();
      receipt = {
        scenario: options.scenario,
        platform,
        arch: HostProcess.Architecture.defaultValue(),
        sourceVersion: source.manifest.version,
        targetVersion: target.manifest.version,
        // Both quits ran the app's own before-quit and shutdown and exited with status 0.
        quitGracefully: true,
        passed: true,
      };
    } else {
      const trace = NodePath.join(profiles.baseDir, "userdata", "logs", "desktop.trace.ndjson");
      const observation = new AbortController();
      const completion = waitForTrace(
        trace,
        (events) =>
          events.some(
            (event) =>
              event.event === "workspace-ready" &&
              event.fromVersion === source.manifest.version &&
              event.targetVersion === target.manifest.version,
          ),
        observation.signal,
      );
      void completion.catch(() => {});
      const editedSentinel = `${sentinel}Unsaved edit must survive native restart.\n`;
      try {
        await page.keyboard.press("ControlOrMeta+p");
        await page.getByPlaceholder("Search files…", { exact: true }).fill("sentinel.txt");
        await page.getByText("sentinel.txt", { exact: true }).first().click();
        // The file editor, found by the file's own text: the chat composer is a textbox too.
        const editor = page
          .locator("[data-content]")
          .filter({ hasText: "Synthetic restart qualification" })
          .first();
        await editor.waitFor({ state: "visible", timeout: TIMEOUT });
        // Autosave (a 500 ms debounce) would save the edit by itself and hide a broken save
        // barrier, so its timer is dropped while the edit is typed; every other timer and RPC
        // runs normally. The barrier is then the only thing that can save this edit.
        await page.evaluate(() => {
          const schedule = window.setTimeout;
          window.__qualificationRestoreTimers = () => {
            window.setTimeout = schedule;
          };
          window.setTimeout = (handler, delay, ...args) =>
            delay === 500 ? 0 : schedule(handler, delay, ...args);
        });
        await editor.locator("[data-line]").first().click();
        await page.keyboard.press("ControlOrMeta+a");
        await page.keyboard.insertText(editedSentinel);
        await page.evaluate(() => window.__qualificationRestoreTimers());
        await page
          .locator("[data-content] > [data-line]")
          .filter({
            hasText: "Unsaved edit must survive native restart.",
          })
          .first()
          .waitFor({ state: "visible", timeout: TIMEOUT });
        // Long enough for any autosave that escaped to have written the file.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        NodeAssert.equal(
          NodeFS.readFileSync(NodePath.join(project, "sentinel.txt"), "utf8"),
          sentinel,
          "The qualification must begin with an actual unsaved edit, not an already saved file",
        );
        await page.getByRole("button", { name: /^Update:/ }).click();
        await page.getByRole("button", { name: "Restart now", exact: true }).click();
        // The restart saves twice: at consent, and again just before shutdown for edits made while
        // macOS prepares. On macOS (preparation takes seconds) the first save must land while the
        // app is still preparing; a second edit typed then must be saved by the final save alone.
        const checksFinalSave = platform === "darwin";
        const duringPreparation = "Edited while the update prepared.\n";
        if (checksFinalSave) {
          const sentinelPath = NodePath.join(project, "sentinel.txt");
          const deadline = Date.now() + 60_000;
          while (NodeFS.readFileSync(sentinelPath, "utf8") !== editedSentinel) {
            NodeAssert.ok(Date.now() < deadline, "The consent save did not write the edit");
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          const preparing = await page.evaluate(() => window.desktopBridge.getUpdateState());
          NodeAssert.equal(preparing.status, "preparing", "The first save must precede shutdown");
          NodeAssert.doesNotMatch(
            preparing.message ?? "",
            /Saving your work/,
            "The second edit must be made before the final save starts",
          );
          await page.evaluate(() => {
            const schedule = window.setTimeout;
            window.__qualificationRestoreTimers = () => {
              window.setTimeout = schedule;
            };
            window.setTimeout = (handler, delay, ...args) =>
              delay === 500 ? 0 : schedule(handler, delay, ...args);
          });
          await page
            .locator("[data-content] > [data-line]")
            .filter({ hasText: "Unsaved edit must survive native restart." })
            .first()
            .click();
          await page.keyboard.press("Meta+ArrowDown");
          await page.keyboard.insertText(duringPreparation);
          await page.evaluate(() => window.__qualificationRestoreTimers());
        }
        await completion;
        // The settled receipt follows readiness by about a second plus a trace flush; when it
        // never comes, qualifyTiming names it as missing.
        const events = await waitForTrace(
          trace,
          (events) =>
            events.some(
              (event) =>
                event.event === "workspace-settled" &&
                event.fromVersion === source.manifest.version &&
                event.targetVersion === target.manifest.version,
            ),
          observation.signal,
          STEP_TIMEOUT,
        ).catch(() => timingEvents(NodeFS.readFileSync(trace, "utf8")));
        const successfulEvents =
          recoveredPreparationAttempt === undefined
            ? events
            : events.filter((event) => event.attemptId !== recoveredPreparationAttempt);
        const timings = qualifyTiming(
          successfulEvents,
          source.manifest.version,
          target.manifest.version,
        );
        updatedPid = timings.processId;
        requireSingleMain(updatedPid, executable, platform);
        if (platform === "darwin")
          verifySignature(NodePath.resolve(executable, "../../.."), platform);
        NodeAssert.equal(
          NodeFS.readFileSync(NodePath.join(project, "sentinel.txt"), "utf8"),
          checksFinalSave ? `${editedSentinel}${duringPreparation}` : editedSentinel,
        );
        const confirmedAt = successfulEvents.find((event) => event.event === "confirmed")?.atMs;
        NodeAssert.ok(confirmedAt !== undefined, "The consent receipt must carry its time");
        NodeAssert.ok(
          NodeFS.statSync(NodePath.join(project, "sentinel.txt")).mtimeMs >= confirmedAt - 5,
          "The edit must be saved by the consented restart, not before it",
        );
        for (let wait = 0; processAlive(sourceMainPid) && wait < 60; wait++)
          await new Promise((resolve) => setTimeout(resolve, 500));
        NodeAssert.equal(processAlive(sourceMainPid), false, "The old app must exit after handoff");
        captureWindow(updatedPid, NodePath.join(evidence, "restarted-window.png"), platform);
        quitOwnedUpdatedProcess(updatedPid, executable, platform);
        updatedPidQuit = true;
        NodeAssert.ok(
          await waitForExit(updatedPid, 60_000),
          "The natively relaunched app must quit normally",
        );
        // The natively relaunched app was started without switches, so its restored workspace is
        // checked in the next ordinary launch of the installed target.
        relaunched = await launch("relaunched-app");
        requireSingleMain(relaunched.pid, executable, platform);
        NodeAssert.equal(await appVersion(relaunched.page), target.manifest.version);
        await requireRestoredWorkspace(relaunched.page, NodePath.basename(project));
        await relaunched.page.screenshot({
          path: NodePath.join(evidence, "restored-workspace.png"),
        });
        await relaunched.quit();
        receipt = {
          scenario: options.scenario,
          platform,
          arch: HostProcess.Architecture.defaultValue(),
          sourceVersion: source.manifest.version,
          targetVersion: target.manifest.version,
          sourceSha512: source.file.sha512,
          targetSha512: target.file.sha512,
          signatures:
            platform === "linux"
              ? "manifest-sha512"
              : platform === "win32"
                ? windowsInstallerSignature
                : "native-verified",
          preparationFailureRecovered: recoveredPreparationAttempt !== undefined,
          unsavedEditPreserved: true,
          finalSaveChecked: checksFinalSave,
          restoredProjectControlsVisible: true,
          restoredComposerUsable: true,
          restoredWindowUnlocked: true,
          nextLaunchProjectControlsVisible: true,
          nextLaunchWindowUnlocked: true,
          ...timings,
          passed: true,
        };
      } finally {
        observation.abort();
      }
    }
    const frames = await stopRecording();
    stopRecording = undefined;
    NodeAssert.ok(frames > 0, "The real restart interaction must be recorded");
  } finally {
    // A relaunched app has no page left to read; only a stopped run does.
    if (updatedPid === undefined) await keepUpdateUi().catch(() => {});
    keepConsole();
    try {
      await stopRecording?.().catch(() => {});
      if (updatedPid !== undefined && !updatedPidQuit && processAlive(updatedPid)) {
        try {
          quitOwnedUpdatedProcess(updatedPid, executable, platform);
          if (!(await waitForExit(updatedPid, 60_000))) process.kill(updatedPid, "SIGKILL");
        } catch (error) {
          console.error("Could not stop the updated app:", error);
        }
      }
      await relaunched?.stop().catch((error) => console.error("Could not stop the app:", error));
      await app?.stop().catch((error) => console.error("Could not stop the app:", error));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      // After the app stopped, so its trace is complete.
      const logs = NodePath.join(profiles.baseDir, "userdata", "logs");
      if (NodeFS.existsSync(logs))
        NodeFS.cpSync(logs, NodePath.join(evidence, "desktop-logs"), { recursive: true });
    }
  }
  NodeFS.mkdirSync(NodePath.dirname(NodePath.resolve(options.output)), { recursive: true });
  NodeFS.writeFileSync(options.output, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt));
}

if (
  process.argv[1] &&
  NodeURL.fileURLToPath(import.meta.url) === NodePath.resolve(process.argv[1])
) {
  const { values } = NodeUtil.parseArgs({
    options: {
      source: { type: "string" },
      target: { type: "string" },
      output: { type: "string" },
      "source-sha": { type: "string" },
      "target-sha": { type: "string" },
      port: { type: "string", default: "3000" },
      scenario: { type: "string", default: "upgrade" },
      "tls-dir": { type: "string" },
      "windows-signature": { type: "string", default: "required" },
    },
  });
  NodeAssert.ok(
    values.source && values.target && values.output && values["source-sha"] && values["target-sha"],
    "Usage: node scripts/qualify-desktop-update.mjs --source <source-release-dir> --source-sha <commit> --target <target-release-dir> --target-sha <commit> --output <receipt.json> --tls-dir <feed-certificate-dir> [--windows-signature required|optional] [--scenario upgrade|ordinary-quit|checksum-recovery|preparation-recovery]",
  );
  verifyHandoff(NodePath.resolve(values.source), values["source-sha"]);
  verifyHandoff(NodePath.resolve(values.target), values["target-sha"]);
  NodeAssert.ok(
    ["upgrade", "ordinary-quit", "checksum-recovery", "preparation-recovery"].includes(
      values.scenario,
    ),
  );
  NodeAssert.ok(values["tls-dir"], "Pass --tls-dir with the runner's loopback feed certificate");
  NodeAssert.ok(["required", "optional"].includes(values["windows-signature"]));
  await qualify(values);
}
