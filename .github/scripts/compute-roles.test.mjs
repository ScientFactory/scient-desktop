import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import {
  OWNER_VARIABLE,
  PROOFS,
  ROLES,
  addedEntries,
  begin,
  end,
  leftovers,
  libraryPaths,
  packageChanges,
  parseStatus,
  parseUnixProcesses,
  parseWindowsProcesses,
  roleTemp,
  summarize,
  venv,
} from "./compute-roles.mjs";

const uid = process.getuid?.() ?? 0;
const unix = (pid, ppid, user, command, extra = {}) => ({
  pid,
  ppid,
  uid: user,
  command,
  created: null,
  key: `${pid} ${command}`,
  ...extra,
});
const windows = (pid, ppid, command, created, marked = null) => ({
  pid,
  ppid,
  uid: null,
  command,
  created,
  key: `${pid} ${created}`,
  marked,
});
const pids = (entries) => entries.map((entry) => entry.pid);
// The owned and unverified pids leftovers finds.
const verdicts = (input) => {
  const { owned, unverified } = leftovers(input);
  return { owned: pids(owned), unverified: pids(unverified) };
};

NodeTest.test("reads ps and Windows process lists", () => {
  NodeAssert.deepEqual(
    parseUnixProcesses(
      "  12     1   501 Ss   /usr/sbin/cfprefsd\n 40 12 0 S+ R\n 41 40 0 Z+ (sh)\n",
    ),
    [unix(12, 1, 501, "/usr/sbin/cfprefsd"), unix(40, 12, 0, "R")],
  );
  NodeAssert.deepEqual(
    parseWindowsProcesses(
      '[{"pid":7,"ppid":4,"command":null,"created":133},{"pid":8,"ppid":7,"command":"r.exe","created":134,"marked":1},{"pid":9,"ppid":7,"command":"x.exe","created":135,"marked":-1}]',
    ),
    [
      { pid: 7, ppid: 4, uid: null, command: "", created: 133, key: "7 133" },
      windows(8, 7, "r.exe", 134, true),
      windows(9, 7, "x.exe", 135),
    ],
  );
});

NodeTest.test("never counts this step, its ancestors or the process lister it started", () => {
  // The Linux end steps once reported their own `ps` as a process the role left running.
  const before = [unix(1, 0, 0, "systemd"), unix(10, 1, 501, "Runner.Worker")];
  const after = [
    ...before,
    unix(20, 10, 501, "bash", { marked: true }),
    unix(21, 20, 501, "node", { marked: true }),
    unix(22, 21, 501, "ps", { marked: true }),
    unix(23, 22, 501, "helper", { marked: true }),
  ];
  NodeAssert.deepEqual(verdicts({ before, after, self: 21, uid: 501 }), {
    owned: [],
    unverified: [],
  });
});

NodeTest.test("on Linux, the role owns what carries its mark and what descends from it", () => {
  const before = [
    unix(1, 0, 0, "systemd"),
    unix(5, 1, 501, "systemd --user"),
    unix(10, 1, 501, "Runner.Worker"),
  ];
  const after = [
    ...before,
    unix(21, 10, 501, "node", { marked: true }),
    // A kernel left running, and its child.
    unix(30, 1, 501, "/usr/bin/R", { marked: true }),
    unix(31, 30, 501, "/usr/bin/python3", { marked: false }),
    // An orphan without the mark: pid 1 adopted it, which any program's helper can be.
    unix(32, 1, 501, "/usr/bin/sleep", { marked: false }),
    // Under a parent the role does not own: only its mark makes it the role's.
    unix(33, 5, 501, "/usr/bin/julia", { marked: true }),
    unix(34, 5, 501, "/usr/lib/dbus-daemon", { marked: false }),
    // Another user's.
    unix(35, 1, 0, "/usr/bin/sudo", { marked: null }),
    // The same pid running another program is a new process.
    unix(10, 1, 501, "python3", { marked: true }),
  ];
  NodeAssert.deepEqual(verdicts({ before, after, self: 21, uid: 501 }), {
    owned: [30, 31, 33],
    unverified: [32],
  });
});

NodeTest.test("on macOS, an orphan whose environment is hidden is only reported", () => {
  const before = [unix(1, 0, 0, "/sbin/launchd"), unix(10, 1, 501, "Runner.Worker")];
  const after = [
    ...before,
    unix(21, 10, 501, "node", { marked: true, service: false }),
    // An orphan from /usr/bin, whose environment macOS hides: the role's or not, nothing shows.
    unix(30, 1, 501, "/usr/bin/python3", { marked: null, service: false }),
    unix(31, 30, 501, "/bin/sleep", { marked: null, service: false }),
    // QuickLook's helper: an orphan of this user that launchd does not list.
    unix(32, 1, 501, "/System/Library/Frameworks/QuickLookUI.framework/QuickLookUIService", {
      marked: null,
      service: false,
    }),
    // Spotlight's indexer, started by launchd for the role's new files.
    unix(40, 1, 501, "/System/Library/Frameworks/mdworker_shared", {
      marked: null,
      service: true,
    }),
    unix(41, 40, 501, "/usr/libexec/helper", { marked: null, service: false }),
    unix(42, 1, 501, "/opt/R/bin/exec/R", { marked: true, service: false }),
    // Apple's program, started by the role's R: its parent's mark makes it the role's.
    unix(43, 42, 501, "/usr/bin/make", { marked: null, service: false }),
  ];
  NodeAssert.deepEqual(verdicts({ before, after, self: 21, uid: 501 }), {
    owned: [42, 43],
    unverified: [30, 31, 32],
  });
  // Seen under R before R exited, it stays the role's once launchd adopts it.
  const adopted = unix(43, 1, 501, "/usr/bin/make", { marked: null, service: false });
  NodeAssert.deepEqual(
    verdicts({
      before,
      after: [...before, after[1], adopted],
      self: 21,
      uid: 501,
      recorded: new Map([[adopted.key, adopted]]),
    }),
    { owned: [43], unverified: [] },
  );
});

NodeTest.test("on Windows, the role owns what carries its mark or a recorded parent", () => {
  const before = [
    windows(4, 0, "", 1),
    windows(600, 4, "C:\\Windows\\System32\\svchost.exe", 2),
    windows(10, 600, "C:\\actions-runner\\bin\\Runner.Worker.exe", 3),
  ];
  const after = [
    ...before,
    windows(21, 10, "C:\\Program Files\\nodejs\\node.exe", 50),
    windows(22, 21, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", 51),
    // A PowerShell a role step started; the step's shell has exited.
    windows(30, 25, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", 20),
    windows(31, 30, "C:\\Windows\\System32\\conhost.exe", 21),
    // Its parent's pid now belongs to a newer process, so its real parent exited too.
    windows(32, 600, "C:\\R\\bin\\x64\\Rterm.exe", 1),
    // Started by a Windows service, not by the role.
    windows(33, 600, "C:\\Windows\\System32\\taskhostw.exe", 40),
    // The role's R, read from its own memory, and the compiler it started.
    windows(34, 27, "C:\\R\\bin\\x64\\Rterm.exe", 60, true),
    windows(35, 34, "C:\\rtools45\\usr\\bin\\make.exe", 61),
  ];
  // Lost parents alone prove nothing: they are only reported.
  NodeAssert.deepEqual(verdicts({ before, after, self: 21, uid: null }), {
    owned: [34, 35],
    unverified: [30, 31, 32],
  });
  // A parent the role owned when this step saw it, which has exited since.
  const parent = windows(25, 10, "C:\\julia\\bin\\julia.exe", 15, true);
  NodeAssert.deepEqual(
    verdicts({ before, after, self: 21, uid: null, recorded: new Map([[parent.key, parent]]) }),
    { owned: [30, 31, 34, 35], unverified: [32] },
  );
  // The same pid recorded for a process started after the orphan is not its parent.
  const later = windows(25, 10, "C:\\julia\\bin\\julia.exe", 25, true);
  NodeAssert.deepEqual(
    verdicts({ before, after, self: 21, uid: null, recorded: new Map([[later.key, later]]) }),
    { owned: [34, 35], unverified: [30, 31, 32] },
  );
});

NodeTest.test("removes only the outermost added per-user entry", () => {
  const sep = NodePath.sep;
  NodeAssert.deepEqual(
    addedEntries(
      [".cache", `.cache${sep}pip`],
      [".cache", `.cache${sep}pip`, ".julia", `.local`, `.local${sep}share`, `.matplotlibrc`],
    ),
    [".julia", ".local", ".matplotlibrc"],
  );
});

NodeTest.test("reads renamed and untracked entries from git status", () => {
  NodeAssert.deepEqual(parseStatus(" M a.json\0R  new.ts\0old.ts\0?? dir/b c\0"), [
    { code: " M", path: "a.json" },
    { code: "R ", path: "new.ts" },
    { code: "??", path: "dir/b c" },
  ]);
});

NodeTest.test("reads R's library paths from LF and CRLF output", () => {
  NodeAssert.deepEqual(libraryPaths("C:/a\r\nC:/R/library\r\n"), ["C:/a", "C:/R/library"]);
  NodeAssert.deepEqual(libraryPaths("/a\n/usr/lib/R/library\n"), ["/a", "/usr/lib/R/library"]);
});

NodeTest.test("names package additions, removals and version changes", () => {
  NodeAssert.deepEqual(
    packageChanges({ pip: "24.0", six: "1.0" }, { pip: "25.0", ipykernel: "6.29" }),
    ["ipykernel 6.29 added", "pip 24.0 -> 25.0", "six 1.0 removed"],
  );
});

// Every step of each role, as toJSON(steps) reports them when all ran.
const allSteps = (roles, outcome = "success") =>
  Object.fromEntries(
    roles.flatMap((role) => [role, ...PROOFS[role], `end-${role}`].map((id) => [id, { outcome }])),
  );

NodeTest.test("names failed roles and roles that did not run", () => {
  const steps = {
    vp: { outcome: "success" },
    ...allSteps(["people", "files", "kernels"]),
    "people-run": { outcome: "failure" },
    "kernels-run": { outcome: "skipped" },
    managed: { outcome: "skipped" },
  };
  NodeAssert.deepEqual(
    summarize(["people", "files", "kernels", "managed", "python"], steps).map(
      ({ role, ran, failed }) => [role, ran, failed],
    ),
    [
      ["people", true, ["people-run"]],
      ["files", true, []],
      ["kernels", false, []],
      ["managed", false, []],
      ["python", false, []],
    ],
  );
});

NodeTest.test("a role whose begin and end ran misses each proof it did not run", () => {
  const roles = ["people", "files", "kernels", "managed", "python"];
  const complete = summarize(roles, allSteps(roles));
  NodeAssert.deepEqual(
    complete.map(({ ran, failed, missing }) => [ran, failed, missing]),
    roles.map(() => [true, [], []]),
  );
  for (const role of roles)
    for (const proof of PROOFS[role]) {
      const steps = allSteps(roles);
      delete steps[proof];
      const result = summarize(roles, steps).find((entry) => entry.role === role);
      NodeAssert.deepEqual([result.ran, result.missing], [false, [proof]], proof);
    }
  // Only begin and end: every proof is missing.
  NodeAssert.deepEqual(
    summarize(["managed"], {
      managed: { outcome: "success" },
      "end-managed": { outcome: "success" },
    })[0].missing,
    PROOFS.managed,
  );
});

// A runner home, checkout and Python for whole roles; R and pip write real files.
function sandbox() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "compute-roles-"));
  const workspace = NodePath.join(root, "workspace");
  const home = NodePath.join(root, "home");
  NodeFS.mkdirSync(NodePath.join(home, ".cache"), { recursive: true });
  NodeFS.mkdirSync(workspace);
  const git = (...args) =>
    NodeChildProcess.execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
  git("init", "-q");
  // The literal-LF assertions below hold whatever line endings the machine's Git prefers.
  git("config", "core.autocrlf", "false");
  NodeFS.writeFileSync(NodePath.join(workspace, "recipe.json"), "{}\n");
  NodeFS.writeFileSync(NodePath.join(workspace, "kept.txt"), "before\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base");
  const env = {
    RUNNER_TEMP: NodePath.join(root, "runner"),
    GITHUB_ENV: NodePath.join(root, "github-env"),
    GITHUB_OUTPUT: NodePath.join(root, "github-output"),
    GITHUB_WORKSPACE: workspace,
  };
  // Pythons by interpreter path: each its own package versions.
  const pythons = { "/toolcache/python": { pip: "24.0", setuptools: "70.0" } };
  let running = [];
  const stopped = [];
  const system = {
    platform: "linux",
    home: () => home,
    processes: () => [unix(process.pid, 1, uid, "node", { marked: true }), ...running],
    stop: async (processes) => {
      stopped.push(...processes.map((entry) => entry.pid));
      running = running.filter((entry) => !processes.includes(entry));
    },
    owned: (processes) => processes,
    wait: async () => {},
    python: () => "/toolcache/python",
    packages: (python) => ({ ...pythons[python] }),
    pip: (python, [command, ...args]) => {
      const names = args.filter((arg) => !arg.startsWith("-"));
      for (const name of names) {
        const [package_, version] = name.split(/==|>=/);
        if (command === "uninstall") delete pythons[python][package_];
        else pythons[python][package_.toLowerCase().replace(/_/g, "-")] = version ?? "1.0";
      }
    },
    venv: (directory) => {
      NodeFS.mkdirSync(directory, { recursive: true });
      const python = NodePath.join(directory, "bin", "python");
      pythons[python] = { pip: "24.0" };
      return python;
    },
    rLibraries: () => [],
  };
  // What GITHUB_ENV gives later steps, as the runner applies it.
  const stepEnv = () => {
    const applied = { ...env };
    for (const line of NodeFS.readFileSync(env.GITHUB_ENV, "utf8").split("\n").filter(Boolean)) {
      const index = line.indexOf("=");
      applied[line.slice(0, index)] = line.slice(index + 1);
    }
    return applied;
  };
  return {
    root,
    workspace,
    home,
    env,
    pythons,
    stopped,
    system,
    stepEnv,
    run: (entries) => (running = entries),
    running: () => running,
    cleanup: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

const installR = (library, name, version) => {
  NodeFS.mkdirSync(NodePath.join(library, name), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(library, name, "DESCRIPTION"),
    `Package: ${name}\nVersion: ${version}\n`,
  );
};

NodeTest.test(
  "a role leaves no temporary files, per-user entries or checkout changes behind",
  async () => {
    const box = sandbox();
    const { env, home, workspace, system } = box;
    try {
      // Already changed before the role: not the role's to undo.
      NodeFS.writeFileSync(NodePath.join(workspace, "kept.txt"), "changed before\n");
      begin("kernels", ["--save-python", "bare"], env, system);
      const temp = roleTemp(env, "kernels");
      NodeAssert.ok(
        NodeFS.readFileSync(env.GITHUB_ENV, "utf8").split("\n").includes(`TMPDIR=${temp}`),
      );
      NodeFS.writeFileSync(NodePath.join(temp, "kernel.json"), "{}");
      NodeFS.mkdirSync(NodePath.join(home, ".julia", "logs"), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(home, ".cache", "pip"));
      NodeFS.writeFileSync(NodePath.join(workspace, "recipe.json"), '{"sealed":true}\n');
      NodeFS.mkdirSync(NodePath.join(workspace, "out"));
      NodeFS.writeFileSync(NodePath.join(workspace, "out", "figure.png"), "");

      await end("kernels", ["--check-python", "bare"], env, system);
      NodeAssert.equal(NodeFS.existsSync(temp), false);
      NodeAssert.deepEqual(NodeFS.readdirSync(home), [".cache"]);
      NodeAssert.deepEqual(NodeFS.readdirSync(NodePath.join(home, ".cache")), []);
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(workspace, "recipe.json"), "utf8"),
        "{}\n",
      );
      NodeAssert.equal(NodeFS.existsSync(NodePath.join(workspace, "out", "figure.png")), false);
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(workspace, "kept.txt"), "utf8"),
        "changed before\n",
      );
      NodeAssert.deepEqual(box.stopped, []);
    } finally {
      box.cleanup();
    }
  },
);

NodeTest.test("packages one role installs or upgrades are not there for the next", async () => {
  const box = sandbox();
  const { env, home, system, pythons } = box;
  try {
    // What setup left: its R library, a Julia depot and Jupyter data that already exist.
    const setupLibrary = NodePath.join(env.RUNNER_TEMP, "Library");
    installR(setupLibrary, "jsonlite", "1.8.0");
    NodeFS.mkdirSync(NodePath.join(home, ".julia", "registries"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(home, ".local", "share", "jupyter", "kernels"), {
      recursive: true,
    });
    const site = NodePath.join(box.root, "site-library");
    installR(site, "base64enc", "0.1-3");
    // R names setup's library again, spelled its own way.
    system.rLibraries = () => [`${setupLibrary}${NodePath.sep}`, site];
    env.R_LIBS_USER = setupLibrary;

    begin("people", ["--save-python", "bare"], env, system);
    const people = box.stepEnv();
    NodeAssert.equal(people.R_LIBS_USER, NodePath.join(roleTemp(env, "people"), "R-library"));
    NodeAssert.deepEqual(NodeFS.readdirSync(people.R_LIBS_USER), ["jsonlite"]);
    // The role installs IRkernel and upgrades jsonlite in its library, adds IJulia and a kernel
    // inside directories that existed, and installs into its Julia depot's precompile cache.
    installR(people.R_LIBS_USER, "IRkernel", "1.3.2");
    installR(people.R_LIBS_USER, "jsonlite", "2.0.0");
    NodeFS.mkdirSync(NodePath.join(home, ".julia", "packages", "IJulia"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(home, ".julia", "compiled", "v1.11", "IJulia"), {
      recursive: true,
    });
    // Julia leaves installed artifacts read-only.
    NodeFS.chmodSync(NodePath.join(home, ".julia", "compiled", "v1.11"), 0o500);
    NodeFS.mkdirSync(NodePath.join(home, ".local", "share", "jupyter", "kernels", "ir"));
    await end("people", ["--check-python", "bare"], env, system);

    begin("kernels", [], env, system);
    const kernels = box.stepEnv();
    NodeAssert.notEqual(kernels.R_LIBS_USER, people.R_LIBS_USER);
    NodeAssert.notEqual(kernels[OWNER_VARIABLE], people[OWNER_VARIABLE]);
    NodeAssert.deepEqual(NodeFS.readdirSync(kernels.R_LIBS_USER), ["jsonlite"]);
    NodeAssert.match(
      NodeFS.readFileSync(NodePath.join(kernels.R_LIBS_USER, "jsonlite", "DESCRIPTION"), "utf8"),
      /Version: 1\.8\.0/,
    );
    NodeAssert.deepEqual(NodeFS.readdirSync(NodePath.join(home, ".julia")), ["registries"]);
    NodeAssert.deepEqual(
      NodeFS.readdirSync(NodePath.join(home, ".local", "share", "jupyter", "kernels")),
      [],
    );
    // The bridge packages go into the role's own environment, not the saved Python.
    const bridge = venv("kernels", ["jupyter_client>=8.6", "ipykernel>=6.29"], kernels, system);
    NodeAssert.ok(bridge.startsWith(roleTemp(env, "kernels") + NodePath.sep));
    NodeAssert.ok(
      NodeFS.readFileSync(env.GITHUB_OUTPUT, "utf8").split("\n").includes(`python=${bridge}`),
    );
    NodeAssert.deepEqual(Object.keys(pythons[bridge]).toSorted(), [
      "ipykernel",
      "jupyter-client",
      "pip",
    ]);
    await end("kernels", ["--check-python", "bare"], env, system);
    NodeAssert.equal(NodeFS.existsSync(NodePath.dirname(NodePath.dirname(bridge))), false);
    NodeAssert.deepEqual(pythons["/toolcache/python"], { pip: "24.0", setuptools: "70.0" });

    // A role that upgrades a package of the saved Python, or writes into a shared R library,
    // fails its end, and the next role still gets the Python and the libraries as they were.
    begin("files", [], env, system);
    pythons["/toolcache/python"].pip = "25.0";
    pythons["/toolcache/python"].ipykernel = "6.29";
    installR(site, "IRkernel", "1.3.2");
    installR(site, "base64enc", "0.1-4");
    installR(setupLibrary, "IRkernel", "1.3.2");
    await NodeAssert.rejects(
      end("files", ["--check-python", "bare"], env, system),
      (error) =>
        error.message.includes(
          "changed /toolcache/python: ipykernel 6.29 added, pip 24.0 -> 25.0",
        ) &&
        error.message.includes(
          `changed the R library ${site}: IRkernel 1.3.2 added, base64enc 0.1-3 -> 0.1-4`,
        ) &&
        error.message.includes(`changed the R library ${setupLibrary}: IRkernel 1.3.2 added`) &&
        !error.message.includes("could not be put back"),
    );
    NodeAssert.deepEqual(pythons["/toolcache/python"], { pip: "24.0", setuptools: "70.0" });
    NodeAssert.deepEqual(NodeFS.readdirSync(setupLibrary), ["jsonlite"]);
    NodeAssert.deepEqual(NodeFS.readdirSync(site), ["base64enc"]);
    NodeAssert.match(
      NodeFS.readFileSync(NodePath.join(site, "base64enc", "DESCRIPTION"), "utf8"),
      /Version: 0\.1-3/,
    );

    // Managed Python sits between the R and Julia roles and real Python, which reuses that 3.12.
    begin("managed", [], env, system);
    NodeAssert.deepEqual(NodeFS.readdirSync(box.stepEnv().R_LIBS_USER), ["jsonlite"]);
    pythons["/toolcache/python"].pip = "25.1";
    await NodeAssert.rejects(
      end("managed", ["--check-python", "bare"], env, system),
      /changed \/toolcache\/python: pip 24\.0 -> 25\.1/,
    );
    begin("python", [], env, system);
    NodeAssert.deepEqual(pythons["/toolcache/python"], { pip: "24.0", setuptools: "70.0" });
    await end("python", [], env, system);
  } finally {
    box.cleanup();
  }
});

NodeTest.test("a role's processes are stopped, and an end fails if one survives", async () => {
  const box = sandbox();
  const { env, system } = box;
  try {
    begin("python", [], env, system);
    const kernel = unix(4242, 1, uid, "/usr/bin/python3", { marked: true });
    box.run([kernel]);
    await end("python", [], env, system);
    NodeAssert.deepEqual(box.stopped, [4242]);

    begin("python", [], env, system);
    box.run([kernel]);
    system.stop = async (processes) => box.stopped.push(...processes.map((entry) => entry.pid));
    await NodeAssert.rejects(
      end("python", [], env, system),
      new RegExp(
        `${ROLES.python}: processes still running after being stopped: /usr/bin/python3 \\(4242\\)`,
      ),
    );
  } finally {
    box.cleanup();
  }
});

NodeTest.test("an orphan nothing shows is the role's is reported and left running", async (t) => {
  const box = sandbox();
  const { env, system } = box;
  const log = t.mock.method(console, "log", () => {});
  try {
    begin("files", [], env, system);
    // Same user, started meanwhile, parent gone: QuickLook's helper on a Mac (its environment
    // hidden), and a program whose environment shows no mark.
    box.run([
      unix(5151, 1, uid, "/System/Library/Frameworks/QuickLookUI.framework/QuickLookUIService", {
        marked: null,
      }),
      unix(5152, 1, uid, "/usr/libexec/someone-elses-helper", { marked: false }),
    ]);
    await end("files", [], env, system);
    NodeAssert.deepEqual(box.stopped, []);
    NodeAssert.deepEqual(pids(box.running()), [5151, 5152]);
    const warnings = log.mock.calls.map((call) => String(call.arguments[0]));
    for (const pid of [5151, 5152])
      NodeAssert.ok(
        warnings.some((line) => line.startsWith("::warning::") && line.includes(`(${pid})`)),
        String(pid),
      );
  } finally {
    box.cleanup();
  }
});

NodeTest.test("a child started while the role's processes stop is the role's too", async () => {
  const box = sandbox();
  const { env, system } = box;
  try {
    // On Windows a child keeps naming its exited parent, which this end saw as the role's.
    system.platform = "win32";
    system.processes = () => [windows(process.pid, 1, "node.exe", 0, true), ...box.running()];
    begin("kernels", [], env, system);
    const r = windows(4300, 77, "C:\\R\\bin\\x64\\Rterm.exe", 100, true);
    const child = windows(4301, 4300, "C:\\rtools45\\usr\\bin\\sh.exe", 101);
    box.run([r]);
    system.stop = async (processes) => {
      box.stopped.push(...processes.map((entry) => entry.pid));
      // R exits starting a child that ignores being stopped.
      if (processes.includes(r)) box.run([child]);
    };
    await NodeAssert.rejects(
      end("kernels", [], env, system),
      /processes still running after being stopped: C:\\rtools45\\usr\\bin\\sh\.exe \(4301\)/,
    );
    NodeAssert.deepEqual([...new Set(box.stopped)], [4300, 4301]);

    // On Linux and macOS the OS adopts it, environment hidden: seen under R, it stays the role's.
    system.platform = "linux";
    system.processes = () => [
      unix(process.pid, 1, uid, "node", { marked: true }),
      ...box.running(),
    ];
    box.stopped.length = 0;
    begin("kernels", [], env, system);
    const kernel = unix(4400, 1, uid, "/opt/R/bin/exec/R", { marked: true });
    const make = unix(4401, 4400, uid, "/usr/bin/make", { marked: null });
    box.run([kernel, make]);
    system.stop = async (processes) => {
      box.stopped.push(...processes.map((entry) => entry.pid));
      if (processes.includes(kernel)) box.run([{ ...make, ppid: 1 }]);
    };
    await NodeAssert.rejects(
      end("kernels", [], env, system),
      /processes still running after being stopped: \/usr\/bin\/make \(4401\)/,
    );
  } finally {
    box.cleanup();
  }
});

NodeTest.test("the steps after a role get setup's temporary files back", async () => {
  const box = sandbox();
  const { env, system } = box;
  try {
    env.TMP = NodePath.join(box.root, "setup-temp");
    NodeFS.mkdirSync(env.TMP);
    begin("people", [], env, system);
    NodeAssert.equal(box.stepEnv().TMPDIR, roleTemp(env, "people"));
    await end("people", [], env, system);
    const next = box.stepEnv();
    for (const name of ["TMPDIR", "TMP", "TEMP"]) {
      NodeAssert.equal(next[name], env.TMP, name);
      NodeFS.rmSync(NodeFS.mkdtempSync(NodePath.join(next[name], "next-")), { recursive: true });
    }
  } finally {
    box.cleanup();
  }
});

NodeTest.test("Windows' R profile and user library under Documents are put back", async () => {
  const box = sandbox();
  const { env, home, system } = box;
  try {
    // What setup-r leaves on Windows.
    const documents = NodePath.join(home, "Documents");
    NodeFS.mkdirSync(documents);
    NodeFS.writeFileSync(NodePath.join(documents, ".Rprofile"), "options(repos = 'rspm')\n");
    begin("people", [], env, system);
    NodeFS.rmSync(NodePath.join(documents, ".Rprofile"));
    installR(NodePath.join(documents, "R", "win-library", "4.5"), "IRkernel", "1.3.2");
    await end("people", [], env, system);
    begin("files", [], env, system);
    NodeAssert.deepEqual(NodeFS.readdirSync(documents), [".Rprofile"]);
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(documents, ".Rprofile"), "utf8"),
      "options(repos = 'rspm')\n",
    );
  } finally {
    box.cleanup();
  }
});

NodeTest.test("a library R reports with CRLF line ends is still checked", async () => {
  const box = sandbox();
  const { env, system } = box;
  try {
    const site = NodePath.join(box.root, "site-library");
    installR(site, "base64enc", "0.1-3");
    // As `cat(.libPaths(), sep = "\n")` prints on Windows.
    system.rLibraries = () => libraryPaths(`${site}\r\n`);
    begin("people", [], env, system);
    installR(site, "base64enc", "0.1-4");
    await NodeAssert.rejects(
      end("people", [], env, system),
      new RegExp(`changed the R library .*base64enc 0\\.1-3 -> 0\\.1-4`),
    );
  } finally {
    box.cleanup();
  }
});
