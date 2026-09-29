import { EnvironmentId, ScientConversationImportError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ConversationImportNotice,
  desktopUploadOutcome,
  importEnvironmentOptions,
  importFailureMessage,
  importFileProblem,
} from "./importDialog.logic";

describe("importEnvironmentOptions", () => {
  it("names this device and remote environments, never by ID, this device first", () => {
    const local = EnvironmentId.make("4b1b7c1e-8d1f-4a5e-9b0e-0c9f5f1d2a3b");
    const remote = EnvironmentId.make("9f0e1d2c-3b4a-4596-8778-695a4b3c2d1e");
    expect(
      importEnvironmentOptions({
        environmentIds: [remote, local],
        labels: new Map([
          [local, "Local"],
          [remote, "Lab workstation"],
        ]),
        connected: new Set([local]),
        primaryEnvironmentId: local,
      }),
    ).toEqual([
      { environmentId: local, label: "This device", connected: true },
      { environmentId: remote, label: "Lab workstation", connected: false },
    ]);
  });
});

describe("importFileProblem", () => {
  it("refuses other formats, empty files, and files over the limit", () => {
    expect(importFileProblem("notes.scic", 10)).toBeNull();
    expect(importFileProblem("Notes.MD", 10)).toBeNull();
    expect(importFileProblem("notes.txt", 10)).toContain("(.scic)");
    expect(importFileProblem("notes.scic", 0)).toBe("This file is empty.");
    expect(importFileProblem("notes.md", 17 * 1024 * 1024)).toBe(
      "This file is larger than Scient can import.",
    );
  });
});

describe("importFailureMessage", () => {
  const rejected = (message: string, entry: string | null = null) =>
    new ScientConversationImportError({
      reason: "package-rejected",
      rejection: { reason: "unsafe-path", entry },
      message,
    });

  it("shows the server's plain message for a rejected file", () => {
    expect(importFailureMessage(rejected("This file is damaged."), "fallback")).toBe(
      "This file is damaged.",
    );
  });

  it("never shows reason codes or entry paths", () => {
    const expected = "This file can't be imported. It didn't pass Scient's checks.";
    expect(importFailureMessage(rejected("Rejected: unsafe-path"), "fallback")).toBe(expected);
    expect(
      importFailureMessage(
        rejected("Entry attachments/../../etc is unsafe.", "attachments/../../etc"),
        "fallback",
      ),
    ).toBe(expected);
    expect(importFailureMessage(rejected("Bad entry at C:\\temp\\x"), "fallback")).toBe(expected);
  });

  it("keeps connection and internal errors out of the dialog", () => {
    expect(
      importFailureMessage(
        new Error(
          "Failed to fetch remote environment endpoint http://127.0.0.1:1234/api (TypeError)",
        ),
        "This file couldn't be checked. Try again.",
      ),
    ).toBe("This file couldn't be checked. Try again.");
    expect(importFailureMessage(new ConversationImportNotice("Plain words."), "fallback")).toBe(
      "Plain words.",
    );
  });
});

describe("desktopUploadOutcome", () => {
  it("treats a declined prompt or a cancel as stopping, and words other failures plainly", () => {
    expect(desktopUploadOutcome({ _tag: "uploaded" })).toEqual({ _tag: "uploaded" });
    for (const reason of ["declined", "cancelled"] as const) {
      expect(desktopUploadOutcome({ _tag: "failed", reason })).toEqual({ _tag: "stopped" });
    }
    for (const reason of [
      "rejected",
      "file-unavailable",
      "file-changed",
      "invalid-url",
      "network-failed",
    ] as const) {
      const outcome = desktopUploadOutcome({ _tag: "failed", reason });
      expect(outcome).toBeInstanceOf(ConversationImportNotice);
      expect((outcome as ConversationImportNotice).message).not.toContain(reason);
    }
    expect(desktopUploadOutcome(undefined)).toBeInstanceOf(ConversationImportNotice);
  });
});
