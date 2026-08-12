import {
  RemoteEnvironmentAuthFetchError,
  RemoteEnvironmentAuthInvalidJsonError,
  RemoteEnvironmentAuthTimeoutError,
} from "@t3tools/client-runtime/rpc";
import { describe, expect, it } from "vite-plus/test";

import { scientSourcesErrorMessage } from "./errorMessage";

describe("Scient Sources error messages", () => {
  it("requires a candidate restart when development contracts are out of sync", () => {
    const error = new RemoteEnvironmentAuthInvalidJsonError({
      message:
        "Remote environment endpoint returned an invalid response from http://127.0.0.1:14774/api/scient/sources/zotero/library.",
      cause: new Error("pdfAttachmentCount is missing"),
    });

    expect(scientSourcesErrorMessage(error, true)).toBe(
      "This Scient (Dev) app and its local server are out of sync. Restart this candidate, then try again.",
    );
  });

  it("keeps the production compatibility message environment-neutral", () => {
    const error = new RemoteEnvironmentAuthInvalidJsonError({
      message:
        "Remote environment endpoint returned an invalid response from https://example.test.",
      cause: new Error("invalid response"),
    });

    expect(scientSourcesErrorMessage(error, false)).toBe(
      "Scient received source data that this app version cannot read. Update or reconnect the selected environment, then try again.",
    );
  });

  it("does not call local endpoint failures remote", () => {
    expect(
      scientSourcesErrorMessage(
        new RemoteEnvironmentAuthTimeoutError("http://127.0.0.1:14774/api/scient/sources", 25),
        true,
      ),
    ).toBe(
      "The selected environment endpoint http://127.0.0.1:14774/api/scient/sources timed out after 25ms.",
    );

    expect(
      scientSourcesErrorMessage(
        new RemoteEnvironmentAuthFetchError({
          message:
            "Failed to fetch remote environment endpoint http://127.0.0.1:14774/api/scient/sources (offline).",
          cause: new Error("offline"),
        }),
        true,
      ),
    ).toBe(
      "Scient could not reach the selected environment endpoint http://127.0.0.1:14774/api/scient/sources (offline).",
    );
  });
});
