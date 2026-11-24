#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { resolveLocalDevAppPaths } from "./local-dev-app.mjs";

const { root, stateRoot } = resolveLocalDevAppPaths({ role: "candidate" });
const source = NodePath.join(root, "apps/server/src/scient/documents/document-lab");
const runtimeRoot = NodePath.join(stateRoot, "document-lab");

// oxlint-disable-next-line t3code/no-global-process-runtime -- This standalone setup selects the real host.
if (NodeOS.platform() !== "darwin") {
  throw new Error("The Document Lab desktop preview is qualified only on macOS.");
}

function executable(name) {
  for (const directory of (process.env.PATH ?? "").split(NodePath.delimiter)) {
    if (!NodePath.isAbsolute(directory)) continue;
    const path = NodePath.join(directory, name);
    try {
      NodeFS.accessSync(path, NodeFS.constants.X_OK);
      return path;
    } catch {
      // Continue searching the developer's PATH.
    }
  }
  throw new Error(`Install or add ${name} to PATH before setting up the Document Lab preview.`);
}

function run(command, args, options) {
  const result = NodeChildProcess.spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited with ${result.status ?? result.signal}.`);
  return result.stdout;
}

const uv = executable("uv");
const npm = executable("npm");
const nativeBinDirs = [
  ...new Set(
    [process.execPath, ...["soffice", "pandoc", "pdftoppm", "pdfinfo", "qpdf"].map(executable)].map(
      (binary) => NodePath.dirname(binary),
    ),
  ),
];

NodeFS.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
const generation = NodeFS.mkdtempSync(NodePath.join(runtimeRoot, "runtime-"));
const stagedReceipt = `${generation}.json`;
try {
  NodeFS.cpSync(source, generation, {
    recursive: true,
    filter: (path) => !path.endsWith("__pycache__"),
  });
  const pythonEnvironment = NodePath.join(generation, "python");
  const env = {
    ...process.env,
    PATH: [...nativeBinDirs, process.env.PATH].join(NodePath.delimiter),
  };
  run(uv, ["--no-config", "sync", "--locked", "--managed-python", "--no-install-project"], {
    cwd: generation,
    env: {
      ...env,
      UV_PROJECT_ENVIRONMENT: pythonEnvironment,
      UV_PYTHON_INSTALL_DIR: NodePath.join(runtimeRoot, "interpreters"),
      UV_CACHE_DIR: NodePath.join(runtimeRoot, "uv-cache"),
    },
  });
  const tools = NodePath.join(generation, "tools");
  run(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: NodePath.join(tools, "node"),
    env,
  });
  const python = NodePath.join(pythonEnvironment, "bin", "python");
  const probe = run(python, ["-B", NodePath.join(tools, "doc.py"), "probe"], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (JSON.parse(probe).ready !== true) throw new Error("The Document Lab probe is incomplete.");
  run(python, ["-B", "-c", "from appearance_bidi import fribidi_layout; fribidi_layout()"], {
    cwd: NodePath.join(tools, "pdf"),
    env,
  });

  NodeFS.writeFileSync(
    stagedReceipt,
    JSON.stringify({
      version: 1,
      generation: generation.slice(runtimeRoot.length + 1),
      nativeBinDirs,
    }),
    { flag: "wx", mode: 0o600 },
  );
  NodeFS.renameSync(stagedReceipt, NodePath.join(runtimeRoot, "active.json"));
  console.log(`Document Lab preview staged in ${generation}`);
} catch (error) {
  NodeFS.rmSync(generation, { recursive: true, force: true });
  NodeFS.rmSync(stagedReceipt, { force: true });
  throw error;
}
