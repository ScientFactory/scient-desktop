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
  const incident = String.raw`Failed to initialize conversation at ws://localhost:51234/?token=secret-token. Stderr: Failed to create agent: failed to create LocalAgent: failed to create agent executor opts: failed to create workspace folder "file:///C:/Users/Ada%20Lovelace/.scient-next/userdata/providers/antigravity/0a1b/config/skills": mkdir C:\Users\Ada Lovelace\.scient-next\userdata\providers\antigravity\0a1b\config\skills: Cannot create a file when that file already exists.`;

  it("keeps the incident readable while reducing its URLs and paths", () => {
    const diagnostic = antigravityAcpRequestDiagnostic(
      new AcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Internal error",
        data: { details: incident },
        method: "session/new",
      }),
    );
    expect(diagnostic).toEqual({
      acpMethod: "session/new",
      acpCode: -32603,
      acpMessage: "Internal error",
      acpDetails:
        'Failed to initialize conversation at ws://localhost Stderr: Failed to create agent: failed to create LocalAgent: failed to create agent executor opts: failed to create workspace folder "file://<path>/skills": mkdir <path>/skills: Cannot create a file when that file already exists.',
    });
  });

  it.each([
    [
      "URL userinfo, path and query",
      "see https://user:hunter2@example.com/a/b?code=x#f now",
      "see https://example.com now",
    ],
    [
      "a Windows path with spaces",
      String.raw`open C:\Users\Ada Lovelace\secret\notes.txt failed`,
      "open <path>/notes.txt failed",
    ],
    [
      "a UNC path",
      String.raw`read \\fileserver\share\private\plan.md failed`,
      "read <path>/plan.md failed",
    ],
    [
      "a POSIX path outside home",
      "missing /etc/private/keys/id_rsa now",
      "missing <path>/id_rsa now",
    ],
    ["a file URI", "at file:///home/ada/private/notes.md now", "at file://<path>/notes.md now"],
    [
      "a bearer token",
      "header Authorization: Bearer abc.def-ghi rejected",
      "header Authorization: <redacted> <redacted> rejected",
    ],
    ["a basic credential", "sent Basic dXNlcjpwYXNz back", "sent Basic <redacted> back"],
    ["a JWT", "jwt eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl end", "jwt <redacted> end"],
    [
      "a refresh_token pair",
      "refresh_token=1//0gAbcD rejected",
      "refresh_token=<redacted> rejected",
    ],
    [
      "a quoted JSON secret",
      String.raw`{"client_secret": "s3cr3t-value", "ok": 1}`,
      String.raw`{"client_secret": <redacted>, "ok": 1}`,
    ],
    ["a password pair", "password: hunter2 wrong", "password: <redacted> wrong"],
    ["a session cookie", "cookie=SID31d4; Path", "cookie=<redacted>; Path"],
    ["a long opaque run", "value AbCdEfGhIjKlMnOpQrStUvWxYz0123 left", "value <redacted> left"],
  ])("redacts %s", (_name, input, expected) => {
    expect(localAntigravityNativeText(input)).toBe(expected);
  });

  it("bounds native text to 500 characters and strips control characters", () => {
    expect(localAntigravityNativeText(`${"word ".repeat(200)}`).length).toBe(500);
    expect(localAntigravityNativeText("a\u0000b\nc")).toBe("a b c");
    expect(localAntigravityNativeText(sensitive)).not.toContain("secret-code");
  });

  it("adds nothing for other failures", () => {
    expect(
      antigravityAcpRequestDiagnostic(new AcpErrors.AcpProcessExitedError({ code: 1 })),
    ).toEqual({});
  });
});
