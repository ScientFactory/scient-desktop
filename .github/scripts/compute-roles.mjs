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
// settings, `pip --user` sites and R's default user libraries. Every role starts from, and each end
// puts back, the copy taken when the first role began.
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
      created: null,
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
    created: Number(entry.created),
    key: `${entry.pid} ${entry.created}`,
  }));
}

const WINDOWS_LIST = String.raw`Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; command = $_.ExecutablePath;
    created = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 } } } |
  ConvertTo-Json -Compress`;
const powershell = (script) =>
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);

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

// launchd's own jobs, such as Spotlight's on-demand mdworker_shared: launchd started them.
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
 * where the environment can be read, null where it cannot (Windows, Apple's programs on macOS).
 */
function listProcesses(platform, owner) {
  if (platform === "win32") return parseWindowsProcesses(powershell(WINDOWS_LIST));
  const entries = parseUnixProcesses(run("ps", ["-A", "-o", "pid=,ppid=,uid=,comm="]));
  if (!owner) return entries;
  const mark = `${OWNER_VARIABLE}=${owner}`;
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
 * Processes this user started since `before` that the role owns: those carrying its mark, children
 * of those it owns, and orphans (only role steps leave any) the service manager did not start.
 * Never this step's own process tree, which includes the process lister.
 */
export function leftovers({ before, after, self, uid }) {
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
  const owned = new Map();
  const owns = (entry) => {
    if (owned.has(entry.pid)) return owned.get(entry.pid);
    owned.set(entry.pid, false);
    let result = false;
    if (
      !known.has(entry.key) &&
      !step.has(entry.pid) &&
      (entry.uid === null || entry.uid === uid) &&
      !entry.service
    ) {
      // A pid reused after its real parent exited is not the parent.
      const candidate = byPid.get(entry.ppid);
      const parent =
        candidate && entry.ppid > 1 && !(candidate.created > entry.created) ? candidate : null;
      result = entry.marked === true || (parent ? owns(parent) : true);
    }
    owned.set(entry.pid, result);
    return result;
  };
  return after.filter((entry) => owns(entry));
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

/** Each package's version in an R library: its folder name and DESCRIPTION's Version field. */
export function rPackages(library) {
  let names = [];
  try {
    names = NodeFS.readdirSync(library).toSorted();
  } catch {
    return {};
  }
  return Object.fromEntries(
    names.map((name) => {
      try {
        const description = NodeFS.readFileSync(
          NodePath.join(library, name, "DESCRIPTION"),
          "utf8",
        );
        return [name, /^Version:\s*(\S+)/m.exec(description)?.[1] ?? ""];
      } catch {
        return [name, ""];
      }
    }),
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
      return run("Rscript", ["--vanilla", "-e", 'cat(.libPaths(), sep = "\\n")'])
        .split("\n")
        .filter(Boolean);
    } catch {
      return [];
    }
  },
};

/** Saved when the first role begins: what setup left in HOME_STATE and in R's libraries. */
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
  const libraries = [
    ...new Map(
      [...(rUser ? [rUser] : []), ...system.rLibraries()].map((library) => [
        NodePath.resolve(library),
        library,
      ]),
    ).values(),
  ];
  const setup = {
    home: saved,
    rUser,
    rLibraries: Object.fromEntries(libraries.map((library) => [library, rPackages(library)])),
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
  const lines = [...["TMPDIR", "TMP", "TEMP"].map((name) => [name, temp]), [OWNER_VARIABLE, owner]];
  // The role's own R user library, seeded with the one setup made; the latter is never written.
  if (setup.rUser) {
    const library = NodePath.join(temp, "R-library");
    if (NodeFS.existsSync(setup.rUser)) copy(setup.rUser, library);
    else NodeFS.mkdirSync(library, { recursive: true });
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

  const owned = () =>
    system.owned(
      leftovers({
        before: before.processes,
        after: system.processes(before.owner),
        self: process.pid,
        uid: system.platform === "win32" ? null : process.getuid(),
      }),
    );
  const left = owned();
  for (const entry of left)
    console.log(`::warning::${label} left ${entry.command} (${entry.pid}) running`);
  if (left.length) {
    await system.stop(left);
    // What was stopped, and anything carrying the role's mark started meanwhile.
    const stopped = new Set(left.map((entry) => entry.key));
    const surviving = () =>
      owned().filter((entry) => stopped.has(entry.key) || entry.marked === true);
    let survivors = surviving();
    for (let waited = 0; waited < 3000 && survivors.length; waited += 200) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      survivors = surviving();
    }
    if (survivors.length)
      problems.push(
        `processes still running after being stopped: ${survivors.map((entry) => `${entry.command} (${entry.pid})`).join(", ")}`,
      );
  }

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

  // Roles install into their own library; one that wrote into these would reach the next role.
  for (const [library, packages] of Object.entries(setup.rLibraries)) {
    const changes = packageChanges(packages, rPackages(library));
    if (changes.length)
      problems.push(`${label} changed the R library ${library}: ${changes.join(", ")}`);
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
