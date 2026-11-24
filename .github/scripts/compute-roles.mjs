// SCIENT-FORK:START — Compute roles that share one runner, each from a clean start: `begin`
// gives a role its own temporary files; `end` stops its leftover processes and removes what it
// added to per-user directories, the checkout and a saved Python. `summary` names failed roles.
// Steps of role `r` have ids `r` (begin), `r-*` and `end-r`; STEPS is the job's toJSON(steps).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const ROLES = {
  people: "R and Julia on what people have",
  files: "Real files and this computer's scan",
  kernels: "Real R and Julia kernels",
  managed: "Managed Python toolkits",
  python: "Real Python kernels",
};

// Where tools keep per-user state; an entry a role adds directly inside one is removed after it.
export const HOME_PARENTS = [
  ".",
  ".cache",
  ".config",
  ".local",
  ".local/share",
  ".local/state",
  "Library",
  "Library/Caches",
  "Library/Application Support",
  "AppData/Local",
  "AppData/Roaming",
];

// macOS services that launchd starts for the runner's user; never a role's own process.
const DARWIN_SYSTEM = ["/System/", "/usr/libexec/", "/usr/sbin/", "/usr/bin/", "/sbin/"];

const run = (command, args, options = {}) =>
  NodeChildProcess.execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

const stateFile = (env, name) => NodePath.join(env.RUNNER_TEMP, "compute-roles", `${name}.json`);
// Short, so paths under it stay well within Windows' and Unix sockets' length limits.
export const roleTemp = (env, role) => NodePath.join(env.RUNNER_TEMP, "cr", role);

export function parseUnixProcesses(text) {
  return text
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map(([, pid, ppid, uid, command]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      uid: Number(uid),
      command: command.trim(),
      key: `${pid} ${command.trim()}`,
    }));
}

export function parseWindowsProcesses(text) {
  const parsed = JSON.parse(text || "[]");
  return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
    pid: Number(entry.pid),
    ppid: Number(entry.ppid),
    uid: null,
    command: entry.command ?? "",
    key: `${entry.pid} ${entry.created}`,
  }));
}

const WINDOWS_LIST = String.raw`Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; command = $_.ExecutablePath;
    created = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 } } } |
  ConvertTo-Json -Compress`;
const powershell = (script) =>
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);

function listProcesses(platform) {
  if (platform === "win32") return parseWindowsProcesses(powershell(WINDOWS_LIST));
  return parseUnixProcesses(run("ps", ["-A", "-o", "pid=,ppid=,uid=,comm="]));
}

/** Processes started since `before` that the role owns: not this process or its ancestors. */
export function leftovers({ before, after, self, uid, platform, systemRoot = "" }) {
  const known = new Set(before.map((entry) => entry.key));
  const byPid = new Map(after.map((entry) => [entry.pid, entry]));
  const keep = new Set();
  for (let pid = self; pid > 0 && !keep.has(pid); pid = byPid.get(pid)?.ppid ?? 0) keep.add(pid);
  const system =
    platform === "win32"
      ? (command) => !command || command.toLowerCase().startsWith(`${systemRoot.toLowerCase()}\\`)
      : platform === "darwin"
        ? (command) => DARWIN_SYSTEM.some((prefix) => command.startsWith(prefix))
        : () => false;
  return after.filter(
    (entry) =>
      !known.has(entry.key) &&
      !keep.has(entry.pid) &&
      (entry.uid === null || entry.uid === uid) &&
      !system(entry.command),
  );
}

// Windows lists every user's processes; keep the ones this user started.
function ownedOnWindows(candidates, user) {
  if (candidates.length === 0) return [];
  const owners = JSON.parse(
    powershell(
      `@(${candidates.map((entry) => entry.pid).join(",")}) | ForEach-Object { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$_"; if ($p) { [pscustomobject]@{ pid = $_; user = (Invoke-CimMethod -InputObject $p -MethodName GetOwner).User } } } | ConvertTo-Json -Compress`,
    ) || "[]",
  );
  const mine = new Set(
    (Array.isArray(owners) ? owners : [owners])
      .filter((owner) => owner.user?.toLowerCase() === user.toLowerCase())
      .map((owner) => Number(owner.pid)),
  );
  return candidates.filter((entry) => mine.has(entry.pid));
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

async function stop(processes, platform) {
  if (platform === "win32") {
    for (const { pid } of processes)
      NodeChildProcess.spawnSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
    return;
  }
  const signal = (name) => {
    for (const { pid } of processes)
      try {
        process.kill(pid, name);
      } catch {
        // Already gone.
      }
  };
  signal("SIGTERM");
  for (let waited = 0; waited < 5000 && processes.some(({ pid }) => alive(pid)); waited += 100)
    await new Promise((resolve) => setTimeout(resolve, 100));
  signal("SIGKILL");
}

export function homeEntries(home, parents = HOME_PARENTS) {
  return parents.flatMap((parent) => {
    try {
      return NodeFS.readdirSync(NodePath.join(home, parent)).map((name) =>
        NodePath.join(parent, name),
      );
    } catch {
      return [];
    }
  });
}

/** Entries added since `before`, skipping those inside another added entry. */
export function addedEntries(before, after) {
  const known = new Set(before);
  const added = after.filter((entry) => !known.has(entry)).toSorted();
  return added.filter(
    (entry) => !added.some((other) => other !== entry && entry.startsWith(other + NodePath.sep)),
  );
}

// `git status -z`: "XY path", and a rename's original path as the following entry.
export function parseStatus(text) {
  const fields = text.split("\0").filter(Boolean);
  const entries = [];
  for (let index = 0; index < fields.length; index++) {
    const code = fields[index].slice(0, 2);
    entries.push({ code, path: fields[index].slice(3) });
    if (code.includes("R") || code.includes("C")) index++;
  }
  return entries;
}

const status = (cwd) =>
  parseStatus(run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd }));

const pythonPackages = (python) =>
  JSON.parse(
    run(python, ["-m", "pip", "list", "--format=json", "--disable-pip-version-check"]),
  ).map((entry) => entry.name.toLowerCase().replace(/[-_.]+/g, "-"));

const option = (args, name) => {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1];
};

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone CI script with no Effect runtime; tests pass the platform explicitly.
const platform = process.platform;
// The system the roles run on; tests replace it.
const host = {
  platform,
  home: () => NodeOS.homedir(),
  processes: () => listProcesses(platform),
  stop: (processes) => stop(processes, platform),
  owned: (processes) =>
    platform === "win32" ? ownedOnWindows(processes, NodeOS.userInfo().username) : processes,
  python: () => run("python", ["-c", "import sys; print(sys.executable)"]).trim(),
  packages: (python) => pythonPackages(python),
  uninstall: (python, names) =>
    run(python, ["-m", "pip", "uninstall", "-y", "--disable-pip-version-check", ...names], {
      stdio: "inherit",
    }),
};

export function begin(role, args, env, system = host) {
  const temp = roleTemp(env, role);
  NodeFS.rmSync(temp, { recursive: true, force: true });
  NodeFS.mkdirSync(temp, { recursive: true });
  NodeFS.mkdirSync(NodePath.dirname(stateFile(env, role)), { recursive: true });
  // Later steps, until the next role begins, see only this role's temporary files.
  NodeFS.appendFileSync(
    env.GITHUB_ENV,
    ["TMPDIR", "TMP", "TEMP"].map((name) => `${name}=${temp}\n`).join(""),
  );
  const saved = option(args, "--save-python");
  if (saved) {
    const python = system.python();
    NodeFS.writeFileSync(
      stateFile(env, `python-${saved}`),
      JSON.stringify({ python, packages: system.packages(python) }),
    );
  }
  NodeFS.writeFileSync(
    stateFile(env, role),
    JSON.stringify({
      processes: system.processes(),
      home: homeEntries(system.home()),
      checkout: status(env.GITHUB_WORKSPACE).map((entry) => `${entry.code} ${entry.path}`),
    }),
  );
  console.log(`${ROLES[role] ?? role}: temporary files in ${temp}`);
}

export async function end(role, args, env, system = host) {
  const before = JSON.parse(NodeFS.readFileSync(stateFile(env, role), "utf8"));
  const left = system.owned(
    leftovers({
      before: before.processes,
      after: system.processes(),
      self: process.pid,
      uid: system.platform === "win32" ? null : process.getuid(),
      platform: system.platform,
      systemRoot: env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows",
    }),
  );
  for (const entry of left)
    console.log(`::warning::${ROLES[role] ?? role} left ${entry.command} (${entry.pid}) running`);
  await system.stop(left);

  const home = system.home();
  for (const entry of addedEntries(before.home, homeEntries(home))) {
    console.log(`Removing ~/${entry}, which ${ROLES[role] ?? role} added`);
    try {
      NodeFS.rmSync(NodePath.join(home, entry), { recursive: true, force: true });
    } catch (error) {
      console.log(`::warning::Could not remove ~/${entry}: ${error.message}`);
    }
  }

  const cwd = env.GITHUB_WORKSPACE;
  const known = new Set(before.checkout);
  const changed = status(cwd).filter((entry) => !known.has(`${entry.code} ${entry.path}`));
  const tracked = changed.filter((entry) => entry.code !== "??").map((entry) => entry.path);
  if (tracked.length) run("git", ["checkout", "--", ...tracked], { cwd });
  for (const entry of changed.filter((entry) => entry.code === "??"))
    NodeFS.rmSync(NodePath.join(cwd, entry.path), { recursive: true, force: true });
  for (const entry of changed) console.log(`Restored ${entry.path} in the checkout`);

  const restored = option(args, "--restore-python");
  if (restored) {
    const { python, packages } = JSON.parse(
      NodeFS.readFileSync(stateFile(env, `python-${restored}`), "utf8"),
    );
    const added = system.packages(python).filter((name) => !packages.includes(name));
    if (added.length) system.uninstall(python, added);
    const now = system.packages(python);
    if (now.length !== packages.length || now.some((name) => !packages.includes(name)))
      throw new Error(`${python} did not return to its packages: ${now.join(", ")}`);
  }
  NodeFS.rmSync(roleTemp(env, role), { recursive: true, force: true });
}

/** Each expected role's result: passed, failed (with its failed steps) or did not run. */
export function summarize(expected, steps) {
  return expected.map((role) => {
    const own = Object.entries(steps).filter(
      ([id]) => id === role || id.startsWith(`${role}-`) || id === `end-${role}`,
    );
    const failed = own.filter(([, step]) => step.outcome === "failure").map(([id]) => id);
    const ran =
      steps[role]?.outcome !== undefined &&
      steps[role].outcome !== "skipped" &&
      own.every(([, step]) => step.outcome !== "skipped");
    return { role, label: ROLES[role] ?? role, ran, failed };
  });
}

export function summary(env) {
  const expected = (env.EXPECTED ?? "").split(/\s+/).filter(Boolean);
  const results = summarize(expected, JSON.parse(env.STEPS || "{}"));
  const lines = ["| Role | Result |", "| --- | --- |"];
  for (const { label, ran, failed } of results) {
    const result = failed.length ? `failed: ${failed.join(", ")}` : ran ? "passed" : "did not run";
    lines.push(`| ${label} | ${result} |`);
    if (failed.length || !ran) console.log(`::error title=${label}::${result}`);
  }
  if (env.GITHUB_STEP_SUMMARY)
    NodeFS.appendFileSync(env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  // A failed role already failed its own step; a role that never ran fails here.
  if (results.some((result) => !result.ran)) process.exitCode = 1;
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const [command, role, ...args] = process.argv.slice(2);
  if (command === "summary") summary(process.env);
  else if (!Object.hasOwn(ROLES, role ?? "")) throw new Error(`Unknown Compute role: ${role}`);
  else if (command === "begin") begin(role, args, process.env);
  else if (command === "end") await end(role, args, process.env);
  else throw new Error("Use begin <role>, end <role> or summary.");
}
// SCIENT-FORK:END
