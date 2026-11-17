import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const TIMEOUT = 300_000;
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
        events.push(fields);
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
  NodeAssert.ok(Number.isFinite(shutdown.elapsedMs) && shutdown.elapsedMs >= 0);
  NodeAssert.ok(Number.isFinite(handoff.elapsedMs) && handoff.elapsedMs >= shutdown.elapsedMs);
  for (const event of [launched, backend, ready]) {
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
  for (const [field, value] of Object.entries({
    confirmToLaunchMs: launched.confirmToLaunchMs,
    handoffToLaunchMs: launched.handoffToLaunchMs,
    launchToBackendMs: backend.launchToBackendMs,
    confirmToReadyMs: ready.confirmToReadyMs,
    launchToReadyMs: ready.launchToReadyMs,
  }))
    NodeAssert.ok(Number.isFinite(value) && value >= 0, `Missing or invalid ${field}`);
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
    ["latest-mac.yml", Buffer.from(stringifyYaml(manifest))],
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

function stopOwnedUpdatedProcess(pid, executable, platform) {
  let actual;
  if (platform === "win32") {
    actual = NodeChildProcess.execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ExecutablePath`,
      ],
      { encoding: "utf8" },
    ).trim();
  } else if (platform === "darwin") {
    actual = NodeChildProcess.execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf8",
    }).trim();
  } else {
    const environment = NodeFS.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    NodeAssert.ok(
      environment.includes(`APPIMAGE=${executable}`),
      "Updated PID is not this qualification AppImage",
    );
    actual = executable;
  }
  NodeAssert.equal(
    NodePath.resolve(actual).toLowerCase(),
    NodePath.resolve(executable).toLowerCase(),
    "Refusing to stop a PID not owned by the installed qualification app",
  );
  process.kill(pid, "SIGTERM");
}

function requireSingleMain(pid, executable, platform) {
  let pids;
  if (platform === "win32") {
    const rows = JSON.parse(
      NodeChildProcess.execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
        ],
        { encoding: "utf8" },
      ),
    );
    pids = rows
      .filter(
        (row) =>
          row.ExecutablePath?.toLowerCase() === executable.toLowerCase() &&
          !row.CommandLine?.includes("--type="),
      )
      .map((row) => row.ProcessId);
  } else if (platform === "darwin") {
    pids = NodeChildProcess.execFileSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8" })
      .split("\n")
      .map((row) => /^\s*(\d+)\s+(.+)$/.exec(row))
      .filter((row) => row?.[2] === executable)
      .map((row) => Number(row[1]));
  } else {
    const actual = NodeFS.readlinkSync(`/proc/${pid}/exe`);
    pids = NodeFS.readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .flatMap((name) => {
        try {
          return NodeFS.readlinkSync(`/proc/${name}/exe`) === actual &&
            !NodeFS.readFileSync(`/proc/${name}/cmdline`, "utf8").includes("--type=")
            ? [Number(name)]
            : [];
        } catch {
          return [];
        }
      });
  }
  NodeAssert.deepEqual(pids, [pid], "Exactly one updated main process must be running");
}

// Attach after the measured native restart, without adding a debug switch or test hook to the app.
async function inspectRestartedWorkspace(pid, targetVersion, projectName, screenshotPath) {
  const inspector = NodeChildProcess.spawn(process.execPath, ["inspect", "-p", String(pid)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let socket;
  const signal = AbortSignal.timeout(30_000);
  try {
    await new Promise((resolve, reject) => {
      let output = "";
      const ready = (chunk) => {
        output += chunk.toString();
        if (output.includes("debug>")) resolve();
      };
      inspector.stdout.on("data", ready);
      inspector.stderr.on("data", ready);
      inspector.once("error", reject);
      inspector.once("exit", (code) =>
        reject(new Error(`Inspector attach exited (${code}): ${output}`)),
      );
      signal.addEventListener(
        "abort",
        () => reject(new Error(`Inspector attach timed out: ${output}`)),
        { once: true },
      );
    });
    const targets = await (await fetch("http://127.0.0.1:9229/json/list", { signal })).json();
    NodeAssert.equal(targets.length, 1, "Expected only this disposable app's inspector");
    socket = new WebSocket(targets[0].webSocketDebuggerUrl);
    await NodeEvents.once(socket, "open", { signal });
    let id = 0;
    async function evaluate(expression) {
      const message = NodeEvents.once(socket, "message", { signal });
      socket.send(
        JSON.stringify({
          id: ++id,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
      const response = JSON.parse((await message)[0].data);
      NodeAssert.equal(response.id, id);
      NodeAssert.equal(response.error, undefined);
      NodeAssert.equal(
        response.result.exceptionDetails,
        undefined,
        "Live renderer inspection failed",
      );
      return response.result.result.value;
    }
    NodeAssert.equal(
      await evaluate("process.pid"),
      pid,
      "Refusing to inspect an unrelated process",
    );
    const result = await evaluate(`(async () => {
      const { app, BrowserWindow } = process.getBuiltinModule("module").createRequire(process.execPath)("electron");
      const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed() && window.isVisible());
      const controls = await Promise.all(windows.map(window => window.webContents.executeJavaScript(
        ${JSON.stringify(`(() => {
          const visible = element => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
          return {
            projectVisible: [...document.querySelectorAll("button, a, span")].some(element =>
              element.textContent.trim() === ${JSON.stringify(projectName)} && visible(element)),
            composerVisible: [...document.querySelectorAll('[contenteditable="true"]')].some(visible),
            unlocked: !document.body.inert,
          };
        })()`)}
      )));
      const restored = controls.findIndex(control => control.projectVisible && control.composerVisible && control.unlocked);
      const screenshot = restored < 0 ? null : (await windows[restored].capturePage()).toPNG().toString("base64");
      return { version: app.getVersion(), controls, screenshot };
    })()`);
    NodeAssert.equal(result.version, targetVersion);
    NodeAssert.ok(
      result.controls.some(
        (control) => control.projectVisible && control.composerVisible && control.unlocked,
      ),
      "The natively relaunched app must show the restored project's controls and accept input",
    );
    NodeAssert.equal(typeof result.screenshot, "string");
    NodeFS.writeFileSync(screenshotPath, Buffer.from(result.screenshot, "base64"));
    return { restoredProjectControlsVisible: true, restoredWindowUnlocked: true };
  } finally {
    socket?.close();
    inspector.kill();
  }
}

async function qualify(options) {
  const platform = HostProcess.Platform.defaultValue();
  NodeAssert.ok(platformManifest[platform], "Unsupported native qualification platform");
  const profiles = requireDisposableRunner();
  const { _electron } = await import("playwright-core");
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
  const install = NodePath.join(root, "installed");
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
  let updatedPid;
  let receipt;
  try {
    app = await _electron.launch({
      executablePath: executable,
      timeout: TIMEOUT,
      recordVideo: { dir: NodePath.join(evidence, "video"), size: { width: 1280, height: 800 } },
      env: appEnv,
    });
    NodeAssert.equal(await app.evaluate(({ app }) => app.getVersion()), source.manifest.version);
    NodeAssert.equal(
      NodePath.resolve(await app.evaluate(({ app }) => app.getPath("userData"))),
      NodePath.resolve(profiles.userData),
    );
    const page = await app.firstWindow({ timeout: TIMEOUT });
    await page.waitForFunction(
      () => typeof window.desktopBridge?.checkForUpdate === "function",
      undefined,
      { timeout: TIMEOUT },
    );
    // A fresh profile opens Scient's getting-started flow; skip it to reach the empty workspace.
    const addProject = page.getByRole("button", { name: "Add project", exact: true }).first();
    const skipOnboarding = page.getByRole("button", { name: "Skip", exact: true }).first();
    for (let step = 0; step < 4; step++) {
      await addProject.or(skipOnboarding).first().waitFor({ state: "visible", timeout: TIMEOUT });
      if (await addProject.isVisible()) break;
      await skipOnboarding.click();
    }
    await addProject.click();
    await page.getByText("Local folder", { exact: true }).click();
    await page.getByRole("combobox").fill(project);
    await page.getByRole("combobox").press("Enter");
    await page
      .getByText(NodePath.basename(project), { exact: true })
      .first()
      .waitFor({ state: "visible", timeout: TIMEOUT });
    await page
      .locator('[contenteditable="true"]')
      .first()
      .waitFor({ state: "visible", timeout: TIMEOUT });
    await page.evaluate(() => window.desktopBridge.checkForUpdate());
    if (corrupt.value) {
      await page.waitForFunction(
        async () => {
          const state = await window.desktopBridge.getUpdateState();
          return state.errorContext === "download" && state.downloadedVersion === null;
        },
        undefined,
        { timeout: TIMEOUT },
      );
      NodeAssert.equal(await app.evaluate(({ app }) => app.getVersion()), source.manifest.version);
      corrupt.value = false;
      await page.evaluate(() => window.desktopBridge.downloadUpdate());
    }
    await page.waitForFunction(
      async (version) => {
        const state = await window.desktopBridge.getUpdateState();
        return state.status === "downloaded" && state.downloadedVersion === version;
      },
      target.manifest.version,
      { timeout: TIMEOUT },
    );
    await page.screenshot({ path: NodePath.join(evidence, "before-restart.png") });
    const video = page.video();
    NodeAssert.ok(video, "The real restart interaction must be recorded");
    let recoveredPreparationAttempt;
    if (options.scenario === "preparation-recovery") {
      await page.getByRole("button", { name: /^Update:/ }).click();
      await page.getByRole("button", { name: "Restart now", exact: true }).click();
      await page.waitForFunction(
        async () => {
          const state = await window.desktopBridge.getUpdateState();
          return state.errorContext === "download" && state.downloadedVersion === null;
        },
        undefined,
        { timeout: TIMEOUT },
      );
      overrides.clear();
      NodeAssert.equal(
        await app.evaluate(({ app }) => app.getVersion()),
        source.manifest.version,
        "Native signature rejection must leave the original app running",
      );
      const trace = NodePath.join(profiles.baseDir, "userdata", "logs", "desktop.trace.ndjson");
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
      await page.waitForFunction(
        async (version) => {
          const state = await window.desktopBridge.getUpdateState();
          return state.status === "downloaded" && state.downloadedVersion === version;
        },
        target.manifest.version,
        { timeout: TIMEOUT },
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
      await app.close();
      app = undefined;
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
      app = await _electron.launch({
        executablePath: executable,
        timeout: TIMEOUT,
        env: appEnv,
      });
      NodeAssert.equal(
        await app.evaluate(({ app }) => app.getVersion()),
        source.manifest.version,
        "Downloading without explicit consent must not install on ordinary quit",
      );
      await (
        await app.firstWindow({ timeout: TIMEOUT })
      ).screenshot({
        path: NodePath.join(evidence, "restored-workspace.png"),
      });
      receipt = {
        scenario: options.scenario,
        platform,
        arch: HostProcess.Architecture.defaultValue(),
        sourceVersion: source.manifest.version,
        targetVersion: target.manifest.version,
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
      try {
        await page.keyboard.press("ControlOrMeta+p");
        await page.getByPlaceholder("Search files…", { exact: true }).fill("sentinel.txt");
        await page.getByText("sentinel.txt", { exact: true }).first().click();
        const editor = page.getByRole("textbox").last();
        await editor.first().waitFor({ state: "visible", timeout: TIMEOUT });
        // Freeze autosave only to establish a real dirty edit; resume the RPC scheduler before consent.
        await page.clock.install();
        await page.clock.pauseAt(new Date(Date.now() + 1_000));
        const editedSentinel = `${sentinel}Unsaved edit must survive native restart.\n`;
        await editor.click();
        await page.keyboard.press("ControlOrMeta+a");
        await page.keyboard.insertText(editedSentinel);
        await page
          .locator("[data-content] > [data-line]")
          .filter({
            hasText: "Unsaved edit must survive native restart.",
          })
          .first()
          .waitFor({ state: "visible", timeout: TIMEOUT });
        NodeAssert.equal(
          NodeFS.readFileSync(NodePath.join(project, "sentinel.txt"), "utf8"),
          sentinel,
          "The qualification must begin with an actual unsaved edit, not an already saved file",
        );
        await page.getByRole("button", { name: /^Update:/ }).click();
        await page.clock.resume();
        await page.getByRole("button", { name: "Restart now", exact: true }).click();
        const events = await completion;
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
          editedSentinel,
        );
        const restoredControls = await inspectRestartedWorkspace(
          updatedPid,
          target.manifest.version,
          NodePath.basename(project),
          NodePath.join(evidence, "restored-workspace.png"),
        );
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
          ...restoredControls,
          ...timings,
          passed: true,
        };
      } finally {
        observation.abort();
      }
    }
    await video.saveAs(NodePath.join(evidence, "restart.webm"));
  } finally {
    if (updatedPid !== undefined) stopOwnedUpdatedProcess(updatedPid, executable, platform);
    else if (app !== undefined) await app.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
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
