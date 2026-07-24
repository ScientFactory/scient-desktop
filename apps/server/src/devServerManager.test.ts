// FILE: devServerManager.test.ts
// Purpose: Covers project dev-server registry helpers without starting PTYs.
// Layer: Server unit tests for DevServerManager support logic.

import { describe, expect, it } from "vitest";

import { ProjectId, type ProjectDevServer, type ServerLocalServerProcess } from "@synara/contracts";

import {
  failProjectDevServerGeneration,
  findProjectDevServerForLocalServer,
  waitForProjectDevServerReadiness,
} from "./devServerManager";

function makeDevServer(overrides: Partial<ProjectDevServer> = {}): ProjectDevServer {
  return {
    projectId: ProjectId.makeUnsafe("project-1"),
    runId: "run-1",
    command: "pnpm run dev",
    cwd: "/repo/app",
    pid: 100,
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "running",
    ...overrides,
  };
}

function makeLocalServer(
  overrides: Partial<ServerLocalServerProcess> = {},
): ServerLocalServerProcess {
  return {
    id: "200:5173",
    pid: 200,
    command: "node",
    displayName: "Vite",
    args: "node ./node_modules/.bin/vite",
    ports: [5173],
    addresses: [{ host: "127.0.0.1", port: 5173, url: "http://127.0.0.1:5173", family: "tcp4" }],
    isStoppable: true,
    ...overrides,
  };
}

describe("findProjectDevServerForLocalServer", () => {
  it("matches a local server owned by the tracked PTY pid", () => {
    const devServer = makeDevServer({ pid: 200 });

    expect(
      findProjectDevServerForLocalServer({
        localServer: makeLocalServer({ pid: 200 }),
        devServers: [devServer],
      }),
    ).toBe(devServer);
  });

  it("does not treat a matching cwd as process ownership", () => {
    const devServer = makeDevServer({ cwd: "/repo/app", pid: 100 });

    expect(
      findProjectDevServerForLocalServer({
        localServer: makeLocalServer({ cwd: "/repo/app/packages/web", pid: 200 }),
        devServers: [devServer],
      }),
    ).toBeNull();
  });

  it("does not match sibling folders with the same prefix", () => {
    expect(
      findProjectDevServerForLocalServer({
        localServer: makeLocalServer({ cwd: "/repo/app-other" }),
        devServers: [makeDevServer({ cwd: "/repo/app" })],
      }),
    ).toBeNull();
  });
});

describe("waitForProjectDevServerReadiness", () => {
  it("returns only after the tracked run owns a reachable listener", async () => {
    let calls = 0;
    const result = await waitForProjectDevServerReadiness(makeDevServer({ status: "starting" }), {
      timeoutMs: 100,
      pollMs: 0,
      discover: async () => {
        calls += 1;
        return calls === 1 ? [] : [makeLocalServer({ cwd: "/repo/app", ppid: 100 })];
      },
      probe: async () => true,
      sleep: async () => undefined,
    });

    expect(calls).toBe(2);
    expect(result).toEqual({ url: "http://127.0.0.1:5173", ports: [5173] });
  });

  it("does not probe an unrelated reachable listener with the same cwd", async () => {
    let probes = 0;
    const result = await waitForProjectDevServerReadiness(
      makeDevServer({ pid: 100, status: "starting" }),
      {
        timeoutMs: 0,
        discover: async () => [makeLocalServer({ cwd: "/repo/app", pid: 200, ppid: 1 })],
        probe: async () => {
          probes += 1;
          return true;
        },
        sleep: async () => undefined,
      },
    );

    expect(result).toBeNull();
    expect(probes).toBe(0);
  });

  it("fails closed when no listener becomes ready", async () => {
    expect(
      await waitForProjectDevServerReadiness(makeDevServer({ status: "starting" }), {
        timeoutMs: 0,
        discover: async () => [],
        sleep: async () => undefined,
      }),
    ).toBeNull();
  });
});

describe("failProjectDevServerGeneration", () => {
  it("ignores a delayed exit from a superseded run", () => {
    const current = makeDevServer({ runId: "new-run", status: "starting" });
    expect(failProjectDevServerGeneration(current, "old-run", "late exit")).toBeNull();
    expect(failProjectDevServerGeneration(current, "new-run", "current exit")).toMatchObject({
      runId: "new-run",
      status: "failed",
      error: "current exit",
    });
  });
});
