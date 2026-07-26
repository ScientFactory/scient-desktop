import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    });

    expect(readPackagedStartupOwnedProcesses(environment)).toEqual([
      {
        schemaVersion: 2,
        pid: 42,
        processGroup: true,
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
        authenticator: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
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
      recordPackagedStartupOwnedProcess(environment, {
        pid: 42,
        processGroup: true,
      }),
    ).toThrow("cleanup token");
    expect(() =>
      recordPackagedStartupOwnedProcess(
        {
          ...environment,
          SCIENT_PACKAGED_STARTUP_CLEANUP_TOKEN: "d".repeat(64),
        },
        { pid: 0, processGroup: true },
      ),
    ).toThrow("positive PID");
  });
});
