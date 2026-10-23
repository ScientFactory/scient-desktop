import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "vite-plus/test";

const source = NodeURL.fileURLToPath(new URL("./dev-bundle-bootstrap.cjs", import.meta.url));

// Node's Windows mode bits may not represent a private file, even with mode 0600.
// Exercise the bootstrap's real refusal on such filesystems, not a mocked permission check.
function environmentIsPrivate(filePath) {
  return (NodeFS.statSync(filePath).mode & 0o077) === 0;
}

function assertEnvironmentRefused(result, resultPath) {
  assert.notEqual(result.status, 0);
  assert.include(result.stderr, "Development environment file is not private and bounded.");
  assert.isFalse(NodeFS.existsSync(resultPath));
}

function fixture(run, { role = "candidate" } = {}) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-dev-bootstrap-"));
  try {
    const appDir = NodePath.join(root, "Resources", "app");
    NodeFS.mkdirSync(appDir, { recursive: true });
    const bootstrap = NodePath.join(appDir, "bootstrap.cjs");
    NodeFS.copyFileSync(source, bootstrap);
    const main = NodePath.join(root, "main.cjs");
    NodeFS.writeFileSync(
      main,
      `require('node:fs').writeFileSync(process.env.TEST_RESULT_PATH, JSON.stringify({
      cold: process.env.SCIENT_DEV_COLD_BOOTSTRAP,
      managed: process.env.SCIENT_NEXT_DEV_RUNNER_ACTIVE,
      state: process.env.SCIENT_NEXT_HOME,
      url: process.env.VITE_DEV_SERVER_URL,
      safety: process.env.SCIENT_NEXT_SAFETY_ENVELOPE,
    }));`,
    );
    const fallback = NodePath.join(root, "fallback.json");
    NodeFS.writeFileSync(
      fallback,
      JSON.stringify({ VITE_DEV_SERVER_URL: "http://127.0.0.1:5733" }),
      { mode: 0o600 },
    );
    const state = NodePath.join(root, "state");
    NodeFS.mkdirSync(state);
    NodeFS.writeFileSync(
      NodePath.join(appDir, "scient-dev-bootstrap.json"),
      JSON.stringify({
        repoRoot: root,
        mainEntryPath: main,
        stateRoot: state,
        role,
        nodePath: process.execPath,
        fallbackEnvironmentPath: fallback,
      }),
    );
    return run({ root, bootstrap, fallback, state });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

describe("native dev bundle bootstrap", () => {
  it("loads main synchronously in cold mode only with a private fallback environment", () =>
    fixture(({ root, bootstrap, fallback, state }) => {
      const resultPath = NodePath.join(root, "result.json");
      const result = NodeChildProcess.spawnSync(process.execPath, [bootstrap], {
        encoding: "utf8",
        env: {
          TEST_RESULT_PATH: resultPath,
          SCIENT_NEXT_DEV_RUNNER_ACTIVE: "",
          SCIENT_DEV_APP_ENV_FILE: "",
        },
      });
      if (!environmentIsPrivate(fallback)) {
        assertEnvironmentRefused(result, resultPath);
        return;
      }
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(NodeFS.readFileSync(resultPath, "utf8")), {
        cold: "1",
        managed: "",
        state,
        url: "http://127.0.0.1:5733",
        safety: "true",
      });
    }));

  it("uses only a private supervisor environment file and records the managed PID", () =>
    fixture(({ root, bootstrap, state }) => {
      const environmentPath = NodePath.join(root, "managed.json");
      const pidPath = NodePath.join(root, "electron.pid");
      const resultPath = NodePath.join(root, "result.json");
      NodeFS.writeFileSync(
        environmentPath,
        JSON.stringify({ VITE_DEV_SERVER_URL: "http://127.0.0.1:8526" }),
        { mode: 0o600 },
      );
      const privateEnvironment = environmentIsPrivate(environmentPath);
      const result = NodeChildProcess.spawnSync(process.execPath, [bootstrap], {
        encoding: "utf8",
        env: {
          TEST_RESULT_PATH: resultPath,
          SCIENT_NEXT_DEV_RUNNER_ACTIVE: "1",
          SCIENT_DEV_COLD_BOOTSTRAP: "1",
          SCIENT_DEV_APP_ENV_FILE: environmentPath,
          SCIENT_DEV_APP_PID_FILE: pidPath,
        },
      });
      assert.isFalse(NodeFS.existsSync(environmentPath));
      if (!privateEnvironment) {
        assertEnvironmentRefused(result, resultPath);
        assert.isFalse(NodeFS.existsSync(pidPath));
        return;
      }
      assert.equal(result.status, 0, result.stderr);
      const values = JSON.parse(NodeFS.readFileSync(resultPath, "utf8"));
      assert.equal(values.cold, undefined);
      assert.isFalse(Object.hasOwn(values, "cold"));
      assert.equal(values.managed, "1");
      assert.equal(values.state, state);
      assert.equal(values.url, "http://127.0.0.1:8526");
      assert.equal(values.safety, "true");
      assert.isFalse(NodeFS.existsSync(environmentPath));
      assert.match(NodeFS.readFileSync(pidPath, "utf8"), /^[0-9]+\n$/u);
    }));

  function runManagedStable({ root, bootstrap }, profileRoot) {
    const environmentPath = NodePath.join(root, "managed.json");
    NodeFS.writeFileSync(
      environmentPath,
      JSON.stringify({ SCIENT_NEXT_PROFILE_ROOT: profileRoot }),
      { mode: 0o600 },
    );
    const privateEnvironment = environmentIsPrivate(environmentPath);
    const resultPath = NodePath.join(root, "result.json");
    const result = NodeChildProcess.spawnSync(process.execPath, [bootstrap], {
      encoding: "utf8",
      env: {
        TEST_RESULT_PATH: resultPath,
        SCIENT_NEXT_DEV_RUNNER_ACTIVE: "1",
        SCIENT_DEV_APP_ENV_FILE: environmentPath,
      },
    });
    assert.isFalse(NodeFS.existsSync(environmentPath));
    return { result, resultPath, privateEnvironment };
  }

  it("runs a managed stable launch on its controller's profile only from a private environment", () =>
    fixture(
      (context) => {
        const profile = NodePath.join(context.state, "profiles", "pr-1");
        NodeFS.mkdirSync(profile, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(profile, "scient-dev-profile.json"),
          JSON.stringify({ id: "pr-1" }),
        );
        const { result, resultPath, privateEnvironment } = runManagedStable(context, profile);
        if (!privateEnvironment) {
          assertEnvironmentRefused(result, resultPath);
          return;
        }
        assert.equal(result.status, 0, result.stderr);
        assert.equal(
          JSON.parse(NodeFS.readFileSync(resultPath, "utf8")).state,
          NodeFS.realpathSync(profile),
        );
      },
      { role: "stable" },
    ));

  it("refuses a managed stable launch without a valid profile", () =>
    fixture(
      (context) => {
        const outside = NodePath.join(context.root, "elsewhere");
        NodeFS.mkdirSync(outside);
        NodeFS.writeFileSync(
          NodePath.join(outside, "scient-dev-profile.json"),
          JSON.stringify({ id: "elsewhere" }),
        );
        NodeFS.mkdirSync(NodePath.join(context.state, "profiles"));
        for (const profileRoot of ["", outside, NodePath.join(context.state, "profiles", "none")]) {
          const { result, resultPath, privateEnvironment } = runManagedStable(context, profileRoot);
          assert.notEqual(result.status, 0);
          assert.isFalse(NodeFS.existsSync(resultPath));
          if (privateEnvironment) {
            assert.include(result.stderr, "without a valid review profile");
          } else {
            assertEnvironmentRefused(result, resultPath);
          }
        }
      },
      { role: "stable" },
    ));
});
