// @effect-diagnostics nodeBuiltinImport:off -- The expected pipe name is computed the way wacli does, with SHA-256.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { delegateAddress, wacliStorePath } from "./wacliDelegate.ts";

describe("wacliStorePath", () => {
  const deepStore = `/Users/someone/${"a-long-folder-name".repeat(5)}/whatsapp/store`;
  const pathFor = (tempRoots: ReadonlyArray<string | undefined>) =>
    wacliStorePath({
      platform: "darwin",
      storeDir: deepStore,
      tempRoots,
      userId: 501,
      linkName: "1a2b3c4",
      join: NodePath.posix.join,
    });

  it("uses a store whose socket path fits as is", () => {
    const storeDir = "/Users/someone/.scient/whatsapp/store";
    expect(
      wacliStorePath({
        platform: "darwin",
        storeDir,
        tempRoots: ["/tmp"],
        userId: 501,
        linkName: "1a2b3c4",
        join: NodePath.posix.join,
      }),
    ).toEqual({ storeDir });
  });

  it("skips a temp folder too deep for the whole socket path", () => {
    // A 66-byte macOS temp folder leaves the socket path past the limit.
    const longTemp = `/var/folders/${"x".repeat(40)}/T`.padEnd(66, "y");
    expect(pathFor([undefined, longTemp, "/tmp"])).toEqual({
      storeDir: "/tmp/scient-whatsapp-501/1a2b3c4",
      linkRoot: "/tmp/scient-whatsapp-501",
    });
  });

  it("prefers the first temp folder that fits", () => {
    expect(pathFor(["/run/user/501", "/tmp"]).linkRoot).toBe("/run/user/501/scient-whatsapp-501");
  });
});

describe("delegateAddress", () => {
  it("names the Windows pipe from the path lowercased the way Go does", () => {
    // Go lowercases `İ` to a plain `i`; JavaScript's toLowerCase adds a combining dot.
    const address = delegateAddress({
      platform: "win32",
      storeDir: "C:\\Users\\İlker\\store",
      realStoreDir: "C:\\Users\\İlker\\store",
      join: NodePath.win32.join,
    });
    const digest = NodeCrypto.createHash("sha256").update("c:\\users\\ilker\\store").digest("hex");
    expect(address).toBe(`\\\\.\\pipe\\wacli-send-${digest}`);
  });
});
