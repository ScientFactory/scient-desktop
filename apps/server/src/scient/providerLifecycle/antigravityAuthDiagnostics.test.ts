import { describe, expect, it } from "vite-plus/test";
import * as AcpErrors from "effect-acp/errors";

import { antigravityAuthFailureDiagnostic } from "./antigravityAuthDiagnostics.ts";

const sensitive = "C:/private/profile/secret-key https://accounts.google.com/auth?code=secret-code";

describe("Antigravity auth diagnostics", () => {
  it("retains allowlisted nested errno without command, path or native output", () => {
    const error = new AcpErrors.AcpSpawnError({
      command: sensitive,
      cause: { cause: { code: "EACCES", path: sensitive, message: sensitive } },
    });
    expect(antigravityAuthFailureDiagnostic(error, true)).toEqual({
      phase: "before-authorization",
      failureType: "AcpSpawnError",
      systemErrorCode: "EACCES",
    });
  });

  it("retains a Windows native exit status without stderr", () => {
    const error = new AcpErrors.AcpProcessExitedError({ code: 0xc0000135, stderr: sensitive });
    expect(antigravityAuthFailureDiagnostic(error, false)).toEqual({
      phase: "after-authorization",
      failureType: "AcpProcessExitedError",
      exitCode: 0xc0000135,
    });
  });

  it("omits untrusted tags, codes and defect text", () => {
    const diagnostic = antigravityAuthFailureDiagnostic(
      {
        _tag: sensitive,
        code: sensitive,
        cause: new Error(sensitive),
      },
      true,
    );
    expect(diagnostic).toEqual({ phase: "before-authorization", failureType: "unknown" });
    expect(JSON.stringify(diagnostic)).not.toContain("secret");
  });

  it("bounds traversal of cyclic native causes", () => {
    const error: { _tag: string; cause?: unknown } = { _tag: "AcpTransportError" };
    error.cause = error;
    expect(antigravityAuthFailureDiagnostic(error, true)).toEqual({
      phase: "before-authorization",
      failureType: "AcpTransportError",
    });
  });
});
