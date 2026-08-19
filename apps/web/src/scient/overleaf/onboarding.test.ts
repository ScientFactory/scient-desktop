import { describe, expect, it } from "vite-plus/test";

import {
  normalizeOverleafClipboardText,
  overleafNewProjectUrl,
  overleafProjectDashboardUrl,
  shouldAutoCompleteOverleafPreflight,
} from "./onboarding";

const readyPreflight = {
  operationId: "operation-1",
  connectionId: "connection-1",
  kind: "connect" as const,
  phase: "awaiting_push_confirmation" as const,
  connectStage: "preflight" as const,
  generation: 3,
  message: "Ready",
  progress: null,
  review: {
    candidateCommit: "abc123",
    changes: [],
    warnings: [],
    requiresConfirmation: false,
  },
  conflicts: [],
  errorCode: null,
  retryable: false,
  startedAtEpochMs: 1,
  updatedAtEpochMs: 2,
};

describe("Overleaf onboarding", () => {
  it("opens the correct project dashboard for Cloud and Server Pro", () => {
    expect(overleafProjectDashboardUrl(null)).toBe("https://www.overleaf.com/project");
    expect(overleafProjectDashboardUrl({ kind: "cloud", host: "git.overleaf.com" })).toBe(
      "https://www.overleaf.com/project",
    );
    expect(overleafProjectDashboardUrl({ kind: "server-pro", host: "latex.example.edu" })).toBe(
      "https://latex.example.edu/project",
    );
    expect(overleafNewProjectUrl({ kind: "server-pro", host: "latex.example.edu" })).toBe(
      "https://latex.example.edu/project/new",
    );
  });

  it("trims explicit clipboard reads without interpreting pasted commands", () => {
    expect(normalizeOverleafClipboardText("  git clone https://git.overleaf.com/abc  \r\n")).toBe(
      "git clone https://git.overleaf.com/abc",
    );
  });

  it("continues a warning-free Safe Combine preflight automatically", () => {
    expect(
      shouldAutoCompleteOverleafPreflight({
        open: true,
        mode: "combine",
        operation: readyPreflight,
      }),
    ).toBe(true);
  });

  it("never skips warnings, advanced reconciliation, or explicit dialog opening", () => {
    expect(
      shouldAutoCompleteOverleafPreflight({
        open: false,
        mode: "combine",
        operation: readyPreflight,
      }),
    ).toBe(false);
    expect(
      shouldAutoCompleteOverleafPreflight({
        open: true,
        mode: "replace-local",
        operation: readyPreflight,
      }),
    ).toBe(false);
    expect(
      shouldAutoCompleteOverleafPreflight({
        open: true,
        mode: "combine",
        operation: {
          ...readyPreflight,
          review: {
            ...readyPreflight.review,
            warnings: [
              {
                kind: "project_size" as const,
                message: "Large project",
                paths: [],
                blocking: true,
                suppressible: false,
              },
            ],
          },
        },
      }),
    ).toBe(false);
    expect(
      shouldAutoCompleteOverleafPreflight({
        open: true,
        mode: "combine",
        operation: { ...readyPreflight, review: null },
      }),
    ).toBe(false);
    expect(
      shouldAutoCompleteOverleafPreflight({
        open: true,
        mode: "combine",
        operation: {
          ...readyPreflight,
          review: { ...readyPreflight.review, requiresConfirmation: true },
        },
      }),
    ).toBe(false);
  });
});
