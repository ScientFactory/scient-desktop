#!/usr/bin/env node
// The standing dev app ("Scient (Dev) Stable"): one installed app that can be
// switched to any branch, pull request or commit for review.
//
//   pnpm dev:app:review <#123 | pr:123 | branch | commit:<sha>> [--fresh]
//   pnpm dev:app:review --restore-previous
//   pnpm dev:app:stable <install [--checkout <path>] | start | stop | status | logs | open | uninstall>
//
// `install` copies this controller out of the invoking checkout into
// ~/.scient-next/scient-dev-stable/controller; every later command runs that
// copy, so a switch never executes lifecycle code from the commit it is
// replacing. See docs/operations/dev-app-review.md.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  chooseProfile,
  createProfile,
  DEV_APP_PROTOCOL,
  fetchRefspec,
  INSTALL_INPUT_PATHSPECS,
  installFingerprint,
  installWatchdogVerdict,
  markProfileRun,
  parseReviewRef,
  pruneProfiles,
  readJsonFile,
  readProfile,
  releaseLock,
  resolveStablePaths,
  restoreProfileSnapshot,
  retireProfile,
  snapshotProfile,
  tryAcquireLock,
  validateProfileRoot,
  writeJsonAtomic,
} from "./review.mjs";
import {
  deleteScheduledTask,
  findProcessesUnder,
  hostArch,
  hostPlatform,
  launchJobName,
  launchTokenHash,
  ownerState,
  processStart,
  quoteWindowsArgument,
  registerScheduledTask,
  runScheduledTask,
  scheduledTaskXml,
  selfOwner,
  startMenuShortcutPath,
  terminateWindowsJob,
  terminateWindowsProcess,
  WINDOWS_JOB_SCRIPT,
  writeStartMenuShortcut,
} from "./host.mjs";

const APP_NAME = "Scient (Dev) Stable";
/** Outside dev-runner's hashed worktree range (1-3000), so ports never move. */
const STABLE_PORT_OFFSET = "3100";
const READY_TIMEOUT_MS = 10 * 60_000;
const QUIT_TIMEOUT_MS = 30_000;
const INSTALL_IDLE_MS = 6 * 60_000;
const INSTALL_DEADLINE_MS = 45 * 60_000;
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
const LOG_KEEP = 3;
/** Once ready, the runner ends the launch when the app stays unreachable this long. */
const RUNNER_APP_GONE_MS = 20_000;
/** Copied into the controller directory, keeping their relative layout. */
const CONTROLLER_FILES = [
  "scripts/dev-app/controller.mjs",
  "scripts/dev-app/review.mjs",
  "scripts/dev-app/host.mjs",
  "scripts/local-dev-app.mjs",
  "apps/desktop/scripts/dev-app-process.mjs",
  "apps/desktop/scripts/dev-app-bundle.mjs",
  "apps/desktop/scripts/dev-cold-handoff.mjs",
];

const sourceRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const paths = resolveStablePaths(NodeOS.homedir());
const jobScriptPath = NodePath.join(paths.controllerDir, "scient-dev-job.ps1");
const taskName = `Scient Dev Stable ${NodeCrypto.createHash("sha256").update(paths.root).digest("hex").slice(0, 8)}`;

function log(message) {
  console.log(`[dev-app] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function readController() {
  const config = readJsonFile(paths.controllerConfigPath);
  if (!config) fail(`${APP_NAME} is not installed. Run pnpm dev:app:stable install first.`);
  return config;
}

// ── git ───────────────────────────────────────────────────────────────────

function git(checkout, args, { allowFailure = false } = {}) {
  const result = NodeChildProcess.spawnSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFailure) {
    fail(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.status === 0 ? result.stdout.trim() : null;
}

function resolveRefSha(checkout, ref) {
  if (ref.kind === "commit") {
    const known = git(checkout, ["rev-parse", "--verify", "--quiet", `${ref.sha}^{commit}`], {
      allowFailure: true,
    });
    if (known) return known;
  }
  git(checkout, ["fetch", "--no-tags", "origin", fetchRefspec(ref)]);
  return ref.kind === "commit"
    ? git(checkout, ["rev-parse", "--verify", `${ref.sha}^{commit}`])
    : git(checkout, ["rev-parse", "FETCH_HEAD^{commit}"]);
}

function assertProtocol(checkout, sha) {
  const text = git(checkout, ["show", `${sha}:package.json`]);
  const protocol = JSON.parse(text)?.scientDevApp?.protocol;
  if (protocol !== DEV_APP_PROTOCOL) {
    fail(
      `${sha.slice(0, 12)} declares dev app protocol ${String(protocol ?? "none")}; this controller speaks ${String(DEV_APP_PROTOCOL)}. ` +
        (typeof protocol === "number" && protocol > DEV_APP_PROTOCOL
          ? "Install the newer controller with pnpm dev:app:stable install from a checkout that has it."
          : "Review it as a foreground candidate (pnpm dev:desktop in its own worktree) instead."),
    );
  }
}

// ── install ───────────────────────────────────────────────────────────────

function currentFingerprint(checkout) {
  return installFingerprint({
    lsFiles: git(checkout, ["ls-files", "-s", "--", ...INSTALL_INPUT_PATHSPECS]),
    nodeVersion: process.version,
    arch: hostArch,
    platform: hostPlatform,
  });
}

function installRecordPath(checkout) {
  return NodePath.join(checkout, "node_modules", ".scient-dev-install.json");
}

function killTree(child) {
  if (hostPlatform === "win32") {
    // The install is still running, so its PID cannot have been reused.
    NodeChildProcess.spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

function runInstallOnce(checkout, pnpm) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let lastOutputAt = startedAt;
    const child = NodeChildProcess.spawn(
      process.execPath,
      [pnpm, "install", "--frozen-lockfile", "--reporter=append-only"],
      { cwd: checkout, windowsHide: true, detached: hostPlatform !== "win32", stdio: "pipe" },
    );
    const onOutput = (chunk) => {
      lastOutputAt = Date.now();
      appendLog(chunk);
    };
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    let verdict = "running";
    const timer = setInterval(() => {
      verdict = installWatchdogVerdict({
        now: Date.now(),
        startedAt,
        lastOutputAt,
        idleMs: INSTALL_IDLE_MS,
        deadlineMs: INSTALL_DEADLINE_MS,
      });
      if (verdict !== "running") {
        clearInterval(timer);
        log(
          `dependency install ${verdict === "stalled" ? "stopped making progress" : "ran too long"}; stopping it`,
        );
        killTree(child);
      }
    }, 5_000);
    child.once("exit", (code) => {
      clearInterval(timer);
      resolve(
        verdict === "running" && code === 0 ? "ok" : verdict === "running" ? "failed" : verdict,
      );
    });
    child.once("error", () => {
      clearInterval(timer);
      resolve("failed");
    });
  });
}

async function ensureInstalled(checkout, config) {
  const fingerprint = currentFingerprint(checkout);
  if (readJsonFile(installRecordPath(checkout))?.fingerprint === fingerprint) return;
  log("installing dependencies (lockfile, packages or Node changed)");
  let result = await runInstallOnce(checkout, config.pnpm);
  if (result !== "ok") {
    // A stalled or failed install retries once from an empty node_modules; the
    // old one is set aside, not deleted, so nothing is lost if this also fails.
    const aside = NodePath.join(paths.root, `node_modules-aside-${String(Date.now())}`);
    log(`dependency install ${result}; retrying from a clean node_modules (old copy: ${aside})`);
    NodeFS.renameSync(NodePath.join(checkout, "node_modules"), aside);
    result = await runInstallOnce(checkout, config.pnpm);
    if (result !== "ok") fail(`Dependency install ${result} twice. See pnpm dev:app:stable logs.`);
  }
  writeJsonAtomic(installRecordPath(checkout), { fingerprint, at: new Date().toISOString() });
}

// ── logs ──────────────────────────────────────────────────────────────────

function rotateLog() {
  try {
    if (NodeFS.statSync(paths.logPath).size < LOG_ROTATE_BYTES) return;
  } catch {
    return;
  }
  for (let index = LOG_KEEP - 1; index >= 1; index -= 1) {
    const from = index === 1 ? paths.logPath : `${paths.logPath}.${String(index - 1)}`;
    NodeFS.rmSync(`${paths.logPath}.${String(index)}`, { force: true });
    if (NodeFS.existsSync(from)) NodeFS.renameSync(from, `${paths.logPath}.${String(index)}`);
  }
}

function appendLog(chunk) {
  NodeFS.mkdirSync(paths.root, { recursive: true });
  NodeFS.appendFileSync(paths.logPath, chunk);
}

function printLogs(lines = 200) {
  let text;
  try {
    const fd = NodeFS.openSync(paths.logPath, "r");
    try {
      const size = NodeFS.fstatSync(fd).size;
      const length = Math.min(size, 256 * 1024);
      const buffer = Buffer.alloc(length);
      NodeFS.readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString("utf8");
    } finally {
      NodeFS.closeSync(fd);
    }
  } catch {
    log(`no log yet at ${paths.logPath}`);
    return;
  }
  process.stdout.write(`${text.split("\n").slice(-lines).join("\n")}\n`);
}

// ── launch control ────────────────────────────────────────────────────────

function controlAddress(token) {
  const id = launchTokenHash(token).slice(0, 16);
  return hostPlatform === "win32"
    ? `\\\\.\\pipe\\scient-dev-launch-${id}`
    : NodePath.join(paths.runtimeDir, `launch-${id}.sock`);
}

/** {ok, ready} from the app, or null when nothing answers. */
function askApp(launch, type, timeoutMs = 3_000) {
  return new Promise((resolve) => {
    const socket = NodeNet.connect(launch.controlAddress);
    let data = "";
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(null));
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ token: launch.token, type })}\n`));
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => {
      try {
        const response = JSON.parse(data);
        done(response?.ok === true ? response : null);
      } catch {
        done(null);
      }
    });
    socket.on("error", () => done(null));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check, timeoutMs, intervalMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(intervalMs);
  }
  return false;
}

// ── start / stop ──────────────────────────────────────────────────────────

function newLaunch(config, review) {
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const profileRoot = validateProfileRoot(
    paths.profilesDir,
    NodePath.join(paths.profilesDir, review.profileId),
  );
  if (!profileRoot) fail(`Profile ${review.profileId} is missing or invalid; launch refused.`);
  const controllerPath = NodePath.join(paths.controllerDir, "scripts", "dev-app", "controller.mjs");
  return {
    token,
    tokenHash: launchTokenHash(token),
    jobName: launchJobName(token),
    controlAddress: controlAddress(token),
    checkout: config.checkout,
    profileRoot,
    profileId: review.profileId,
    sha: review.sha,
    ref: review.ref,
    node: process.execPath,
    jobPath: paths.jobPath,
    jobEmptyPath: paths.jobEmptyPath,
    runnerCommandLine: [process.execPath, controllerPath, "runner"]
      .map(quoteWindowsArgument)
      .join(" "),
    createdAt: new Date().toISOString(),
  };
}

/** Environment every process of the launch inherits. */
function launchEnvironment(config, launch) {
  return {
    SCIENT_DEV_APP_ROLE: "stable",
    SCIENT_DEV_STABLE_ROOT: paths.root,
    SCIENT_NEXT_PROFILE_ROOT: launch.profileRoot,
    SCIENT_DEV_LAUNCH_CONTROL: launch.controlAddress,
    SCIENT_DEV_LAUNCH_TOKEN: launch.token,
    T3CODE_PORT_OFFSET: STABLE_PORT_OFFSET,
    ...(config.bundleIdSuffix ? { SCIENT_DEV_BUNDLE_ID_SUFFIX: config.bundleIdSuffix } : {}),
  };
}

function localDevApp(config, args, launch) {
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(paths.controllerDir, "scripts", "local-dev-app.mjs"), ...args, "--stable"],
    {
      cwd: config.checkout,
      stdio: "inherit",
      env: {
        ...process.env,
        SCIENT_DEV_APP_CHECKOUT: config.checkout,
        SCIENT_NEXT_HOME: paths.root,
        ...(launch ? launchEnvironment(config, launch) : {}),
      },
    },
  );
  return result.status === 0;
}

async function startApp(config, { coldHandoff } = {}) {
  const review = readJsonFile(paths.reviewPath);
  if (!review) fail("Nothing to start yet. Run pnpm dev:app:review <ref> first.");
  if (git(config.checkout, ["rev-parse", "HEAD"]) !== review.sha) {
    fail(
      `The review checkout is not at ${review.sha.slice(0, 12)}. Run pnpm dev:app:review again.`,
    );
  }
  if (stopState(config) !== "stopped") fail(`${APP_NAME} is already running or not fully stopped.`);
  const launch = newLaunch(config, review);
  const profile = readProfile(paths.profilesDir, review.profileId);
  markProfileRun(profile, review.sha);
  rotateLog();
  NodeFS.rmSync(paths.jobEmptyPath, { force: true });
  NodeFS.rmSync(paths.jobPath, { force: true });
  writeJsonAtomic(paths.launchPath, launch);
  log(`starting ${review.ref} at ${review.sha.slice(0, 12)} (profile ${review.profileId})`);
  if (hostPlatform === "win32") {
    runScheduledTask(taskName);
  } else if (
    !localDevApp(
      config,
      ["start", ...(coldHandoff ? [`--cold-handoff=${coldHandoff}`] : [])],
      launch,
    )
  ) {
    fail(`Could not start ${APP_NAME}. See pnpm dev:app:stable logs.`);
  }
  const ready = await waitUntil(
    async () => (await askApp(launch, "status"))?.ready === true,
    READY_TIMEOUT_MS,
    2_000,
  );
  if (!ready) {
    fail(
      `${APP_NAME} did not become ready in time; it is left running. See pnpm dev:app:stable logs.`,
    );
  }
  log(`ready: ${review.ref} at ${review.sha.slice(0, 12)}`);
  if (hostPlatform === "darwin") ensureMacLauncher(config);
}

/** "stopped" only when no process runs from the checkout or a profile. */
function stopState(config) {
  const leftovers = findProcessesUnder([config.checkout, paths.profilesDir]);
  if (leftovers === null) return "unknown";
  return leftovers.length === 0 ? "stopped" : "running";
}

/** The Applications launcher must open this checkout; reinstall it after the checkout moves. */
function ensureMacLauncher(config) {
  const marker = readJsonFile(
    NodePath.join(
      NodeOS.homedir(),
      "Applications",
      `${APP_NAME}.app`,
      "Contents",
      "Resources",
      "scient-next-local-dev-app.json",
    ),
  );
  if (marker?.repoRoot && NodePath.resolve(marker.repoRoot) === NodePath.resolve(config.checkout)) {
    return;
  }
  log("installing the Applications launcher for the review checkout");
  if (!localDevApp(config, ["install", "--replace"])) {
    log("could not install the Applications launcher; the app itself is running");
  }
}

async function stopApp(config) {
  const launch = readJsonFile(paths.launchPath);
  if (launch && (await askApp(launch, "quit"))) {
    log("asked the app to quit");
    await waitUntil(async () => (await askApp(launch, "status", 1_000)) === null, QUIT_TIMEOUT_MS);
  }
  if (hostPlatform === "win32") {
    if (launch) {
      const job = terminateWindowsJob(jobScriptPath, launch.jobName);
      if (job === "unknown" || job.startsWith("busy:")) {
        fail(`Could not empty the launch job (${job}); ${APP_NAME} may still be running.`);
      }
      const record = readJsonFile(paths.jobPath);
      if (record?.tokenHash === launch.tokenHash) {
        const exited = await waitUntil(
          () => processStart(record.hostPid).state === "gone",
          10_000,
          500,
        );
        if (!exited) terminateWindowsProcess(record.hostPid, record.hostStart);
      }
    }
  } else if (!localDevApp(config, ["stop"])) {
    fail(`Could not stop ${APP_NAME}.`);
  }
  const leftovers = findProcessesUnder([config.checkout, paths.profilesDir]);
  if (leftovers === null) fail("Could not list processes to confirm the app stopped.");
  if (leftovers.length > 0) {
    fail(
      `Processes from the review checkout are still running: ${leftovers
        .map((entry) => String(entry.pid))
        .join(", ")}. Close them and retry.`,
    );
  }
  NodeFS.rmSync(paths.launchPath, { force: true });
  log("stopped");
}

// ── operations ────────────────────────────────────────────────────────────

async function withOperationLock(purpose, operation) {
  const owner = selfOwner(purpose);
  const lock = tryAcquireLock(paths.operationLockPath, owner, { ownerState });
  if (!lock.acquired) {
    fail(
      lock.state === "unknown"
        ? `Could not verify who holds ${paths.operationLockPath}; leave it until you know.`
        : `${APP_NAME} is busy (${String(lock.holder?.purpose)} by PID ${String(lock.holder?.pid)}).`,
    );
  }
  try {
    return await operation();
  } finally {
    releaseLock(paths.operationLockPath, owner);
  }
}

function assertCleanCheckout(checkout) {
  const status = git(checkout, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status) fail(`The review checkout ${checkout} has local changes; it must stay clean.`);
}

async function review(args) {
  const config = readController();
  const restore = args.includes("--restore-previous");
  const fresh = args.includes("--fresh");
  const target = args.find((arg) => !arg.startsWith("--"));
  if (!restore && !target)
    fail("Usage: pnpm dev:app:review <#123 | branch | commit:<sha>> [--fresh]");
  const ref = restore ? null : parseReviewRef(target);
  const sha = ref ? resolveRefSha(config.checkout, ref) : null;
  if (sha) assertProtocol(config.checkout, sha);

  await withOperationLock(restore ? "restore" : `review ${ref.label}`, async () => {
    await stopApp(config);
    assertCleanCheckout(config.checkout);
    let next;
    if (restore) {
      const current = readJsonFile(paths.reviewPath);
      if (!current) fail("Nothing has been reviewed yet.");
      const restoredSha = restoreProfileSnapshot(paths.profilesDir, current.profileId);
      next = { ...current, sha: restoredSha };
      log(`restored ${current.profileId} to its state before ${current.sha.slice(0, 12)}`);
    } else {
      const choice = chooseProfile({
        profilesDir: paths.profilesDir,
        ref,
        sha,
        fresh,
        isAncestor: (ancestor, descendant) =>
          git(config.checkout, ["merge-base", "--is-ancestor", ancestor, descendant], {
            allowFailure: true,
          }) !== null,
      });
      if (choice.action === "replace") {
        log(`starting ${choice.id} fresh; the previous state is kept as a retired copy`);
        retireProfile(paths.profilesDir, choice.id);
      }
      if (choice.action !== "reuse") createProfile(paths.profilesDir, { id: choice.id, ref });
      else if (choice.previousSha !== sha) {
        log(`saving ${choice.id} before running newer code on it`);
        snapshotProfile(paths.profilesDir, choice.id);
      }
      next = { ref: ref.label, sha, profileId: choice.id };
    }
    git(config.checkout, ["checkout", "--quiet", "--detach", next.sha]);
    await ensureInstalled(config.checkout, config);
    writeJsonAtomic(paths.reviewPath, { ...next, at: new Date().toISOString() });
    pruneProfiles(paths.profilesDir, next.profileId);
    await startApp(config);
  });
}

async function status() {
  const config = readController();
  const current = readJsonFile(paths.reviewPath);
  const launch = readJsonFile(paths.launchPath);
  const answer = launch ? await askApp(launch, "status") : null;
  const state = answer
    ? answer.ready
      ? "ready"
      : "starting"
    : launch
      ? "not answering"
      : "stopped";
  log(`${APP_NAME}: ${state}`);
  if (current)
    log(`reviewing ${current.ref} at ${current.sha.slice(0, 12)} (profile ${current.profileId})`);
  log(`checkout ${config.checkout}`);
  log(`logs ${paths.logPath}`);
}

async function open() {
  const config = readController();
  const launch = readJsonFile(paths.launchPath);
  if (launch && (await askApp(launch, "activate"))) return;
  const owner = selfOwner("open");
  const lock = tryAcquireLock(paths.operationLockPath, owner, { ownerState });
  if (!lock.acquired) {
    log(`${APP_NAME} is switching; it opens when ready.`);
    return;
  }
  try {
    await startApp(config);
  } finally {
    releaseLock(paths.operationLockPath, owner);
  }
}

// ── runner (Windows, inside the launch job) ───────────────────────────────

async function runner() {
  const launch = readJsonFile(paths.launchPath);
  if (!launch) fail("No launch was prepared; the runner only starts from the controller.");
  if (!validateProfileRoot(paths.profilesDir, launch.profileRoot))
    fail("Invalid profile; launch refused.");
  const owner = selfOwner("runner");
  const lock = tryAcquireLock(paths.runnerLockPath, owner, { ownerState });
  if (!lock.acquired) fail("Another runner is already active.");
  const logFd = NodeFS.openSync(paths.logPath, "a");
  try {
    NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(launch.checkout, "scripts", "stage-whisper-runtime.ts"), "--dev-cache-only"],
      { cwd: launch.checkout, stdio: "ignore", timeout: 30_000, windowsHide: true },
    );
    const binDir = NodePath.join(launch.checkout, "node_modules", ".bin");
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        NodePath.join(launch.checkout, "scripts", "dev-runner.ts"),
        "dev:desktop",
        "--home-dir",
        launch.profileRoot,
      ],
      {
        cwd: launch.checkout,
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
        env: {
          ...process.env,
          [pathKey]: `${binDir}${NodePath.delimiter}${process.env[pathKey] ?? ""}`,
          ...launchEnvironment(readController(), launch),
        },
      },
    );
    let wasReady = false;
    let unreachableSince = null;
    const watch = setInterval(async () => {
      const answer = await askApp(launch, "status", 2_000);
      if (answer?.ready) wasReady = true;
      if (answer) unreachableSince = null;
      else if (wasReady) unreachableSince ??= Date.now();
      // The user quit the app: end the launch (the job host clears the rest).
      if (unreachableSince !== null && Date.now() - unreachableSince > RUNNER_APP_GONE_MS) {
        releaseLock(paths.runnerLockPath, owner);
        process.exit(0);
      }
    }, 2_000);
    const code = await new Promise((resolve) =>
      child.once("exit", (exitCode) => resolve(exitCode)),
    );
    clearInterval(watch);
    process.exitCode = code ?? 1;
  } finally {
    NodeFS.closeSync(logFd);
    releaseLock(paths.runnerLockPath, owner);
  }
}

// ── install / uninstall ───────────────────────────────────────────────────

const MANAGEMENT_ENTRIES = new Set([
  "controller",
  "profiles",
  "dev-app-runtime",
  "review.json",
  "operation.lock",
  "local-dev-app-runtime",
  "local-dev-app-runner",
]);

/** A stable app from before profiles kept its state in the root; it becomes a profile. */
function adoptLegacyState() {
  if (!NodeFS.existsSync(paths.root)) return null;
  const legacy = NodeFS.readdirSync(paths.root).filter(
    (name) =>
      !MANAGEMENT_ENTRIES.has(name) &&
      !name.startsWith("local-dev-app.log") &&
      !name.startsWith("node_modules-aside-"),
  );
  if (legacy.length === 0) return null;
  const ref = parseReviewRef("main");
  const id = "legacy-stable";
  const profile = createProfile(paths.profilesDir, { id, ref });
  for (const name of legacy) {
    NodeFS.renameSync(NodePath.join(paths.root, name), NodePath.join(profile.dir, name));
  }
  return id;
}

function resolvePnpm() {
  const fromEnv = process.env.npm_execpath?.trim();
  if (fromEnv && /pnpm/u.test(NodePath.basename(fromEnv))) return fromEnv;
  fail(
    "Run the install through pnpm (pnpm dev:app:stable install) so the controller can find pnpm.",
  );
}

function readExistingBundleIdSuffix() {
  if (hostPlatform !== "darwin") return null;
  const plist = NodePath.join(
    NodeOS.homedir(),
    "Applications",
    `${APP_NAME}.app`,
    "Contents",
    "Info.plist",
  );
  const result = NodeChildProcess.spawnSync(
    "plutil",
    ["-extract", "CFBundleIdentifier", "raw", plist],
    {
      encoding: "utf8",
    },
  );
  const id = result.status === 0 ? result.stdout.trim() : "";
  const prefix = "com.scientfactory.scient.next.dev.";
  return id.startsWith(prefix) ? id.slice(prefix.length) : null;
}

async function install(args) {
  const checkoutArg = args.indexOf("--checkout");
  const previous = readJsonFile(paths.controllerConfigPath);
  const leftovers = findProcessesUnder([paths.root, ...(previous ? [previous.checkout] : [])]);
  if (leftovers === null || leftovers.length > 0) {
    fail(`Stop the running stable dev app first (pnpm dev:app:stop --stable in its checkout).`);
  }
  let checkout;
  if (checkoutArg !== -1) {
    checkout = NodePath.resolve(args[checkoutArg + 1] ?? fail("--checkout needs a path."));
    git(checkout, ["rev-parse", "--is-inside-work-tree"]);
  } else if (previous?.checkout && NodeFS.existsSync(previous.checkout)) {
    checkout = previous.checkout;
  } else {
    checkout = NodePath.join(NodeOS.homedir(), "scient-dev-stable");
    if (!NodeFS.existsSync(checkout)) {
      git(sourceRoot, ["worktree", "add", "--detach", checkout, "HEAD"]);
    }
  }
  assertCleanCheckout(checkout);

  await withOperationLock("install", async () => {
    NodeFS.rmSync(paths.controllerDir, { recursive: true, force: true });
    for (const file of CONTROLLER_FILES) {
      const target = NodePath.join(paths.controllerDir, file);
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      NodeFS.copyFileSync(NodePath.join(sourceRoot, file), target);
    }
    NodeFS.writeFileSync(jobScriptPath, WINDOWS_JOB_SCRIPT);
    const bundleIdSuffix = previous?.bundleIdSuffix ?? readExistingBundleIdSuffix();
    writeJsonAtomic(paths.controllerConfigPath, {
      protocol: DEV_APP_PROTOCOL,
      sourceSha: git(sourceRoot, ["rev-parse", "HEAD"]),
      checkout,
      pnpm: previous?.pnpm ?? resolvePnpm(),
      ...(bundleIdSuffix ? { bundleIdSuffix } : {}),
      installedAt: new Date().toISOString(),
    });
    if (hostPlatform === "darwin") retireMacServices();
    const adopted = adoptLegacyState();
    if (adopted) {
      log(`kept the earlier stable app's state as profile ${adopted}`);
      writeJsonAtomic(paths.reviewPath, {
        ref: "main",
        sha: git(checkout, ["rev-parse", "HEAD"]),
        profileId: adopted,
        at: new Date().toISOString(),
      });
    }
    if (hostPlatform === "win32") installWindowsLaunchers(checkout);
  });
  log(`installed; review checkout ${checkout}`);
  log("next: pnpm dev:app:review <#123 | branch | commit:<sha>>");
}

/**
 * Before the controller, a stable app followed origin/main through its own
 * LaunchAgent, and each stable checkout had a service of its own. Neither may
 * start the app behind the controller's back.
 */
function retireMacServices() {
  const domain = `gui/${String(process.getuid?.() ?? 0)}`;
  const plists = [
    NodePath.join(
      NodeOS.homedir(),
      "Library",
      "LaunchAgents",
      "com.scientfactory.scient-dev-stable-sync.plist",
    ),
  ];
  const runtime = NodePath.join(paths.root, "local-dev-app-runtime");
  if (NodeFS.existsSync(runtime)) {
    for (const name of NodeFS.readdirSync(runtime)) {
      if (name.startsWith("com.scientfactory.scient-dev-app.stable.") && name.endsWith(".plist")) {
        plists.push(NodePath.join(runtime, name));
      }
    }
  }
  for (const plist of plists.filter((path) => NodeFS.existsSync(path))) {
    NodeChildProcess.spawnSync("launchctl", ["bootout", domain, plist], { stdio: "ignore" });
    NodeFS.rmSync(plist, { force: true });
    log(`retired ${NodePath.basename(plist, ".plist")}`);
  }
}

function installWindowsLaunchers(checkout) {
  const conhost = NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "conhost.exe");
  const powershell = NodePath.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const user = `${process.env.USERDOMAIN ?? NodeOS.hostname()}\\${process.env.USERNAME ?? NodeOS.userInfo().username}`;
  registerScheduledTask(
    taskName,
    scheduledTaskXml({
      userId: user,
      command: conhost,
      args: [
        "--headless",
        powershell,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        jobScriptPath,
        "host",
        paths.launchPath,
      ]
        .map(quoteWindowsArgument)
        .join(" "),
      workingDirectory: paths.root,
      description: `${APP_NAME}: runs the reviewed checkout inside one job, with no console windows.`,
    }),
    paths.root,
  );
  const icon = NodePath.join(paths.controllerDir, "icon.ico");
  const sourceIcon = NodePath.join(checkout, "apps", "desktop", "resources", "icon.ico");
  if (NodeFS.existsSync(sourceIcon)) NodeFS.copyFileSync(sourceIcon, icon);
  writeStartMenuShortcut({
    path: startMenuShortcutPath(APP_NAME),
    target: conhost,
    args: [
      "--headless",
      process.execPath,
      NodePath.join(paths.controllerDir, "scripts", "dev-app", "controller.mjs"),
      "open",
    ]
      .map(quoteWindowsArgument)
      .join(" "),
    workingDirectory: paths.root,
    icon: NodeFS.existsSync(icon) ? icon : null,
  });
}

async function uninstall() {
  const config = readController();
  await withOperationLock("uninstall", async () => {
    await stopApp(config);
    if (hostPlatform === "win32") {
      deleteScheduledTask(taskName);
      NodeFS.rmSync(startMenuShortcutPath(APP_NAME), { force: true });
    } else {
      localDevApp(config, ["uninstall"]);
    }
    NodeFS.rmSync(paths.controllerDir, { recursive: true, force: true });
  });
  log(
    `uninstalled. Profiles stay in ${paths.profilesDir}; the checkout stays at ${config.checkout}.`,
  );
}

// ── entry ─────────────────────────────────────────────────────────────────

/** Repository scripts run the installed copy, never the checkout's own. */
function delegateToInstalledController(argv) {
  const installed = NodePath.join(paths.controllerDir, "scripts", "dev-app", "controller.mjs");
  const self = NodeURL.fileURLToPath(import.meta.url);
  if (argv[0] === "install" || !NodeFS.existsSync(installed)) return false;
  if (NodePath.resolve(installed) === NodePath.resolve(self)) return false;
  const result = NodeChildProcess.spawnSync(process.execPath, [installed, ...argv], {
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
  return true;
}

async function main(argv) {
  if (delegateToInstalledController(argv)) return;
  const [command, ...args] = argv;
  if (command === "review") return review(args);
  if (command === "install") return install(args);
  if (command === "start") {
    const config = readController();
    const cold = args.find((arg) => arg.startsWith("--cold-handoff="));
    return withOperationLock("start", () =>
      startApp(config, { coldHandoff: cold?.slice("--cold-handoff=".length) }),
    );
  }
  if (command === "stop") {
    const config = readController();
    return withOperationLock("stop", () => stopApp(config));
  }
  if (command === "status") return status();
  if (command === "logs") return printLogs();
  if (command === "open") return open();
  if (command === "runner") return runner();
  if (command === "uninstall") return uninstall();
  fail(
    "Usage: pnpm dev:app:review <ref> [--fresh] | --restore-previous\n       pnpm dev:app:stable <install|start|stop|status|logs|open|uninstall>",
  );
}

if (NodePath.resolve(process.argv[1] ?? "") === NodeURL.fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2).filter((arg) => arg !== "--")).catch((error) => {
    console.error(`[dev-app] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
