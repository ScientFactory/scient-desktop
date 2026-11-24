import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import {
  addedEntries,
  begin,
  end,
  leftovers,
  parseStatus,
  parseUnixProcesses,
  parseWindowsProcesses,
  roleTemp,
  summarize,
} from "./compute-roles.mjs";

const unix = (pid, ppid, uid, command) => ({ pid, ppid, uid, command, key: `${pid} ${command}` });

NodeTest.test("reads ps and Windows process lists", () => {
  NodeAssert.deepEqual(parseUnixProcesses("  12     1   501 /usr/sbin/cfprefsd\n 40 12 0 R\n"), [
    unix(12, 1, 501, "/usr/sbin/cfprefsd"),
    unix(40, 12, 0, "R"),
  ]);
  NodeAssert.deepEqual(parseWindowsProcesses('{"pid":7,"ppid":4,"command":null,"created":133}'), [
    { pid: 7, ppid: 4, uid: null, command: "", key: "7 133" },
  ]);
});

NodeTest.test("stops only what the role started, never this process or its ancestors", () => {
  const before = [unix(1, 0, 0, "launchd"), unix(10, 1, 501, "Runner.Worker")];
  const after = [
    ...before,
    unix(20, 10, 501, "bash"),
    unix(21, 20, 501, "node"),
    unix(30, 1, 501, "/opt/R/bin/exec/R"),
    unix(31, 30, 501, "julia"),
    unix(32, 1, 0, "/usr/bin/sudo"),
    unix(33, 1, 501, "/System/Library/mdworker"),
    // The same pid running another program is a new process.
    unix(10, 1, 501, "python3"),
  ];
  const left = (platform) =>
    leftovers({ before, after, self: 21, uid: 501, platform }).map((entry) => entry.key);
  NodeAssert.deepEqual(left("darwin"), ["30 /opt/R/bin/exec/R", "31 julia"]);
  NodeAssert.deepEqual(left("linux"), [
    "30 /opt/R/bin/exec/R",
    "31 julia",
    "33 /System/Library/mdworker",
  ]);
  const windows = [
    { pid: 5, ppid: 1, uid: null, command: "C:\\Windows\\System32\\conhost.exe", key: "5 1" },
    { pid: 6, ppid: 1, uid: null, command: "", key: "6 1" },
    { pid: 7, ppid: 1, uid: null, command: "C:\\R\\bin\\R.exe", key: "7 1" },
  ];
  NodeAssert.deepEqual(
    leftovers({
      before: [],
      after: windows,
      self: 99,
      uid: null,
      platform: "win32",
      systemRoot: "C:\\WINDOWS",
    }).map((entry) => entry.pid),
    [7],
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

NodeTest.test(
  "a role leaves no temporary files, per-user entries or checkout changes behind",
  async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "compute-roles-"));
    try {
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
      // Already changed before the role: not the role's to undo.
      NodeFS.writeFileSync(NodePath.join(workspace, "kept.txt"), "changed before\n");
      const env = {
        RUNNER_TEMP: NodePath.join(root, "runner"),
        GITHUB_ENV: NodePath.join(root, "github-env"),
        GITHUB_WORKSPACE: workspace,
      };
      let packages = ["pip", "setuptools"];
      const stopped = [];
      const system = {
        platform: "linux",
        home: () => home,
        processes: () => [unix(process.pid, 1, process.getuid?.() ?? 0, "node")],
        stop: async (processes) => stopped.push(...processes),
        owned: (processes) => processes,
        python: () => "/toolcache/python",
        packages: () => packages,
        uninstall: (python, names) => {
          NodeAssert.equal(python, "/toolcache/python");
          packages = packages.filter((name) => !names.includes(name));
        },
      };
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
      packages = [...packages, "ipykernel", "jupyter-client"];

      await end("kernels", ["--restore-python", "bare"], env, system);
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
      NodeAssert.deepEqual(packages, ["pip", "setuptools"]);
      NodeAssert.deepEqual(stopped, []);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
