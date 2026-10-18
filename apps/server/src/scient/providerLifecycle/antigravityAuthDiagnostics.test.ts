import { describe, expect, it } from "vite-plus/test";
import * as AcpErrors from "effect-acp/errors";

import {
  antigravityAcpRequestDiagnostic,
  antigravityAuthFailureDiagnostic,
  localAntigravityNativeText,
} from "./antigravityAuthDiagnostics.ts";

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

describe("Antigravity failed ACP request diagnostics", () => {
  const home = String.raw`C:\Users\Ada Lovelace`;
  const details = String.raw`Failed to initialize conversation at ws://localhost:51234/?token=secret-token. Stderr: Failed to create agent: failed to create workspace folder "file:///C:/Users/Ada%20Lovelace/x": mkdir C:\Users\Ada Lovelace\.scient-next\userdata\providers\antigravity\p\config\skills: Cannot create a file when that file already exists.`;

  it("keeps the method, code, message and details with the home shown as ~", () => {
    const error = new AcpErrors.AcpRequestError({
      code: -32603,
      errorMessage: "Internal error",
      data: { details },
      method: "session/new",
    });
    const diagnostic = antigravityAcpRequestDiagnostic(error, home);
    expect(diagnostic).toMatchObject({
      acpMethod: "session/new",
      acpCode: -32603,
      acpMessage: "Internal error",
    });
    expect(diagnostic.acpDetails).toContain(String.raw`mkdir ~\.scient-next\userdata`);
    expect(diagnostic.acpDetails).toContain('"file:///~/x"');
    expect(diagnostic.acpDetails).toContain("ws://localhost:51234/ Stderr");
    expect(diagnostic.acpDetails).not.toContain("secret-token");
    expect(diagnostic.acpDetails).not.toContain("Lovelace");
  });

  it("bounds native text to 500 characters and removes URL queries", () => {
    const text = localAntigravityNativeText(
      `${"x".repeat(600)} https://accounts.google.com/auth?code=secret-code#state`,
      "/home/ada",
    );
    expect(text.length).toBe(500);
    expect(localAntigravityNativeText(sensitive, "/home/ada")).not.toContain("secret-code");
    expect(localAntigravityNativeText("a\u0000b\nc", "/home/ada")).toBe("a b c");
  });

  it("adds nothing for other failures", () => {
    expect(
      antigravityAcpRequestDiagnostic(new AcpErrors.AcpProcessExitedError({ code: 1 }), home),
    ).toEqual({});
  });
});
