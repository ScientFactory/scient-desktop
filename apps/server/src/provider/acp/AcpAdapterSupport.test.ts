import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@t3tools/contracts";

import { acpPermissionOutcome, mapAcpToAdapterError } from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("maps ACP approval decisions to permission outcomes", () => {
    expect(acpPermissionOutcome("accept")).toBe("allow-once");
    expect(acpPermissionOutcome("acceptForSession")).toBe("allow-always");
    expect(acpPermissionOutcome("decline")).toBe("reject-once");
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });

  it("lets the adapter rewrite the agent's text before it becomes the error's detail", () => {
    const redact = (message: string) => message.replaceAll("fk-live-0123456789", "[redacted]");
    for (const cause of [
      new EffectAcpErrors.AcpRequestError({
        code: -32000,
        errorMessage: "Key fk-live-0123456789 was refused",
      }),
      new EffectAcpErrors.AcpProcessExitedError({ code: 1, stderr: "bad key fk-live-0123456789" }),
    ]) {
      const error = mapAcpToAdapterError(
        ProviderDriverKind.make("droid"),
        "thread-1" as never,
        "session/start",
        cause,
        redact,
      );
      expect(error.message).toContain("[redacted]");
      expect(error.message).not.toContain("fk-live-0123456789");
    }
  });

  it("maps ACP process exits without stderr to a process error instead of a closed session", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/start",
      new EffectAcpErrors.AcpProcessExitedError({ code: 1 }),
    );

    expect(error._tag).toBe("ProviderAdapterProcessError");
    expect(error.message).not.toContain("adapter thread is closed");
    if (error._tag === "ProviderAdapterProcessError") {
      expect(error.detail).toBe("ACP process exited with code 1");
    }
  });

  it("maps ACP process exits to a process error whose detail includes stderr", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/start",
      new EffectAcpErrors.AcpProcessExitedError({
        code: 1,
        stderr:
          "Invalid project config at ~/.cursor/cli.json: schema validation failed. Unrecognized key(s): 'approvalMode', 'sandbox'",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterProcessError");
    expect(error.message).toContain("cli.json");
    expect(error.message).toContain("Unrecognized key");
    expect(error.message).not.toContain("adapter thread is closed");
    if (error._tag === "ProviderAdapterProcessError") {
      expect(error.detail).toContain("Unrecognized key(s): 'approvalMode', 'sandbox'");
    }
  });
});
