import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readPackagedStartupOwnedProcesses,
  recordPackagedStartupOwnedProcess,
  resolvePackagedStartupProcessOwnershipPath,
} from "./packagedStartupProcessOwnership";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("packaged startup process ownership", () => {
  it("round-trips only process authority bearing the verifier token", () => {
    const root = mkdtempSync(join(tmpdir(), "scient-packaged-ownership-test-"));
    roots.push(root);
    const environment = {
      SCIENT_HOME: root,
      SCIENT_PACKAGED_STARTUP_SMOKE: "1",
      SCIENT_PACKAGED_STARTUP_CLEANUP_TOKEN: "a".repeat(64),
    };

    recordPackagedStartupOwnedProcess(environment, { pid: 42, processGroup: true });

    expect(readPackagedStartupOwnedProcesses(environment)).toEqual([
      { schemaVersion: 1, token: "a".repeat(64), pid: 42, processGroup: true },
    ]);
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
    const token = "c".repeat(64);
    const environment = {
      SCIENT_HOME: root,
      SCIENT_PACKAGED_STARTUP_CLEANUP_TOKEN: token,
    };
    const path = resolvePackagedStartupProcessOwnershipPath(root);
    mkdirSync(join(root, "userdata"), { recursive: true });
    writeFileSync(
      path,
      [
        JSON.stringify({ schemaVersion: 1, token, pid: 84, processGroup: false }),
        JSON.stringify({ schemaVersion: 1, token, pid: 84, processGroup: false }),
        JSON.stringify({ schemaVersion: 1, token: "wrong", pid: 126, processGroup: false }),
        "{truncated",
      ].join("\n"),
    );

    expect(readPackagedStartupOwnedProcesses(environment)).toEqual([
      { schemaVersion: 1, token, pid: 84, processGroup: false },
    ]);
  });

  it("does not write authority outside packaged startup verification", () => {
    const root = mkdtempSync(join(tmpdir(), "scient-packaged-ownership-test-"));
    roots.push(root);

    recordPackagedStartupOwnedProcess({ SCIENT_HOME: root }, { pid: 42, processGroup: true });

    expect(readPackagedStartupOwnedProcesses({ SCIENT_HOME: root })).toEqual([]);
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
      recordPackagedStartupOwnedProcess(environment, { pid: 42, processGroup: true }),
    ).toThrow("cleanup token");
    expect(() =>
      recordPackagedStartupOwnedProcess(
        { ...environment, SCIENT_PACKAGED_STARTUP_CLEANUP_TOKEN: "d".repeat(64) },
        { pid: 0, processGroup: true },
      ),
    ).toThrow("positive PID");
  });
});
