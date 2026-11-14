// @effect-diagnostics nodeBuiltinImport:off
/** Linux only, so it stays out of the platform jobs' files, which may not skip a case. */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import { filePublicationTestHelper } from "./fileExchange.testkit.ts";
import { platformFileIdentity } from "./PlatformFileIdentity.ts";

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("Linux physical identity", () => {
  it("gives a folder recreated at the same path a different identity", async () => {
    const helper = await filePublicationTestHelper();
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-identity-"));
    try {
      const folder = NodePath.join(root, "paper");
      await NodeFSP.mkdir(folder);
      const before = await platformFileIdentity.directory(folder, undefined, helper);
      expect(before).toMatchObject({ platform: "linux", generation: expect.any(String) });
      expect(await platformFileIdentity.directory(folder, undefined, helper)).toEqual(before);
      // ext4 and XFS usually hand the freed inode straight back; whether they do or not,
      // the new folder must not pass for the old one.
      for (let attempt = 0; attempt < 20; attempt++) {
        await NodeFSP.rmdir(folder);
        await NodeFSP.mkdir(folder);
        const after = await platformFileIdentity.directory(folder, undefined, helper);
        expect(after).not.toBeNull();
        expect(platformFileIdentity.equal(before!, after!)).toBe(false);
      }
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
