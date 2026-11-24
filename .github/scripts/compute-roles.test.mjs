import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import {
  OWNER_VARIABLE,
  ROLES,
  addedEntries,
  begin,
  end,
  leftovers,
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
const windows = (pid, ppid, command, created) => ({
  pid,
  ppid,
  uid: null,
  command,
  created,
  key: `${pid} ${created}`,
  marked: null,
});
const pids = (entries) => entries.map((entry) => entry.pid);

NodeTest.test("reads ps and Windows process lists", () => {
  NodeAssert.deepEqual(parseUnixProcesses("  12     1   501 /usr/sbin/cfprefsd\n 40 12 0 R\n"), [
    unix(12, 1, 501, "/usr/sbin/cfprefsd"),
    unix(40, 12, 0, "R"),
  ]);
  NodeAssert.deepEqual(parseWindowsProcesses('{"pid":7,"ppid":4,"command":null,"created":133}'), [
    { pid: 7, ppid: 4, uid: null, command: "", created: 133, key: "7 133" },
  ]);
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
  NodeAssert.deepEqual(leftovers({ before, after, self: 21, uid: 501 }), []);
});

NodeTest.test("on Linux, the role owns what carries its mark and what it orphaned", () => {
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
    // Orphaned with a cleared environment: pid 1 adopted it, so a step left it.
    unix(32, 1, 501, "/usr/bin/sleep", { marked: false }),
    // Under a parent the role does not own: only its mark makes it the role's.
    unix(33, 5, 501, "/usr/bin/julia", { marked: true }),
    unix(34, 5, 501, "/usr/lib/dbus-daemon", { marked: false }),
    // Another user's.
    unix(35, 1, 0, "/usr/bin/sudo", { marked: null }),
    // The same pid running another program is a new process.
    unix(10, 1, 501, "python3", { marked: true }),
  ];
  NodeAssert.deepEqual(pids(leftovers({ before, after, self: 21, uid: 501 })), [30, 31, 32, 33]);
});

NodeTest.test("on macOS, Apple's programs count by ownership, not by where they live", () => {
  const before = [unix(1, 0, 0, "/sbin/launchd"), unix(10, 1, 501, "Runner.Worker")];
  const after = [
    ...before,
    unix(21, 10, 501, "node", { marked: true, service: false }),
    // Started by the role from /usr/bin and orphaned; macOS hides its environment.
    unix(30, 1, 501, "/usr/bin/python3", { marked: null, service: false }),
    unix(31, 30, 501, "/bin/sleep", { marked: null, service: false }),
    // Spotlight's indexer, started by launchd for the role's new files.
    unix(40, 1, 501, "/System/Library/Frameworks/mdworker_shared", {
      marked: null,
      service: true,
    }),
    unix(41, 40, 501, "/usr/libexec/helper", { marked: null, service: false }),
    unix(42, 1, 501, "/opt/R/bin/exec/R", { marked: true, service: false }),
  ];
  NodeAssert.deepEqual(pids(leftovers({ before, after, self: 21, uid: 501 })), [30, 31, 42]);
});

NodeTest.test("on Windows, the role owns what lost its parent, wherever it lives", () => {
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
  ];
  NodeAssert.deepEqual(pids(leftovers({ before, after, self: 21, uid: null })), [30, 31, 32]);
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

NodeTest.test("names package additions, removals and version changes", () => {
  NodeAssert.deepEqual(
    packageChanges({ pip: "24.0", six: "1.0" }, { pip: "25.0", ipykernel: "6.29" }),
    ["ipykernel 6.29 added", "pip 24.0 -> 25.0", "six 1.0 removed"],
  );
});

NodeTest.test("names failed roles and roles that did not run", () => {
  const steps = {
    vp: { outcome: "success" },
    people: { outcome: "success" },
    "people-run": { outcome: "failure" },
    "end-people": { outcome: "success" },
    files: { outcome: "success" },
    "files-run": { outcome: "success" },
    "end-files": { outcome: "success" },
    kernels: { outcome: "success" },
    "kernels-install": { outcome: "success" },
    "kernels-run": { outcome: "skipped" },
    "end-kernels": { outcome: "success" },
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
    system.rLibraries = () => [setupLibrary, site];
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
    // fails its end, and the next role still gets the Python as it was.
    begin("files", [], env, system);
    pythons["/toolcache/python"].pip = "25.0";
    pythons["/toolcache/python"].ipykernel = "6.29";
    installR(site, "IRkernel", "1.3.2");
    await NodeAssert.rejects(
      end("files", ["--check-python", "bare"], env, system),
      (error) =>
        error.message.includes(
          "changed /toolcache/python: ipykernel 6.29 added, pip 24.0 -> 25.0",
        ) && error.message.includes(`changed the R library ${site}: IRkernel 1.3.2 added`),
    );
    NodeAssert.deepEqual(pythons["/toolcache/python"], { pip: "24.0", setuptools: "70.0" });
    // Setup's own library was never written.
    NodeAssert.deepEqual(NodeFS.readdirSync(setupLibrary), ["jsonlite"]);
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
