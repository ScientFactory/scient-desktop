import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { MacNotarizationCommandError, findMatchingHistorySubmission, runMacNotarization } =
  require("./lib/mac-notarization.cjs") as {
    readonly MacNotarizationCommandError: new (
      message: string,
      details?: Record<string, unknown>,
    ) => Error;
    readonly findMatchingHistorySubmission: (
      history: unknown,
      archiveName: string,
      submittedAtMs: number,
    ) => { readonly id: string } | undefined;
    readonly runMacNotarization: (
      input: Record<string, unknown>,
      dependencies: Record<string, unknown>,
    ) => Promise<{ readonly submissionId: string }>;
  };

const APP_DETAILS = [
  "Identifier=com.scientfactory.scient",
  "Authority=Developer ID Application: ScientFactory (TEAM123)",
  "TeamIdentifier=TEAM123",
  "Timestamp=21 Jul 2026 at 17:30:00",
  "flags=0x10000(runtime)",
].join("\n");
const HELPER_DETAILS = [
  "Identifier=com.scientfactory.scient.appsnap",
  "Authority=Developer ID Application: ScientFactory (TEAM123)",
  "TeamIdentifier=TEAM123",
  "Timestamp=21 Jul 2026 at 17:30:00",
  "flags=0x10000(runtime)",
].join("\n");
const ENVIRONMENT = {
  APPLE_API_ISSUER: "issuer-secret",
  APPLE_API_KEY: "/runner/AuthKey_secret.p8",
  APPLE_API_KEY_ID: "key-id-secret",
};

function createFileOperations() {
  const files = new Map<string, string>();
  return {
    files,
    operations: {
      createTempDirectory: vi.fn(() => "/tmp/scient-notarization-test"),
      ensureDirectory: vi.fn(),
      fileExists: vi.fn(() => true),
      removeDirectory: vi.fn(),
      writeFileAtomically: vi.fn((path: string, contents: string) => files.set(path, contents)),
    },
  };
}

function createInput() {
  return {
    appPath: "/stage/Scient.app",
    arch: "arm64",
    commit: "abc123",
    environment: ENVIRONMENT,
    evidenceDirectory: "/release",
    productName: "Scient",
    version: "0.5.9",
  };
}

function signatureResult(args: readonly string[]) {
  if (args.includes("-dv")) {
    const appPath = args.at(-1) ?? "";
    const electronIdentifier = appPath.includes("Scient Helper (GPU).app")
      ? "com.scientfactory.scient.helper.GPU"
      : appPath.includes("Scient Helper (Plugin).app")
        ? "com.scientfactory.scient.helper.Plugin"
        : appPath.includes("Scient Helper (Renderer).app")
          ? "com.scientfactory.scient.helper.Renderer"
          : appPath.includes("Scient Helper.app")
            ? "com.scientfactory.scient.helper"
            : null;
    return {
      stderr: electronIdentifier
        ? [
            `Identifier=${electronIdentifier}`,
            "Authority=Developer ID Application: ScientFactory (TEAM123)",
            "TeamIdentifier=TEAM123",
            "Timestamp=21 Jul 2026 at 17:30:00",
            "flags=0x10000(runtime)",
          ].join("\n")
        : args.some((argument) => argument.includes("scient-appsnap-helper"))
          ? HELPER_DETAILS
          : APP_DETAILS,
      stdout: "",
    };
  }
  if (args.includes("--entitlements")) {
    return { stderr: "<plist><dict/></plist>", stdout: "" };
  }
  return { stderr: "", stdout: "" };
}

describe("controlled macOS notarization", () => {
  it("captures an ID, polls Apple, retrieves the log, staples, and assesses the app", async () => {
    const { files, operations } = createFileOperations();
    const statuses = ["In Progress", "Accepted"];
    let nowMs = Date.parse("2026-07-21T14:30:00Z");
    const runCommand = vi.fn(async ({ args, command }: { args: string[]; command: string }) => {
      if (command === "/usr/bin/codesign") return signatureResult(args);
      if (args[0] === "notarytool" && args[1] === "submit") {
        return { stderr: "", stdout: JSON.stringify({ id: "submission-1" }) };
      }
      if (args[0] === "notarytool" && args[1] === "info") {
        return { stderr: "", stdout: JSON.stringify({ status: statuses.shift() }) };
      }
      if (args[0] === "notarytool" && args[1] === "log") {
        return { stderr: "", stdout: JSON.stringify({ issues: [], status: "Accepted" }) };
      }
      return { stderr: "", stdout: "" };
    });

    const result = await runMacNotarization(createInput(), {
      createId: () => "archive-id",
      fileOperations: operations,
      now: () => nowMs,
      runCommand,
      sleep: async (durationMs: number) => {
        nowMs += durationMs;
      },
      timeouts: { pollIntervalMs: 10, processingMs: 100 },
    });

    expect(result.submissionId).toBe("submission-1");
    const submitCall = runCommand.mock.calls.find(([call]) => call.args?.[1] === "submit");
    expect(submitCall?.[0].args).toContain("--no-wait");
    expect(submitCall?.[0].args).not.toContain("--wait");
    expect(runCommand.mock.calls.filter(([call]) => call.args?.[1] === "submit")).toHaveLength(1);
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["stapler", "staple", "--verbose", "/stage/Scient.app"],
      }),
    );
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "/usr/sbin/spctl",
      }),
    );
    const evidence = JSON.parse(files.get("/release/notarization-evidence-arm64.json") ?? "{}");
    expect(evidence.notarization).toMatchObject({
      logFile: "notarization-log-arm64.json",
      pollCount: 2,
      status: "Accepted",
      submissionId: "submission-1",
    });
    expect(evidence.signing).toEqual({ preflight: "passed", teamIdentifier: "TEAM123" });
    expect(evidence.verification).toEqual({ gatekeeper: "accepted", stapled: true });
    expect(files.get("/release/notarization-log-arm64.json")).toContain('"Accepted"');
  });

  it("retrieves the Apple log and fails before stapling an invalid submission", async () => {
    const { files, operations } = createFileOperations();
    const runCommand = vi.fn(async ({ args, command }: { args: string[]; command: string }) => {
      if (command === "/usr/bin/codesign") return signatureResult(args);
      if (args[1] === "submit") {
        return { stderr: "", stdout: JSON.stringify({ id: "invalid-submission" }) };
      }
      if (args[1] === "info") {
        return { stderr: "", stdout: JSON.stringify({ status: "Invalid" }) };
      }
      if (args[1] === "log") {
        return {
          stderr: "",
          stdout: JSON.stringify({ issues: [{ message: "invalid nested signature" }] }),
        };
      }
      return { stderr: "", stdout: "" };
    });

    await expect(
      runMacNotarization(createInput(), {
        createId: () => "archive-id",
        fileOperations: operations,
        runCommand,
        sleep: vi.fn(),
        timeouts: { pollIntervalMs: 1, processingMs: 100 },
      }),
    ).rejects.toThrow(/returned Invalid/);

    expect(runCommand.mock.calls.some(([call]) => call.args?.[0] === "stapler")).toBe(false);
    expect(files.get("/release/notarization-log-arm64.json")).toContain("invalid nested signature");
    const evidence = JSON.parse(files.get("/release/notarization-evidence-arm64.json") ?? "{}");
    expect(evidence.notarization.submissionId).toBe("invalid-submission");
    expect(evidence.notarization.status).toBe("Invalid");
    expect(evidence.notarization.failedAt).toBeTruthy();
  });

  it("recovers a lost submit response from history without resubmitting", async () => {
    const { files, operations } = createFileOperations();
    const submittedAt = Date.parse("2026-07-21T14:30:00Z");
    const runCommand = vi.fn(async ({ args, command }: { args: string[]; command: string }) => {
      if (command === "/usr/bin/codesign") return signatureResult(args);
      if (args[1] === "submit") {
        throw new MacNotarizationCommandError("submit timed out", {
          signal: "SIGTERM",
          timedOut: true,
        });
      }
      if (args[1] === "history") {
        return {
          stderr: "",
          stdout: JSON.stringify({
            history: [
              {
                createdDate: new Date(submittedAt).toISOString(),
                id: "recovered-submission",
                name: "Scient-arm64-archive-id.zip",
                status: "In Progress",
              },
            ],
          }),
        };
      }
      if (args[1] === "info") {
        return { stderr: "", stdout: JSON.stringify({ status: "Accepted" }) };
      }
      if (args[1] === "log") {
        return { stderr: "", stdout: JSON.stringify({ issues: [], status: "Accepted" }) };
      }
      return { stderr: "", stdout: "" };
    });

    const result = await runMacNotarization(createInput(), {
      createId: () => "archive-id",
      fileOperations: operations,
      now: () => submittedAt,
      runCommand,
      sleep: vi.fn(),
      timeouts: { historyRecoveryDelayMs: 0, pollIntervalMs: 1, processingMs: 100 },
    });

    expect(result.submissionId).toBe("recovered-submission");
    expect(runCommand.mock.calls.filter(([call]) => call.args?.[1] === "submit")).toHaveLength(1);
    const evidence = JSON.parse(files.get("/release/notarization-evidence-arm64.json") ?? "{}");
    expect(evidence.notarization.recoveredFromHistory).toBe(true);
  });

  it("fails with a resumable submission ID at the processing deadline", async () => {
    const { files, operations } = createFileOperations();
    let nowMs = 1_000;
    const runCommand = vi.fn(async ({ args, command }: { args: string[]; command: string }) => {
      if (command === "/usr/bin/codesign") return signatureResult(args);
      if (args[1] === "submit") {
        return { stderr: "", stdout: JSON.stringify({ id: "slow-submission" }) };
      }
      if (args[1] === "info") {
        return { stderr: "", stdout: JSON.stringify({ status: "In Progress" }) };
      }
      return { stderr: "", stdout: "" };
    });

    await expect(
      runMacNotarization(createInput(), {
        createId: () => "archive-id",
        fileOperations: operations,
        now: () => nowMs,
        runCommand,
        sleep: async (durationMs: number) => {
          nowMs += durationMs;
        },
        timeouts: { pollIntervalMs: 10, processingMs: 25 },
      }),
    ).rejects.toThrow(/submission slow-submission remains available/);

    expect(runCommand.mock.calls.filter(([call]) => call.args?.[1] === "submit")).toHaveLength(1);
    const evidenceText = files.get("/release/notarization-evidence-arm64.json") ?? "";
    const evidence = JSON.parse(evidenceText || "{}");
    expect(evidence.notarization.submissionId).toBe("slow-submission");
    expect(evidence.notarization.status).toBe("In Progress");
    expect(evidence.notarization.failedAt).toBeTruthy();
    expect(evidenceText).not.toContain(ENVIRONMENT.APPLE_API_KEY);
    expect(evidenceText).not.toContain(ENVIRONMENT.APPLE_API_KEY_ID);
    expect(evidenceText).not.toContain(ENVIRONMENT.APPLE_API_ISSUER);
  });

  it("matches only a recent exact archive name during history recovery", () => {
    const submittedAt = Date.parse("2026-07-21T14:30:00Z");
    const match = findMatchingHistorySubmission(
      {
        history: [
          {
            createdDate: "2026-07-21T13:00:00Z",
            id: "too-old",
            name: "Scient-arm64-id.zip",
          },
          {
            createdDate: "2026-07-21T14:30:01Z",
            id: "wrong-name",
            name: "Scient-x64-id.zip",
          },
          {
            createdDate: "2026-07-21T14:30:02Z",
            id: "expected",
            name: "Scient-arm64-id.zip",
          },
        ],
      },
      "Scient-arm64-id.zip",
      submittedAt,
    );

    expect(match?.id).toBe("expected");
  });
});
