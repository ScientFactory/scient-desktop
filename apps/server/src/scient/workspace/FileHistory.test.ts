// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { keepFileVersion, listFileVersions } from "./FileHistory.ts";

const revisionOf = (text: string) =>
  `sha256:${NodeCrypto.createHash("sha256").update(text).digest("hex")}`;
const fixture = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-history-"));
  const directory = NodePath.join(root, "history");
  const target = NodePath.join(root, "main.tex");
  const keep = async (
    text: string,
    now: number,
    options: { readonly ownSave?: boolean; readonly totalBytes?: number; file?: string } = {},
  ) => {
    await NodeFSP.writeFile(options.file ?? target, text);
    return keepFileVersion({
      directory,
      target: options.file ?? target,
      revision: revisionOf(text),
      ownSave: options.ownSave ?? false,
      now,
      ...(options.totalBytes === undefined ? {} : { totalBytes: options.totalBytes }),
    });
  };
  return {
    directory,
    target,
    keep,
    times: async (file = target) =>
      (await listFileVersions(directory, file)).map((version) => version.retainedAt),
  };
};

describe("file history", () => {
  it("keeps the newest thirty versions of a file", async () => {
    const { keep, times } = await fixture();
    for (let n = 0; n < 35; n++) await keep(`version ${n}`, n);
    const kept = await times();
    expect(kept).toHaveLength(30);
    expect([kept[0], kept.at(-1)]).toEqual([34, 5]);
  });

  it("drops the oldest versions across files once the total is too large", async () => {
    const { target, keep, times } = await fixture();
    const other = `${target}.other`;
    const limit = { totalBytes: 12 };
    await keep("11111", 1, limit);
    await keep("22222", 2, { ...limit, file: other });
    await keep("33333", 3, limit);
    expect(await times()).toEqual([3]);
    expect(await times(other)).toEqual([2]);
  });

  it("spaces out Scient's own saves", async () => {
    const { keep, times } = await fixture();
    await keep("one", 0, { ownSave: true });
    await keep("two", 60_000, { ownSave: true });
    await keep("three", 6 * 60_000, { ownSave: true });
    expect(await times()).toEqual([6 * 60_000, 0]);
  });

  it("names a copy for the bytes it holds, not those it expected", async () => {
    const { directory, target } = await fixture();
    await NodeFSP.writeFile(target, "written since the check");
    const kept = await keepFileVersion({
      directory,
      target,
      revision: revisionOf("as checked"),
      ownSave: false,
      now: 1,
    });
    expect(kept).toBe(false);
    const [version] = await listFileVersions(directory, target);
    expect(version?.revision).toBe(revisionOf("written since the check"));
  });

  it("leaves other history alone rather than keep a file too large to fit", async () => {
    const { keep, times } = await fixture();
    expect(await keep("small", 1, { totalBytes: 12 })).toBe(true);
    expect(await keep("much too large to fit", 2, { totalBytes: 12 })).toBe(false);
    expect(await times()).toEqual([1]);
  });

  it("still limits the total with stray files in its folder", async () => {
    const { directory, keep, times } = await fixture();
    await keep("11111", 1);
    await NodeFSP.writeFile(NodePath.join(directory, ".DS_Store"), "stray");
    await NodeFSP.writeFile(NodePath.join(directory, "a".repeat(64)), "stray");
    await keep("22222", 2, { totalBytes: 6 });
    expect(await times()).toEqual([2]);
  });
});
