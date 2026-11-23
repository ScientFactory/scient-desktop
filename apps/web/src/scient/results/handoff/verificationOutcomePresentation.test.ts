import type { ResultHandoffVerification } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { verificationOutcomeSummary } from "./verificationOutcomePresentation";

const env: NonNullable<ResultHandoffVerification["environment"]> = {
  language: "Python",
  version: "3.12.13",
  platform: "darwin",
  architecture: "arm64",
  locale: "en_US.UTF-8",
  timezone: "UTC",
};

describe("verificationOutcomeSummary", () => {
  it("uses Verified only when all outputs matched without caveats", () => {
    expect(
      verificationOutcomeSummary({
        status: "verified",
        environment: env,
        outputs: [
          { path: "metrics.json", status: "matched" },
          { path: "roc.png", status: "matched" },
        ],
      }),
    ).toEqual({ label: "Verified", completed: true });
  });

  it("qualifies verified reports when figures differ, outputs are unchecked, or both", () => {
    expect(
      verificationOutcomeSummary({
        status: "verified",
        environment: env,
        outputs: [
          { path: "metrics.json", status: "matched" },
          { path: "roc.png", status: "differs" },
        ],
      }),
    ).toEqual({
      label: "Checked outputs matched · figures need review",
      completed: true,
    });

    expect(
      verificationOutcomeSummary({
        status: "verified",
        environment: env,
        outputs: [
          { path: "metrics.json", status: "matched" },
          { path: "skipped.csv", status: "unchecked" },
        ],
      }),
    ).toEqual({
      label: "Checked outputs matched · some outputs unchecked",
      completed: true,
    });

    expect(
      verificationOutcomeSummary({
        status: "verified",
        environment: env,
        message:
          "Checked values, tables, and data files matched. Some original outputs were unavailable.",
        outputs: [{ path: "metrics.json", status: "matched" }],
      }),
    ).toEqual({
      label: "Checked outputs matched · some outputs unchecked",
      completed: true,
    });

    expect(
      verificationOutcomeSummary({
        status: "verified",
        environment: env,
        outputs: [
          { path: "metrics.json", status: "matched" },
          { path: "roc.png", status: "differs" },
          { path: "skipped.csv", status: "unchecked" },
        ],
      }),
    ).toEqual({
      label: "Checked outputs matched · review figures and unchecked outputs",
      completed: true,
    });
  });

  it("distinguishes completed figure-only reruns from runs that failed to start or execute", () => {
    expect(
      verificationOutcomeSummary({
        status: "could-not-run",
        environment: env,
        message:
          "The rerun finished with no retained values, tables, or data files to verify automatically. Review the differing figures.",
        outputs: [{ path: "roc.png", status: "differs" }],
      }),
    ).toEqual({
      label: "Rerun finished · figures need review",
      completed: true,
    });

    expect(
      verificationOutcomeSummary({
        status: "could-not-run",
        environment: env,
        message:
          "The rerun finished and figure bytes matched, with no retained values, tables, or data files to verify automatically.",
        outputs: [{ path: "roc.png", status: "matched" }],
      }),
    ).toEqual({
      label: "Rerun finished · figures matched",
      completed: true,
    });

    expect(
      verificationOutcomeSummary({
        status: "could-not-run",
        environment: env,
        rerunCompleted: true,
        outputs: [{ path: "pruned.csv", status: "unchecked" }],
      }),
    ).toEqual({
      label: "Rerun finished · no checkable outputs",
      completed: true,
    });

    expect(
      verificationOutcomeSummary({
        status: "could-not-run",
        environment: env,
        message: "The script exited with code 1.",
        outputs: [{ path: "roc.png", status: "unchecked" }],
      }),
    ).toEqual({
      label: "Could not run",
      completed: false,
    });

    expect(
      verificationOutcomeSummary({
        status: "could-not-run",
        environment: null,
        message: "Some expected files are missing, changed, or cannot be checked.",
        outputs: [{ path: "metrics.json", status: "unchecked" }],
      }),
    ).toEqual({
      label: "Could not run",
      completed: false,
    });
  });
});
