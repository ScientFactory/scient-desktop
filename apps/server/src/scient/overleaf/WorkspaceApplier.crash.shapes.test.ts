// @effect-diagnostics nodeBuiltinImport:off
// Linux and macOS: every step shape killed at each publication point. Split from
// WorkspaceApplier.crash.test.ts so the macOS Overleaf job can run the two side by side.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { privateFoldersAndIdentityHost } from "../workspace/fileExchange.testkit.ts";
import { crashAt, editorReads, read, revisions } from "./WorkspaceApplier.crash.testkit.ts";
import { fixture } from "./WorkspaceApplier.testkit.ts";

const hasPrivateFoldersAndIdentity = await privateFoldersAndIdentityHost();

describe.skipIf(!hasPrivateFoldersAndIdentity)(
  "WorkspaceApplier step shapes after real process death",
  () => {
    // Crash probes must distinguish unpublished steps from confirmed publication. A create killed
    // after its macOS clone call lacks durable ownership proof and stays for review. Windows' moved
    // stage and Linux's staged create journal their public file ID, so ID plus bytes prove completion.
    const shapes = [
      {
        name: "an edit",
        occurrence: 1,
        captured: { "a.tex": "base", "guard.tex": "guard" },
        target: { "a.tex": "remote", "guard.tex": "guard" },
      },
      {
        name: "a rename's destination",
        occurrence: 1,
        captured: { "old.tex": "base", "guard.tex": "guard" },
        target: { "new.tex": "remote", "guard.tex": "guard" },
        renames: [{ from: "old.tex", to: "new.tex" }],
      },
      {
        name: "a rename's removal",
        occurrence: 2,
        captured: { "old.tex": "base", "guard.tex": "guard" },
        target: { "new.tex": "remote", "guard.tex": "guard" },
        renames: [{ from: "old.tex", to: "new.tex" }],
      },
      {
        name: "a file giving way to a folder",
        occurrence: 1,
        captured: { notes: "base", "guard.tex": "guard" },
        target: { "notes/a.tex": "remote", "notes/b.tex": "B", "guard.tex": "guard" },
      },
      {
        name: "a file in a folder replacing a file",
        occurrence: 2,
        captured: { notes: "base", "guard.tex": "guard" },
        target: { "notes/a.tex": "remote", "notes/b.tex": "B", "guard.tex": "guard" },
      },
      {
        name: "a folder giving way to a file",
        occurrence: 1,
        captured: { "notes/a.tex": "base", "notes/b.tex": "B", "guard.tex": "guard" },
        target: { notes: "remote", "guard.tex": "guard" },
      },
      {
        // Its third step removes the emptied folder, then writes the file in its place.
        name: "a folder removed for a file",
        occurrence: 3,
        captured: { "notes/a.tex": "base", "notes/b.tex": "B", "guard.tex": "guard" },
        target: { notes: "remote", "guard.tex": "guard" },
      },
      {
        name: "a deletion",
        occurrence: 1,
        captured: { "a.tex": "base", "guard.tex": "guard" },
        target: { "guard.tex": "guard" },
      },
    ];
    it.live.each(
      (["prepared", "checked", "called"] as const).flatMap((point) =>
        shapes.flatMap((shape) => [false, true].map((changed) => ({ ...shape, point, changed }))),
      ),
    )("recovers $name killed at $point, guard changed: $changed", (shape) =>
      fixture(async (h) => {
        await crashAt(h, shape.point, shape, shape.occurrence);
        if (shape.changed) await NodeFSP.writeFile(NodePath.join(h.cwd, "guard.tex"), "later");
        await h.restart();
        await editorReads(h);
        const result = await h.apply("crash");
        if (!shape.changed) {
          expect(result).toMatchObject({ outcome: "complete", matchesTarget: true });
          for (const [name, text] of Object.entries(shape.target))
            expect(await read(h.cwd, name)).toBe(text);
          return;
        }
        expect(await read(h.cwd, "guard.tex")).toBe("later");
        expect(Object.fromEntries(result.base)).toEqual(revisions(shape.captured));
        if (shape.occurrence === 1 && shape.point !== "called") {
          expect(result.interrupted).toEqual([]);
          for (const [name, text] of Object.entries(shape.captured))
            if (name !== "guard.tex") expect(await read(h.cwd, name)).toBe(text);
        } else expect(result.interrupted).toHaveLength(1);
      }),
    );
  },
);
