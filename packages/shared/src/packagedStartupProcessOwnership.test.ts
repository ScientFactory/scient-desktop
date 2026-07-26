import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readPackagedStartupOwnedProcesses,
  readWindowsProcessInstanceId,
  recordPackagedStartupOwnedProcess,
  recordWindowsPackagedStartupOwnedProcess,
  resolvePackagedStartupProcessOwnershipPath,
} from "./packagedStartupProcessOwnership";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("packaged startup process ownership", () => {
  it("round-trips authenticated process authority without persisting the verifier token", () => {
    const root = mkdtempSync(join(tmpdir(), "scient-packaged-ownership-test-"));
    roots.push(root);
    const environment = {
      SCIENT_HOME: root,
      SCIENT_PACKAGED_STARTUP_SMOKE: "1",
      SCIENT_PACKAGED_STARTUP_CLEANUP_TOKEN: "a".repeat(64),
    };

    recordPackagedStartupOwnedProcess(environment, {
      pid: 42,
      processGroup: true,
      instanceId: "638891234567890123",
    });

    expect(readPackagedStartupOwnedProcesses(environment)).toEqual([
      {
        schemaVersion: 2,
        pid: 42,
        processGroup: true,
        instanceId: "638891234567890123",
        authenticator: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    expect(readFileSync(resolvePackagedStartupProcessOwnershipPath(root), "utf8")).not.toContain(
      "a".repeat(64),
    );
    expect(
      readPackagedStartupOwnedProcesses({
        ...environment,
        SCIENT_PACKAGED_STARTUP_CLEANUP_TOKEN: "b".repeat(64),
      }),
    ).toEqual([]);
  });

  it("ignores malformed, truncated, and duplicated authority records", () => {
    const root = mkdtempSync(join(tmpdir(), "scient-packaged-ownership-test-"));
    roots.push(root);
    const environment = {
      SCIENT_HOME: root,
      SCIENT_PACKAGED_STARTUP_SMOKE: "1",
      SCIENT_PACKAGED_STARTUP_CLEANUP_TOKEN: "c".repeat(64),
    };
    recordPackagedStartupOwnedProcess(environment, {
      pid: 84,
      processGroup: false,
      instanceId: "638891234567890456",
    });
    const path = resolvePackagedStartupProcessOwnershipPath(root);
    const validRecord = readFileSync(path, "utf8").trim();
    appendFileSync(
      path,
      [
        validRecord,
        JSON.stringify({
          schemaVersion: 2,
          pid: 126,
          processGroup: false,
          instanceId: "638891234567890789",
          authenticator: "0".repeat(64),
        }),
        "{truncated",
      ].join("\n"),
    );

    expect(readPackagedStartupOwnedProcesses(environment)).toEqual([
      {
        schemaVersion: 2,
        pid: 84,
        processGroup: false,
        instanceId: "638891234567890456",
        authenticator: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
  });

  it("preserves distinct authenticated process instances when Windows reuses a PID", () => {
    const root = mkdtempSync(join(tmpdir(), "scient-packaged-ownership-test-"));
    roots.push(root);
    const environment = {
      SCIENT_HOME: root,
      SCIENT_PACKAGED_STARTUP_SMOKE: "1",
      SCIENT_PACKAGED_STARTUP_CLEANUP_TOKEN: "e".repeat(64),
    };
    recordPackagedStartupOwnedProcess(environment, {
      pid: 84,
      processGroup: false,
      instanceId: "638891234567890456",
    });
    recordPackagedStartupOwnedProcess(environment, {
      pid: 84,
      processGroup: false,
      instanceId: "638891234567890789",
    });

    expect(
      readPackagedStartupOwnedProcesses(environment).map(({ pid, instanceId }) => ({
        pid,
        instanceId,
      })),
    ).toEqual([
      { pid: 84, instanceId: "638891234567890456" },
      { pid: 84, instanceId: "638891234567890789" },
    ]);
  });

  it("does not write authority outside packaged startup verification", () => {
    const root = mkdtempSync(join(tmpdir(), "scient-packaged-ownership-test-"));
    roots.push(root);

    recordPackagedStartupOwnedProcess(
      { SCIENT_HOME: root },
      { pid: 42, processGroup: true, instanceId: "638891234567890123" },
    );

    expect(readPackagedStartupOwnedProcesses({ SCIENT_HOME: root })).toEqual([]);
  });

  it("does not probe Windows process identity outside packaged startup verification", () => {
    const runProcess = vi.fn();

    expect(() =>
      recordWindowsPackagedStartupOwnedProcess({ SCIENT_HOME: "/unused" }, 42, runProcess),
    ).not.toThrow();

    expect(runProcess).not.toHaveBeenCalled();
  });

  it("records the probed Windows process instance during packaged startup verification", () => {
    const root = mkdtempSync(join(tmpdir(), "scient-packaged-ownership-test-"));
    roots.push(root);
    const environment = {
      SCIENT_HOME: root,
      SCIENT_PACKAGED_STARTUP_SMOKE: "1",
      SCIENT_PACKAGED_STARTUP_CLEANUP_TOKEN: "f".repeat(64),
      SystemRoot: "D:\\Windows",
    };
    const runProcess = vi.fn(() => ({
      error: undefined,
      status: 0,
      stdout: "638891234567890999\r\n",
    }));

    recordWindowsPackagedStartupOwnedProcess(
      environment,
      42,
      runProcess as unknown as typeof import("node:child_process").spawnSync,
    );

    expect(readPackagedStartupOwnedProcesses(environment)).toEqual([
      expect.objectContaining({ pid: 42, instanceId: "638891234567890999" }),
    ]);
  });

  it("refuses weak cleanup capabilities and invalid process ids", () => {
    const root = mkdtempSync(join(tmpdir(), "scient-packaged-ownership-test-"));
    roots.push(root);
    const environment = {
      SCIENT_HOME: root,
      SCIENT_PACKAGED_STARTUP_SMOKE: "1",
      SCIENT_PACKAGED_STARTUP_CLEANUP_TOKEN: "too-short",
    };

    expect(() =>
      recordPackagedStartupOwnedProcess(environment, {
        pid: 42,
        processGroup: true,
        instanceId: "638891234567890123",
      }),
    ).toThrow("cleanup token");
    expect(() =>
      recordPackagedStartupOwnedProcess(
        {
          ...environment,
          SCIENT_PACKAGED_STARTUP_CLEANUP_TOKEN: "d".repeat(64),
        },
        { pid: 0, processGroup: true, instanceId: "638891234567890123" },
      ),
    ).toThrow("positive PID");
    expect(() =>
      recordPackagedStartupOwnedProcess(
        {
          ...environment,
          SCIENT_PACKAGED_STARTUP_CLEANUP_TOKEN: "d".repeat(64),
        },
        { pid: 42, processGroup: false, instanceId: "not-a-process-instance" },
      ),
    ).toThrow("process instance id");
  });

  it("reads the Windows process creation identity without invoking a shell", () => {
    const runProcess = vi.fn(() => ({
      error: undefined,
      status: 0,
      stdout: "638891234567890123\r\n",
    }));

    expect(
      readWindowsProcessInstanceId(
        42,
        { SystemRoot: "D:\\Windows" },
        runProcess as unknown as typeof import("node:child_process").spawnSync,
      ),
    ).toBe("638891234567890123");
    expect(runProcess).toHaveBeenCalledWith(
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      expect.arrayContaining(["-NonInteractive", "-Command"]),
      expect.objectContaining({ shell: false, timeout: 5_000, windowsHide: true }),
    );
  });
});
