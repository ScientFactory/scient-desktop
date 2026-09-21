// @effect-diagnostics nodeBuiltinImport:off -- Isolated temporary files verify the pre-runtime PID publication boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it } from "vite-plus/test";

import {
  publishDesktopDevelopmentBackendPid,
  resolveDesktopDevelopmentBackendPidHandoff,
  SCIENT_DESKTOP_DEV_BACKEND_LAUNCH_GENERATION_ENV,
  SCIENT_DESKTOP_DEV_BACKEND_PID_FILE_ENV,
  SCIENT_DESKTOP_DEV_BACKEND_PID_HANDOFF_ENV,
} from "./desktopDevelopmentBackendPidHandoff.ts";

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

const fixture = () => {
  const baseDir = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "scient-desktop-backend-handoff-"),
  );
  roots.push(baseDir);
  const generation = "abc-1-def";
  const launchDirectory = NodePath.join(baseDir, "local-dev-app-runtime", "launches", generation);
  const pidFilePath = NodePath.join(launchDirectory, "backend.pid");
  const pendingFilePath = NodePath.join(launchDirectory, "backend.pending");
  NodeFS.mkdirSync(launchDirectory, { recursive: true });
  NodeFS.writeFileSync(pendingFilePath, `${generation}\n`, { mode: 0o600 });
  const environment = {
    SCIENT_NEXT_HOME: baseDir,
    [SCIENT_DESKTOP_DEV_BACKEND_PID_HANDOFF_ENV]: "1",
    [SCIENT_DESKTOP_DEV_BACKEND_LAUNCH_GENERATION_ENV]: generation,
    [SCIENT_DESKTOP_DEV_BACKEND_PID_FILE_ENV]: pidFilePath,
  };
  return { baseDir, generation, pidFilePath, pendingFilePath, environment };
};

describe("desktop development backend PID handoff", () => {
  it("self-publishes the child PID and accepts a parent-published matching record", () => {
    const { environment, pendingFilePath, pidFilePath } = fixture();

    assert.isTrue(publishDesktopDevelopmentBackendPid({ environment, pid: 5432 }));
    assert.equal(NodeFS.readFileSync(pidFilePath, "utf8"), "5432\n");
    assert.equal(NodeFS.statSync(pidFilePath).mode & 0o777, 0o600);
    assert.isTrue(NodeFS.existsSync(pendingFilePath));
    NodeFS.rmSync(pendingFilePath);
    assert.isTrue(publishDesktopDevelopmentBackendPid({ environment, pid: 5432 }));
  });

  it("rejects arbitrary destinations and malformed generation tokens", () => {
    const { baseDir, environment } = fixture();
    const arbitraryDestination = {
      ...environment,
      [SCIENT_DESKTOP_DEV_BACKEND_PID_FILE_ENV]: NodePath.join(baseDir, "arbitrary.pid"),
    };
    const malformedGeneration = {
      ...environment,
      [SCIENT_DESKTOP_DEV_BACKEND_LAUNCH_GENERATION_ENV]: "../escape",
    };

    assert.isNull(resolveDesktopDevelopmentBackendPidHandoff(arbitraryDestination));
    assert.isNull(resolveDesktopDevelopmentBackendPidHandoff(malformedGeneration));
    assert.isFalse(
      publishDesktopDevelopmentBackendPid({
        environment: arbitraryDestination,
        pid: 5432,
      }),
    );
    assert.isFalse(NodeFS.existsSync(NodePath.join(baseDir, "arbitrary.pid")));
  });

  it("fails closed when a validated child loses both handoff records", () => {
    const { environment, pendingFilePath } = fixture();
    NodeFS.rmSync(pendingFilePath);

    assert.throws(
      () => publishDesktopDevelopmentBackendPid({ environment, pid: 5432 }),
      /Missing desktop backend PID handoff/u,
    );
  });
});
