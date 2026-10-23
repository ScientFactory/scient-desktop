import { describe, expect, it } from "vite-plus/test";
import * as AcpErrors from "effect-acp/errors";

import {
  antigravityAcpRequestDiagnostic,
  antigravityAuthFailureDiagnostic,
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
  const failed = (errorMessage: string, details?: string) =>
    antigravityAcpRequestDiagnostic(
      new AcpErrors.AcpRequestError({
        code: -32603,
        errorMessage,
        method: "session/new",
        ...(details === undefined ? {} : { data: { details } }),
      }),
    );

  it("classifies the workspace-folder incident by kind, profile folder and error code", () => {
    const windows = String.raw`Failed to initialize conversation at ws://localhost:51234/?token=secret-token. Stderr: Failed to create agent: failed to create LocalAgent: failed to create agent executor opts: failed to create workspace folder "file:///C:/Users/Ada%20Lovelace/.scient-next/userdata/providers/antigravity/0a1b/config/skills": mkdir C:\Users\Ada Lovelace\.scient-next\userdata\providers\antigravity\0a1b\config\skills: Cannot create a file when that file already exists.`;
    expect(failed("Internal error", windows)).toEqual({
      acpMethod: "session/new",
      acpCode: -32603,
      acpMessage: "Internal error",
      detailsKind: "workspace_folder_create_failed",
      detailsFolder: "skills",
      detailsErrorCode: "EEXIST",
    });
    expect(
      failed(
        "Internal error",
        'failed to create workspace folder "file:///home/ada/p/antigravity-cli/skills": mkdir /home/ada/p/antigravity-cli/skills: permission denied',
      ),
    ).toMatchObject({ detailsFolder: "skills", detailsErrorCode: "EACCES" });
    expect(
      failed(
        "Internal error",
        String.raw`failed to create workspace folder "file:///C:/Users/ada/private-notes": mkdir C:\x: The system cannot find the path specified.`,
      ),
    ).toEqual({
      acpMethod: "session/new",
      acpCode: -32603,
      acpMessage: "Internal error",
      detailsKind: "workspace_folder_create_failed",
      detailsErrorCode: "ENOENT",
    });
  });

  it.each([
    ["cookies", "Cookie: SID=abc123; HSID=secret456", ["abc123", "secret456"]],
    [
      "escaped JSON passwords",
      String.raw`{\"password\":\"hunter2\",\"user\":\"ada\"}`,
      ["hunter2", "ada"],
    ],
    [
      "nested credential objects",
      '{"auth":{"credentials":{"refresh_token":"1//0gAbcD","client_secret":"s3cr3t"}}}',
      ["1//0gAbcD", "s3cr3t"],
    ],
    ["bearer tokens", "Authorization: Bearer ya29.a0AfH6SMB-secret", ["ya29", "secret"]],
    ["paths", String.raw`open C:\Users\Ada Lovelace\notes\plan.md failed`, ["Ada", "plan.md"]],
  ])("keeps no trace of the values in %s", (_name, details, values) => {
    const diagnostic = failed("Internal error", details);
    expect(diagnostic).toEqual({
      acpMethod: "session/new",
      acpCode: -32603,
      acpMessage: "Internal error",
      detailsKind: "unrecognized",
      detailsLength: details.length,
    });
    for (const value of values) expect(JSON.stringify(diagnostic)).not.toContain(value);
  });

  it("keeps only a standard JSON-RPC message", () => {
    expect(failed("Method not found")).toMatchObject({ acpMessage: "Method not found" });
    const custom = failed("Internal error: token=secret-token at C:/Users/ada");
    expect(custom).not.toHaveProperty("acpMessage");
    expect(JSON.stringify(custom)).not.toContain("secret-token");
  });

  it("adds nothing for other failures", () => {
    expect(
      antigravityAcpRequestDiagnostic(new AcpErrors.AcpProcessExitedError({ code: 1 })),
    ).toEqual({});
  });
});
