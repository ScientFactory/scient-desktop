// SCIENT-FORK:START — Compute roles that share one runner, each from a clean start: `begin` gives a
// role its own temporary files, R library and owner mark; `end` stops what it owns, puts per-user
// state back and checks shared packages unchanged; `summary` names roles that failed or skipped a
// proof. Steps of role `r` have ids `r` (begin), PROOFS[r] and `end-r`; STEPS is toJSON(steps).
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
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

// Every step a role must run, by id, besides its begin and end steps.
export const PROOFS = {
  people: ["people-run"],
  files: ["files-run"],
  kernels: ["kernels-install", "kernels-run"],
  managed: ["managed-seal", "managed-target", "managed-recipes", "managed-bench"],
  python: [
    "python-setup-310",
    "python-install-310",
    "python-run-310",
    "python-setup-312",
    "python-install-312",
    "python-run-312",
  ],
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

// Per-user packages and kernels a later role would find: Julia's depot, Jupyter kernels and
// settings, `pip --user` sites and R's profiles and default user libraries (Windows keeps both under
// Documents, where setup-r writes its profile). Every role starts from, and each end puts back, the
// copy taken when the first role began.
export const HOME_STATE = [
  ".julia",
  ".ipython",
  ".jupyter",
  ".local/share/jupyter",
  "Library/Jupyter",
  "AppData/Roaming/jupyter",
  ".local/lib",
  "Library/Python",
  "AppData/Roaming/Python",
  ".R",
  ".Rprofile",
  ".Renviron",
  "R",
  "Library/R",
  "AppData/Local/R",
  "Documents/.Rprofile",
  "Documents/.Renviron",
  "Documents/R",
];

// Inherited by every process a role's steps start; Scient's kernels keep it (it is not SCIENT_*).
export const OWNER_VARIABLE = "COMPUTE_ROLE_OWNER";

const run = (command, args, options = {}) =>
  NodeChildProcess.execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

const stateFile = (env, name) => NodePath.join(env.RUNNER_TEMP, "compute-roles", `${name}.json`);
const readState = (env, name) => JSON.parse(NodeFS.readFileSync(stateFile(env, name), "utf8"));
const writeState = (env, name, value) => {
  NodeFS.mkdirSync(NodePath.dirname(stateFile(env, name)), { recursive: true });
  NodeFS.writeFileSync(stateFile(env, name), JSON.stringify(value));
};
// Short, so paths under it stay well within Windows' and Unix sockets' length limits.
export const roleTemp = (env, role) => NodePath.join(env.RUNNER_TEMP, "cr", role);
const seedDirectory = (env) => NodePath.join(env.RUNNER_TEMP, "compute-roles", "seed");
// Setup's R libraries as it left them, by their index in the seed's list; roles never write here.
const savedLibrary = (env, index) => NodePath.join(seedDirectory(env), "R", String(index));
const TEMP_VARIABLES = ["TMPDIR", "TMP", "TEMP"];

// `ps -o pid=,ppid=,uid=,stat=,lstart=,comm=` in the C locale, without zombies: exited, they wait
// only to be reaped. A process is its pid and start time; an exited process's pid can be reused.
export function parseUnixProcesses(text) {
  return text
    .split("\n")
    .map((line) =>
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(line),
    )
    .filter((match) => match && !match[4].startsWith("Z"))
    .map(([, pid, ppid, uid, , started, command]) => {
      const created = Date.parse(started) / 1000;
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        uid: Number(uid),
        command: command.trim(),
        created,
        key: `${pid} ${created}`,
      };
    });
}

export function parseWindowsProcesses(text) {
  const parsed = JSON.parse(text || "[]");
  return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
    pid: Number(entry.pid),
    ppid: Number(entry.ppid),
    uid: null,
    command: entry.command ?? "",
    created: Number(entry.created),
    key: `${entry.pid} ${entry.created}`,
    ...(entry.marked === undefined
      ? {}
      : { marked: entry.marked === 1 ? true : entry.marked === 0 ? false : null }),
  }));
}

// Windows shows no process's environment to other programs; this reads it from the process's
// own memory (PEB -> RTL_USER_PROCESS_PARAMETERS, x64 offsets), as the runner's orphan cleanup
// does. 1 when it holds the entry, 0 when not, -1 when it cannot be read.
const WINDOWS_ENVIRONMENT = String.raw`Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RoleEnvironment {
  [StructLayout(LayoutKind.Sequential)]
  struct Basic { public IntPtr ExitStatus; public IntPtr Peb; public IntPtr Affinity; public IntPtr Priority; public IntPtr Pid; public IntPtr ParentPid; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int type, ref Basic info, int size, out int returned);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
  static byte[] Read(IntPtr process, IntPtr address, long size) {
    var buffer = new byte[size];
    IntPtr read;
    return ReadProcessMemory(process, address, buffer, (IntPtr)size, out read) && (long)read == size ? buffer : null;
  }
  static IntPtr Pointer(IntPtr process, IntPtr address) {
    var bytes = Read(process, address, 8);
    return bytes == null ? IntPtr.Zero : (IntPtr)BitConverter.ToInt64(bytes, 0);
  }
  public static int Holds(int pid, string entry) {
    var process = OpenProcess(0x0410, false, pid);
    if (process == IntPtr.Zero) return -1;
    try {
      var basic = new Basic();
      int returned;
      if (NtQueryInformationProcess(process, 0, ref basic, Marshal.SizeOf(basic), out returned) != 0 || basic.Peb == IntPtr.Zero) return -1;
      var parameters = Pointer(process, basic.Peb + 0x20);
      if (parameters == IntPtr.Zero) return -1;
      var block = Pointer(process, parameters + 0x80);
      var size = (long)Pointer(process, parameters + 0x3F0);
      if (block == IntPtr.Zero || size <= 0 || size > (1 << 24)) return -1;
      var bytes = Read(process, block, size);
      if (bytes == null) return -1;
      foreach (var variable in Encoding.Unicode.GetString(bytes).Split('\0'))
        if (variable == entry) return 1;
      return 0;
    } finally { CloseHandle(process); }
  }
}
'@`;
const windowsList = (marked) => String.raw`Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; command = $_.ExecutablePath;
    created = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }${marked ? "; marked = [RoleEnvironment]::Holds([int]$_.ProcessId, $env:COMPUTE_ROLE_MARK)" : ""} } } |
  ConvertTo-Json -Compress`;
const powershell = (script, env) =>
  run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    env ? { env: { ...process.env, ...env } } : {},
  );

const environOnLinux = (pid) => {
  try {
    return NodeFS.readFileSync(`/proc/${pid}/environ`, "latin1").split("\0");
  } catch {
    return null;
  }
};

const commandLines = (args) =>
  new Map(
    run("ps", ["-A", ...args, "-ww", "-o", "pid=,command="])
      .split("\n")
      .map((line) => /^\s*(\d+) (.*)$/.exec(line))
      .filter(Boolean)
      .map(([, pid, line]) => [Number(pid), line]),
  );

// `ps -E` appends a process's environment to its command line. macOS shows it for the user's own
// programs but not for Apple's (/bin, /usr/bin and the like): there the two lines are the same.
function environOnDarwin() {
  const plain = commandLines([]);
  const byPid = new Map();
  for (const [pid, line] of commandLines(["-E"])) {
    const command = plain.get(pid);
    if (command !== undefined && line.length > command.length && line.startsWith(command))
      byPid.set(pid, line.slice(command.length).trim().split(" "));
  }
  return byPid;
}

// launchd's own jobs, such as Spotlight's on-demand mdworker_shared: not worth a warning.
const launchdJobs = () =>
  new Set(
    run("launchctl", ["list"])
      .split("\n")
      .map((line) => /^(\d+)\s/.exec(line)?.[1])
      .filter(Boolean)
      .map(Number),
  );

/**
 * The processes, each marked with whether it carries `owner` in its environment: true or false
 * where the environment can be read, null where it cannot (Apple's programs on macOS, and any
 * process Windows will not open).
 */
function listProcesses(platform, owner) {
  const mark = `${OWNER_VARIABLE}=${owner}`;
  if (platform === "win32")
    return parseWindowsProcesses(
      owner
        ? powershell(`${WINDOWS_ENVIRONMENT}\n${windowsList(true)}`, { COMPUTE_ROLE_MARK: mark })
        : powershell(windowsList(false)),
    );
  const entries = parseUnixProcesses(
    run("ps", ["-A", "-o", "pid=,ppid=,uid=,stat=,lstart=,comm="], {
      env: { ...process.env, LC_ALL: "C" },
    }),
  );
  if (!owner) return entries;
  const darwin = platform === "darwin" ? environOnDarwin() : null;
  const services = platform === "darwin" ? launchdJobs() : new Set();
  return entries.map((entry) => {
    const environ = darwin ? darwin.get(entry.pid) : environOnLinux(entry.pid);
    return {
      ...entry,
      marked: environ ? environ.includes(mark) : null,
      service: services.has(entry.pid),
    };
  });
}

/**
 * This user's new processes outside this step's tree. `owned`: marked, recorded owned, or the child
 * of an owned parent seen with it. `unverified`: other orphans (OS helpers, Apple's programs hiding
 * their environment, a child whose parent's pid may since be reused) and their children: reported.
 */
export function leftovers({ before, after, self, uid, recorded = new Map() }) {
  const known = new Set(before.map((entry) => entry.key));
  const byPid = new Map(after.map((entry) => [entry.pid, entry]));
  const step = new Set();
  for (let pid = self; pid > 0 && !step.has(pid); pid = byPid.get(pid)?.ppid ?? 0) step.add(pid);
  for (const queue = [self]; queue.length;) {
    const parent = queue.pop();
    for (const entry of after)
      if (entry.ppid === parent && !step.has(entry.pid)) {
        step.add(entry.pid);
        queue.push(entry.pid);
      }
  }
  // Started after the given pid's process: a pid reused after the real parent exited is not it.
  const startedAfter = (entry, parent) => !(parent.created > entry.created);
  const parentOf = (entry) => {
    const candidate = byPid.get(entry.ppid);
    return candidate && entry.ppid > 1 && startedAfter(entry, candidate) ? candidate : null;
  };
  const candidate = (entry) =>
    !known.has(entry.key) && !step.has(entry.pid) && (entry.uid === null || entry.uid === uid);
  const verdicts = new Map();
  // "owned", "unverified" or "other".
  const verdict = (entry) => {
    if (verdicts.has(entry.pid)) return verdicts.get(entry.pid);
    verdicts.set(entry.pid, "other");
    let result = "other";
    if (candidate(entry)) {
      const parent = parentOf(entry);
      const inherited = parent ? verdict(parent) : null;
      if (entry.marked === true || recorded.has(entry.key) || inherited === "owned")
        result = "owned";
      else if ((!parent || inherited === "unverified") && !entry.service) result = "unverified";
    }
    verdicts.set(entry.pid, result);
    return result;
  };
  return {
    owned: after.filter((entry) => verdict(entry) === "owned"),
    unverified: after.filter((entry) => verdict(entry) === "unverified"),
  };
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

const signalProcess = (pid, name, platform) => {
  if (platform === "win32")
    NodeChildProcess.spawnSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
  else
    try {
      process.kill(pid, name);
    } catch {
      // Already gone.
    }
};

/**
 * Asks `processes` to stop, then forces any left. Each signal goes only to those still the same
 * process (pid and start time) just before it: an exited process's pid can be reused.
 */
export async function stop(
  processes,
  platform,
  {
    list = () => listProcesses(platform),
    signal = (pid, name) => signalProcess(pid, name, platform),
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  const running = () => {
    const current = new Set(list().map((entry) => entry.key));
    return processes.filter((entry) => current.has(entry.key));
  };
  const send = (name) => {
    for (const { pid } of running()) signal(pid, name);
  };
  if (platform !== "win32") {
    send("SIGTERM");
    for (let waited = 0; waited < 5000 && running().length; waited += 100) await wait(100);
  }
  send("SIGKILL");
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

// Julia makes installed artifacts read-only, which a plain recursive removal cannot delete.
function remove(path) {
  try {
    NodeFS.rmSync(path, { recursive: true, force: true });
  } catch {
    const writable = (entry) => {
      const stat = NodeFS.lstatSync(entry);
      if (!stat.isDirectory()) return;
      NodeFS.chmodSync(entry, stat.mode | 0o700);
      for (const name of NodeFS.readdirSync(entry)) writable(NodePath.join(entry, name));
    };
    writable(path);
    NodeFS.rmSync(path, { recursive: true, force: true });
  }
}

const copy = (from, to) =>
  NodeFS.cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });

/** Puts each HOME_STATE entry back as the seed saved it, or removes it where there was none. */
function restoreHomeState(env, home, seed) {
  for (const [index, entry] of HOME_STATE.entries()) {
    const target = NodePath.join(home, ...entry.split("/"));
    const saved = NodePath.join(seedDirectory(env), String(index));
    const had = seed.home.includes(entry);
    if (!had && !NodeFS.existsSync(target)) continue;
    remove(target);
    if (had) copy(saved, target);
  }
}

/** An installed R package's DESCRIPTION Version, or "" where there is none. */
const packageVersion = (directory) => {
  try {
    const description = NodeFS.readFileSync(NodePath.join(directory, "DESCRIPTION"), "utf8");
    return /^Version:\s*(\S+)/m.exec(description)?.[1] ?? "";
  } catch {
    return "";
  }
};

/**
 * Each package's version in an R library: its folder name and DESCRIPTION's Version field. Only
 * name and version: a package rewritten at the same version is not seen.
 */
export function rPackages(library) {
  let names = [];
  try {
    names = NodeFS.readdirSync(library).toSorted();
  } catch {
    return {};
  }
  return Object.fromEntries(
    names.map((name) => [name, packageVersion(NodePath.join(library, name))]),
  );
}

/** What changed between two `{ name: version }` package sets, as readable lines. */
export function packageChanges(before, after) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted();
  return names.flatMap((name) =>
    before[name] === after[name]
      ? []
      : [
          before[name] === undefined
            ? `${name} ${after[name]} added`
            : after[name] === undefined
              ? `${name} ${before[name]} removed`
              : `${name} ${before[name]} -> ${after[name]}`,
        ],
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
  Object.fromEntries(
    JSON.parse(
      run(python, ["-m", "pip", "list", "--format=json", "--disable-pip-version-check"]),
    ).map((entry) => [entry.name.toLowerCase().replace(/[-_.]+/g, "-"), entry.version]),
  );

// One path a line; R on Windows ends its lines with CRLF.
export const libraryPaths = (text) => text.split(/\r?\n/).filter(Boolean);

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
  processes: (owner) => listProcesses(platform, owner),
  stop: (processes) => stop(processes, platform),
  owned: (processes) =>
    platform === "win32" ? ownedOnWindows(processes, NodeOS.userInfo().username) : processes,
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  python: () => run("python", ["-c", "import sys; print(sys.executable)"]).trim(),
  packages: (python) => pythonPackages(python),
  pip: (python, args) =>
    run(python, ["-m", "pip", ...args, "--disable-pip-version-check"], { stdio: "inherit" }),
  venv: (directory) => {
    run("python", ["-m", "venv", directory], { stdio: "inherit" });
    return NodePath.join(
      directory,
      ...(platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]),
    );
  },
  // R's libraries (none without R): the user's, then the site's and R's own.
  rLibraries: () => {
    try {
      return libraryPaths(run("Rscript", ["--vanilla", "-e", 'cat(.libPaths(), sep = "\\n")']));
    } catch {
      return [];
    }
  },
};

const allows = (path, mode) => {
  try {
    NodeFS.accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
};

// The directory itself, so a copy of a symlinked library is independent of it.
const realPath = (path) => {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return NodePath.resolve(path);
  }
};

/**
 * Saved when the first role begins: what setup left in HOME_STATE, its temporary-file paths, and
 * R's libraries, with a copy of each one a role could write and of setup's user library, which
 * seeds each role's own.
 */
function seed(env, system) {
  if (NodeFS.existsSync(stateFile(env, "seed"))) return { setup: readState(env, "seed") };
  const home = system.home();
  remove(seedDirectory(env));
  NodeFS.mkdirSync(seedDirectory(env), { recursive: true });
  const saved = [];
  for (const [index, entry] of HOME_STATE.entries()) {
    const source = NodePath.join(home, ...entry.split("/"));
    if (!NodeFS.existsSync(source)) continue;
    copy(source, NodePath.join(seedDirectory(env), String(index)));
    saved.push(entry);
  }
  const rUser = env.R_LIBS_USER || null;
  // Each once, as first named: setup's user library keeps its own spelling at index 0.
  const libraries = [];
  const resolved = new Set();
  for (const library of [...(rUser ? [rUser] : []), ...system.rLibraries()])
    if (!resolved.has(realPath(library))) {
      resolved.add(realPath(library));
      libraries.push(library);
    }
  // Restorable: the ones a role could write, which an end puts back from their copy.
  const copies = [];
  for (const [index, library] of libraries.entries()) {
    if (!NodeFS.existsSync(library)) continue;
    const restorable = allows(library, NodeFS.constants.W_OK);
    const seeds = Boolean(rUser) && index === 0 && allows(library, NodeFS.constants.R_OK);
    if (!restorable && !seeds) continue;
    copy(realPath(library), savedLibrary(env, index));
    if (restorable) copies.push(library);
  }
  const fallback = env.TMPDIR || env.TEMP || env.TMP || NodeOS.tmpdir();
  const setup = {
    home: saved,
    temp: Object.fromEntries(TEMP_VARIABLES.map((name) => [name, env[name] || fallback])),
    rUser,
    rLibraries: Object.fromEntries(libraries.map((library) => [library, rPackages(library)])),
    rCopies: copies,
  };
  writeState(env, "seed", setup);
  return { setup, fresh: true };
}

export function begin(role, args, env, system = host) {
  const temp = roleTemp(env, role);
  remove(temp);
  NodeFS.mkdirSync(temp, { recursive: true });
  const { setup, fresh } = seed(env, system);
  // Normally the last role's end did this already.
  if (!fresh) restoreHomeState(env, system.home(), setup);
  const owner = `${role}-${NodeCrypto.randomUUID()}`;
  const lines = [...TEMP_VARIABLES.map((name) => [name, temp]), [OWNER_VARIABLE, owner]];
  // The role's own R user library, seeded from setup's copy, never from the live library.
  if (setup.rUser) {
    const library = NodePath.join(temp, "R-library");
    if (NodeFS.existsSync(savedLibrary(env, 0))) {
      copy(savedLibrary(env, 0), library);
      // Setup's may be read-only; the role installs into its own.
      NodeFS.chmodSync(library, NodeFS.statSync(library).mode | 0o700);
    } else NodeFS.mkdirSync(library, { recursive: true });
    lines.push(["R_LIBS_USER", library]);
  }
  // Later steps, until the next role begins, see only this role's temporary files and library.
  NodeFS.appendFileSync(
    env.GITHUB_ENV,
    lines.map(([name, value]) => `${name}=${value}\n`).join(""),
  );
  const saved = option(args, "--save-python");
  if (saved) {
    const python = system.python();
    writeState(env, `python-${saved}`, { python, packages: system.packages(python) });
  }
  writeState(env, role, {
    owner,
    processes: system.processes(),
    home: homeEntries(system.home()),
    checkout: status(env.GITHUB_WORKSPACE).map((entry) => `${entry.code} ${entry.path}`),
  });
  console.log(`${ROLES[role] ?? role}: temporary files in ${temp}`);
}

/**
 * A disposable Python environment inside the role's temporary files, which its end removes, with
 * `packages` installed; the step's `python` output names its interpreter.
 */
export function venv(role, packages, env, system = host) {
  const python = system.venv(NodePath.join(roleTemp(env, role), "venv"));
  if (packages.length) system.pip(python, ["install", ...packages]);
  NodeFS.appendFileSync(env.GITHUB_OUTPUT, `python=${python}\n`);
  console.log(`${ROLES[role] ?? role}: ${python}`);
  return python;
}

export async function end(role, args, env, system = host) {
  const label = ROLES[role] ?? role;
  const before = readState(env, role);
  const setup = readState(env, "seed");
  const problems = [];

  // Ownership found once is kept: a child outlives its parent's shutdown as the role's.
  const recorded = new Map();
  const reported = new Set();
  const find = () => {
    const { owned, unverified } = leftovers({
      before: before.processes,
      after: system.processes(before.owner),
      self: process.pid,
      uid: system.platform === "win32" ? null : process.getuid(),
      recorded,
    });
    const mine = system.owned(owned);
    for (const entry of mine) recorded.set(entry.key, entry);
    // Each once, whenever first seen: a role's process can leave one as it stops.
    for (const entry of system.owned(unverified))
      if (!reported.has(entry.key)) {
        reported.add(entry.key);
        console.log(
          `::warning::${label}: ${entry.command} (${entry.pid}) started meanwhile and lost its parent; nothing shows it is the role's, so it is left running`,
        );
      }
    return { owned: mine };
  };
  const first = find();
  for (const entry of first.owned)
    console.log(`::warning::${label} left ${entry.command} (${entry.pid}) running`);
  // Stop the owned set until none is left, re-listing it each time so children started during
  // shutdown are stopped too; whatever is still owned at the deadline fails the end.
  let remaining = first.owned;
  const stopped = new Set();
  for (let round = 0; remaining.length && round < 3; round++) {
    await system.stop(remaining);
    for (const entry of remaining) stopped.add(entry.key);
    for (let waited = 0; ; waited += 200) {
      remaining = find().owned;
      if (!remaining.length || remaining.some((entry) => !stopped.has(entry.key))) break;
      if (waited >= 3000) break;
      await system.wait(200);
    }
  }
  if (remaining.length)
    problems.push(
      `processes still running after being stopped: ${remaining.map((entry) => `${entry.command} (${entry.pid})`).join(", ")}`,
    );

  const home = system.home();
  restoreHomeState(env, home, setup);
  for (const entry of addedEntries(before.home, homeEntries(home))) {
    console.log(`Removing ~/${entry}, which ${label} added`);
    try {
      remove(NodePath.join(home, entry));
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
    remove(NodePath.join(cwd, entry.path));
  for (const entry of changed) console.log(`Restored ${entry.path} in the checkout`);

  // Roles install into their own library; one that wrote into these would reach the next role,
  // so each changed package is put back from setup's copy.
  for (const [index, [library, packages]] of Object.entries(setup.rLibraries).entries()) {
    const changes = packageChanges(packages, rPackages(library));
    if (!changes.length) continue;
    problems.push(`${label} changed the R library ${library}: ${changes.join(", ")}`);
    if (!setup.rCopies.includes(library)) continue;
    const now = rPackages(library);
    for (const name of Object.keys({ ...packages, ...now }).filter(
      (name) => packages[name] !== now[name],
    )) {
      const live = NodePath.join(library, name);
      // Setup's copy is staged and checked first: a live package goes only once it can be replaced.
      const staged = NodePath.join(library, `.${name}.restoring`);
      try {
        if (packages[name] !== undefined) {
          remove(staged);
          copy(NodePath.join(savedLibrary(env, index), name), staged);
          if (packageVersion(staged) !== packages[name])
            throw new Error(`setup's copy is ${packageVersion(staged) || "missing"}`);
        }
        remove(live);
        if (packages[name] !== undefined) NodeFS.renameSync(staged, live);
      } catch (error) {
        remove(staged);
        problems.push(`${live} could not be put back: ${error.message}`);
      }
    }
    const after = packageChanges(packages, rPackages(library));
    if (after.length) problems.push(`${library} could not be put back: ${after.join(", ")}`);
  }

  const checked = option(args, "--check-python");
  if (checked) {
    const { python, packages } = readState(env, `python-${checked}`);
    const changes = packageChanges(packages, system.packages(python));
    if (changes.length) {
      problems.push(`${label} changed ${python}: ${changes.join(", ")}`);
      // Put it back for the roles after this one, which still run.
      const now = system.packages(python);
      const added = Object.keys(now).filter((name) => packages[name] === undefined);
      if (added.length) system.pip(python, ["uninstall", "-y", ...added]);
      const differing = Object.entries(packages).filter(([name, version]) => now[name] !== version);
      if (differing.length)
        system.pip(python, [
          "install",
          "--no-deps",
          ...differing.map(([name, version]) => `${name}==${version}`),
        ]);
      const after = packageChanges(packages, system.packages(python));
      if (after.length) problems.push(`${python} could not be put back: ${after.join(", ")}`);
    }
  }
  remove(roleTemp(env, role));
  // Later steps, and the job's post steps, get setup's temporary files back.
  NodeFS.appendFileSync(
    env.GITHUB_ENV,
    TEMP_VARIABLES.map((name) => `${name}=${setup.temp[name]}\n`).join(""),
  );
  if (problems.length) throw new Error(`${label}: ${problems.join("; ")}`);
}

/** Each expected role's result: passed, failed (with its failed steps), or missing proofs. */
export function summarize(expected, steps) {
  return expected.map((role) => {
    const required = [role, ...(PROOFS[role] ?? []), `end-${role}`];
    const own = Object.entries(steps).filter(
      ([id]) => required.includes(id) || id.startsWith(`${role}-`),
    );
    const failed = own.filter(([, step]) => step.outcome === "failure").map(([id]) => id);
    const missing = required.filter(
      (id) => steps[id]?.outcome === undefined || steps[id].outcome === "skipped",
    );
    return { role, label: ROLES[role] ?? role, ran: missing.length === 0, failed, missing };
  });
}

export function summary(env) {
  const expected = (env.EXPECTED ?? "").split(/\s+/).filter(Boolean);
  const results = summarize(expected, JSON.parse(env.STEPS || "{}"));
  const lines = ["| Role | Result |", "| --- | --- |"];
  for (const { label, failed, missing } of results) {
    const result = [
      ...(failed.length ? [`failed: ${failed.join(", ")}`] : []),
      ...(missing.length ? [`did not run: ${missing.join(", ")}`] : []),
    ].join("; ");
    lines.push(`| ${label} | ${result || "passed"} |`);
    if (result) console.log(`::error title=${label}::${result}`);
  }
  if (env.GITHUB_STEP_SUMMARY)
    NodeFS.appendFileSync(env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  // A failed step already failed the job; a role or proof that never ran fails here.
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
  else if (command === "venv") venv(role, args, process.env);
  else if (command === "end") await end(role, args, process.env);
  else throw new Error("Use begin <role>, venv <role>, end <role> or summary.");
}
// SCIENT-FORK:END
