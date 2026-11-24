import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export function qualifyPackagedSpeech(executable, resources) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-speech-package-")),
  );
  try {
    const cache = process.env.SCIENT_SPEECH_PROBE_CACHE;
    const args = [];
    if (cache) {
      const directory = NodePath.resolve(cache);
      NodeFS.mkdirSync(directory, { recursive: true });
      args.push(directory);
    }
    const archive = NodeFS.existsSync(NodePath.join(resources, "server.asar"))
      ? "server.asar"
      : "app.asar";
    const entry = NodeURL.pathToFileURL(
      NodePath.join(
        NodePath.resolve(resources),
        archive,
        "apps/server/dist/speech-packaging-probe.mjs",
      ),
    ).href;
    const launcher = NodePath.join(root, "speech-probe.cjs");
    NodeFS.writeFileSync(
      launcher,
      `import(${JSON.stringify(entry)}).catch(error => { console.error(error); process.exitCode = 1; });\n`,
    );
    const env = { ...process.env, HOME: root, USERPROFILE: root, NODE_PATH: "" };
    for (const key of Object.keys(env)) {
      if (/^(T3CODE_|SCIENT_|VITE_|ELECTRON_|TRANSCRIBE_|HF_)/u.test(key) || key === "NODE_OPTIONS")
        delete env[key];
    }
    env.ELECTRON_RUN_AS_NODE = "1";
    const result = NodeChildProcess.spawnSync(NodePath.resolve(executable), [launcher, ...args], {
      cwd: root,
      env,
      stdio: "inherit",
      timeout: 10 * 60_000,
    });
    if (result.error) throw result.error;
    NodeAssert.equal(
      result.status,
      0,
      `Packaged speech failed (${result.signal ?? result.status})`,
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
}

if (import.meta.main) {
  const [executable, resources] = process.argv.slice(2);
  NodeAssert.ok(
    executable && resources,
    "Usage: qualify-packaged-speech.mjs <executable> <resources>",
  );
  qualifyPackagedSpeech(executable, resources);
}
