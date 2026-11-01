import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Execute only bundled code and installed resources, from two independent processes. */
export function qualifyPackagedOverleaf({ executable, entry, helper, electron = false }) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-overleaf-package-")),
  );
  const env = { ...process.env, HOME: root, USERPROFILE: root, NODE_PATH: "" };
  for (const key of Object.keys(env))
    if (/^(T3CODE_|SCIENT_|VITE_|ELECTRON_)/u.test(key) || key === "NODE_OPTIONS") delete env[key];
  if (electron) env.ELECTRON_RUN_AS_NODE = "1";
  const run = (phase) => {
    const args = electron
      ? [
          "--eval",
          `
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const resources = path.join(path.dirname(process.execPath), 'resources');
const archive = process.platform === 'win32' ? 'server.asar' : 'app.asar';
const entry = path.join(resources, archive, 'apps/server/dist/overleaf-packaging-probe.mjs');
const helper = path.join(resources, 'file-exchange', 'scient-file-publication' + (process.platform === 'win32' ? '.exe' : ''));
process.argv = [process.execPath, entry, process.argv[1], process.argv[2], helper];
import(pathToFileURL(entry).href).catch(error => { console.error(error); process.exitCode = 1; });
`,
          root,
          phase,
        ]
      : [entry, root, phase];
    const result = NodeChildProcess.spawnSync(executable, args, {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 120_000,
    });
    NodeAssert.equal(
      result.status,
      0,
      result.error?.message ?? `${result.stdout}\n${result.stderr}`,
    );
    if (phase !== "refuse") {
      const record = result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find((line) => line?.overleaf === phase);
      NodeAssert.ok(record?.passed, "Installed engine did not finish synthetic Overleaf sync");
      const expected =
        helper ??
        (electron
          ? NodePath.join(
              NodePath.dirname(record.executable),
              "resources/file-exchange/scient-file-publication",
            )
          : NodePath.join(NodePath.dirname(entry), "file-exchange/scient-file-publication"));
      NodeAssert.equal(
        record.helper,
        expected,
        "Overleaf used a helper outside the installed artifact",
      );
    }
  };
  try {
    run("connect");
    run("restart");
    if (helper) {
      const before = NodeFS.readFileSync(NodePath.join(root, "workspace/paper/main.tex"));
      NodeFS.renameSync(helper, `${helper}.qualification-held`);
      try {
        run("refuse");
      } finally {
        NodeFS.renameSync(`${helper}.qualification-held`, helper);
      }
      NodeAssert.deepEqual(
        NodeFS.readFileSync(NodePath.join(root, "workspace/paper/main.tex")),
        before,
      );
    }
    console.log(
      "Installed Overleaf: connect, native apply, bidirectional Git sync and process restart passed.",
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
