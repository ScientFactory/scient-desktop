// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  StoredFileIdentity,
  platformFileIdentity,
  type PersistentFileIdentity,
} from "./PlatformFileIdentity.ts";

const decode = Schema.decodeUnknownSync(StoredFileIdentity);
it("reads legacy macOS records unchanged and refuses unknown platform or version tags", () => {
  const old = { volume: "0A1B2C3D-0000-4000-8000-000000000001", fileId: "18446744073709551615" };
  expect(decode(old)).toEqual(old);
  expect(decode({ ...old, version: 1, platform: "darwin" })).toEqual({
    ...old,
    version: 1,
    platform: "darwin",
  });
  expect(() => decode({ ...old, version: 2, platform: "darwin" })).toThrow();
  expect(() => decode({ ...old, version: 1, platform: "unknown" })).toThrow();
});

it("compares old macOS records with tagged identities without conflating platforms or subvolumes", () => {
  const legacy = { volume: "volume", fileId: "18446744073709551615" };
  const darwin = { ...legacy, version: 1, platform: "darwin" } as const;
  expect(platformFileIdentity.equal(legacy, darwin)).toBe(true);
  expect(platformFileIdentity.equal(legacy, { ...darwin, fileId: "18446744073709551614" })).toBe(
    false,
  );
  expect(platformFileIdentity.equal(legacy, { ...darwin, platform: "windows" })).toBe(false);
  const linux: PersistentFileIdentity = { ...darwin, platform: "linux", subvolumeId: "1" };
  expect(platformFileIdentity.equal(linux, { ...linux, subvolumeId: "2" })).toBe(false);
});

describe.skipIf(HostProcess.Platform.defaultValue() !== "darwin")("macOS physical identity", () => {
  it("retains decimal file IDs and keys aliases by the same object", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-identity-"));
    try {
      const folder = NodePath.join(root, "folder"),
        alias = NodePath.join(root, "alias");
      await NodeFSP.mkdir(folder);
      await NodeFSP.symlink(folder, alias);
      const volume = async () => "0A1B2C3D-0000-4000-8000-000000000001";
      const stat = await NodeFSP.stat(folder, { bigint: true });
      const persistent = await platformFileIdentity.persistent(folder, volume);
      expect(persistent).toEqual({
        version: 1,
        platform: "darwin",
        volume: await volume(),
        fileId: String(stat.ino),
      });
      expect(await platformFileIdentity.directory(folder, volume)).toEqual(persistent);
      const file = NodePath.join(folder, "file");
      await NodeFSP.writeFile(file, "bytes");
      expect(await platformFileIdentity.persistent(file, volume)).toMatchObject({
        platform: "darwin",
        version: 1,
      });
      expect(await platformFileIdentity.directory(file, volume)).toBeNull();
      expect(await platformFileIdentity.persistent(alias, volume)).toBeNull();
      expect(await platformFileIdentity.key(alias)).toBe(await platformFileIdentity.key(folder));
      await NodeFSP.rename(folder, `${folder}-old`);
      await NodeFSP.mkdir(folder);
      expect(await platformFileIdentity.key(alias)).not.toBe(
        await platformFileIdentity.key(`${folder}-old`),
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
