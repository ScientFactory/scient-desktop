// @effect-diagnostics nodeBuiltinImport:off
// The process-death cases every platform with native publication runs, Windows included.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { privateFoldersAndIdentityHost } from "../workspace/fileExchange.testkit.ts";
import { crashAt, edit, read, revisions } from "./WorkspaceApplier.crash.testkit.ts";
import { fixture } from "./WorkspaceApplier.testkit.ts";

const hasPrivateFoldersAndIdentity = await privateFoldersAndIdentityHost();

describe.skipIf(!hasPrivateFoldersAndIdentity)("WorkspaceApplier after real process death", () => {
  // Settling a step killed before staging closes it without its bytes; the apply
  // tries it again from its plan. One killed after its bytes landed goes on from there.
  it.live.each(["intent", "prepared", "checked", "displaced"] as const)(
    "finishes the unit after a crash at %s when nothing else changed",
    (point) =>
      fixture(async (h) => {
        await crashAt(h, point);
        await h.restart();
        expect(await h.apply("crash")).toMatchObject({ outcome: "complete", matchesTarget: true });
        expect(await read(h.cwd, "a.tex")).toBe("remote");
      }),
  );

  // Nothing was visible yet: the group's changed file must stop the staged write.
  it.live.each(["intent", "prepared"] as const)(
    "publishes nothing into a group changed after a crash at %s",
    (point) =>
      fixture(async (h) => {
        await crashAt(h, point);
        await NodeFSP.writeFile(NodePath.join(h.cwd, "guard.tex"), "later");
        await h.restart();
        const result = await h.apply("crash");
        expect(result.interrupted).toEqual([]);
        expect([...result.base]).toEqual(Object.entries(revisions(edit.captured)));
        expect(await read(h.cwd, "a.tex")).toBe("base");
        expect(await read(h.cwd, "guard.tex")).toBe("later");
      }),
  );

  // Already visible: the group is reported, the base stays, and the later edit survives.
  it.live("reports a group changed after a crash once the new file was visible", () =>
    fixture(async (h) => {
      await crashAt(h, "displaced");
      await NodeFSP.writeFile(NodePath.join(h.cwd, "guard.tex"), "later");
      await h.restart();
      const result = await h.apply("crash");
      expect(result.interrupted).toEqual([["a.tex", "guard.tex"]]);
      expect([...result.base]).toEqual(Object.entries(revisions(edit.captured)));
      expect(await read(h.cwd, "guard.tex")).toBe("later");
    }),
  );
});
