import * as NodeModule from "node:module";

import { describe, expect, it } from "@effect/vitest";

import { classifyUpdateFailure } from "./updateFailureClass.ts";

// electron-updater's own error helpers, which apps/desktop does not declare.
const requireFromUpdater = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("electron-updater"),
);
const { newError, HttpError, CancellationError } = requireFromUpdater("builder-util-runtime") as {
  newError: (message: string, code: string) => Error;
  HttpError: new (statusCode: number, message?: string) => Error;
  CancellationError: new () => Error;
};

const nodeError = (code: string, message: string) => Object.assign(new Error(message), { code });

describe("classifyUpdateFailure", () => {
  it("classifies the errors electron-updater 6.8 reports", () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      // GitHubProvider wraps the transport failure in a feed code; the transport cause wins.
      [
        newError(
          "Unable to find latest version on GitHub (https://github.com/x/y/releases/latest), please ensure a production release exists: Error: net::ERR_INTERNET_DISCONNECTED",
          "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
        ),
        "network",
      ],
      [
        newError(
          `Unable to find latest version on GitHub (https://github.com/x/y/releases/latest), please ensure a production release exists: HttpError: 403 "rate limited"`,
          "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
        ),
        "http_4xx",
      ],
      // A release without its channel file is an incomplete feed, not a transport failure.
      [
        newError(
          "Cannot find latest-mac.yml in the latest release artifacts (https://github.com/x/y/releases/download/v1/latest-mac.yml): HttpError: 404 ",
          "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
        ),
        "feed",
      ],
      [new HttpError(503), "http_5xx"],
      [
        new Error(
          'Cannot download "https://objects.githubusercontent.com/x", status 502: Bad Gateway',
        ),
        "http_5xx",
      ],
      [
        newError(
          "New version 1.2.4 is not signed by the application owner: publisherNames: Scient, raw info: {}",
          "ERR_UPDATER_INVALID_SIGNATURE",
        ),
        "signature",
      ],
      [
        new Error(
          "Code signature at URL file:///private/var/update.zip did not pass validation: code object is not signed at all",
        ),
        "signature",
      ],
      [
        newError("sha512 checksum mismatch, expected a, got b", "ERR_CHECKSUM_MISMATCH"),
        "checksum",
      ],
      [nodeError("ENOSPC", "ENOSPC: no space left on device, write"), "disk_full"],
      [nodeError("EACCES", "spawn EACCES"), "permission"],
      [new Error("net::ERR_CERT_AUTHORITY_INVALID"), "certificate"],
      [nodeError("ETIMEDOUT", "connect ETIMEDOUT 140.82.112.3:443"), "timeout"],
      [new CancellationError(), "cancelled"],
      [new Error("something else entirely"), "unknown"],
    ];
    for (const [error, expected] of cases) {
      expect([String(error), classifyUpdateFailure(error)]).toEqual([String(error), expected]);
    }
  });
});
