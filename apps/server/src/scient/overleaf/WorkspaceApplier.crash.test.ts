// @effect-diagnostics nodeBuiltinImport:off
// Linux and macOS; WorkspaceApplier.crash.platform.test.ts holds the cases Windows runs too.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { privateFoldersAndIdentityHost } from "../workspace/fileExchange.testkit.ts";
import {
  crashAt,
  edit,
  editorReads,
  emptied,
  planOf,
  put,
  read,
  type Scenario,
} from "./WorkspaceApplier.crash.testkit.ts";
import { fixture } from "./WorkspaceApplier.testkit.ts";

const hasPrivateFoldersAndIdentity = await privateFoldersAndIdentityHost();

describe.skipIf(!hasPrivateFoldersAndIdentity)("WorkspaceApplier after real process death", () => {
  it.live("recovers an unpublished destination stage after real process death", () =>
    fixture(async (h) => {
      const added: Scenario = {
        captured: { "guard.tex": "guard" },
        target: { "a.tex": "new", "guard.tex": "guard" },
      };
      await crashAt(h, "create-staged", added);
      expect(await read(h.cwd, "a.tex")).toBeNull();
      await h.restart();
      expect(await h.apply("crash")).toMatchObject({ outcome: "complete", matchesTarget: true });
      expect(await read(h.cwd, "a.tex")).toBe("new");
      expect(
        (await NodeFSP.readdir(h.cwd)).filter((name) => name.startsWith(".scient-overleaf-apply-")),
      ).toEqual([]);
    }),
  );

  it.live("publishes nothing into a changed group when an editor reads first", () =>
    fixture(async (h) => {
      await crashAt(h, "prepared");
      await NodeFSP.writeFile(NodePath.join(h.cwd, "guard.tex"), "later");
      await h.restart();
      await editorReads(h);
      expect(await read(h.cwd, "a.tex")).toBe("base");
      expect((await h.apply("crash")).interrupted).toEqual([]);
      expect(await read(h.cwd, "a.tex")).toBe("base");
    }),
  );

  // A peer is checked by what stands there, not only by its bytes.
  it.live.each(["empty folder", "folder with a file", "link", "named pipe"] as const)(
    "publishes nothing when a peer that should be absent becomes a %s",
    (occupant) =>
      fixture(async (h) => {
        await crashAt(h, "prepared", {
          captured: { "guard.tex": "guard" },
          target: { "a.tex": "remote", "b.tex": "B", "guard.tex": "guard" },
        });
        const peer = NodePath.join(h.cwd, "b.tex");
        if (occupant === "link") {
          await NodeFSP.writeFile(NodePath.join(h.root, "outside"), "B");
          await NodeFSP.symlink(NodePath.join(h.root, "outside"), peer);
        } else if (occupant === "named pipe") NodeChildProcess.execFileSync("mkfifo", [peer]);
        else {
          await NodeFSP.mkdir(peer);
          if (occupant === "folder with a file") await put(peer, { "later.tex": "later" });
        }
        await h.restart();
        await editorReads(h);
        expect(await read(h.cwd, "a.tex")).toBeNull();
        await h.apply("crash").catch(() => undefined);
        expect(await read(h.cwd, "a.tex")).toBeNull();
      }),
  );

  it.live.each(["empty folder", "folder with a file", "link", "named pipe"] as const)(
    "publishes nothing when a peer that should be a file becomes a %s",
    (occupant) =>
      fixture(async (h) => {
        await crashAt(h, "prepared", {
          captured: { "a.tex": "base", "z.tex": "guard" },
          target: { "a.tex": "remote", "z.tex": "guard" },
        });
        const peer = NodePath.join(h.cwd, "z.tex");
        await NodeFSP.unlink(peer);
        if (occupant === "link") {
          await NodeFSP.writeFile(NodePath.join(h.root, "outside"), "guard");
          await NodeFSP.symlink(NodePath.join(h.root, "outside"), peer);
        } else if (occupant === "named pipe") NodeChildProcess.execFileSync("mkfifo", [peer]);
        else {
          await NodeFSP.mkdir(peer);
          if (occupant === "folder with a file") await put(peer, { foreign: "foreign" });
        }
        await h.restart();
        await editorReads(h);
        expect(await read(h.cwd, "a.tex")).toBe("base");
      }),
  );

  it.live("publishes nothing when a file blocks the folder of a path the group adds", () =>
    fixture(async (h) => {
      await crashAt(h, "prepared", {
        captured: { "a.tex": "base" },
        target: { "a.tex": "remote", "z/new.tex": "new" },
      });
      await put(h.cwd, { z: "foreign" });
      await h.restart();
      await editorReads(h);
      expect(await read(h.cwd, "a.tex")).toBe("base");
    }),
  );

  it.live("publishes nothing when a folder the group creates appears early with other files", () =>
    fixture(async (h) => {
      await crashAt(h, "prepared", {
        base: { "a.tex": "base", z: "old" },
        captured: { "a.tex": "base" },
        target: { "a.tex": "remote", "z/deep/new.tex": "new" },
      });
      await put(h.cwd, { "z/foreign.tex": "foreign" });
      await h.restart();
      await editorReads(h);
      expect(await read(h.cwd, "a.tex")).toBe("base");
    }),
  );

  it.live.each(["notes/old.tex", "notes/deep/old.tex"])(
    "removes nothing from a folder the group empties when another file appears in it (%s)",
    (old) =>
      fixture(async (h) => {
        await crashAt(h, "prepared", {
          captured: { [old]: "old", "a.tex": "base" },
          target: { notes: "remote", "a.tex": "remote" },
        });
        await put(h.cwd, { "notes/foreign.tex": "foreign" });
        await h.restart();
        await editorReads(h);
        expect(await read(h.cwd, old)).toBe("old");
        expect(await read(h.cwd, "notes/foreign.tex")).toBe("foreign");
      }),
  );

  // The bytes are what was reviewed; a hard link elsewhere does not change them.
  it.live("accepts a peer replaced by a hard link with the same bytes", () =>
    fixture(async (h) => {
      await crashAt(h, "prepared", {
        captured: { "a.tex": "base", "z.tex": "guard" },
        target: { "a.tex": "remote", "z.tex": "guard" },
      });
      await NodeFSP.writeFile(NodePath.join(h.root, "outside"), "guard");
      await NodeFSP.unlink(NodePath.join(h.cwd, "z.tex"));
      await NodeFSP.link(NodePath.join(h.root, "outside"), NodePath.join(h.cwd, "z.tex"));
      await h.restart();
      expect(await h.apply("crash")).toMatchObject({ outcome: "complete", matchesTarget: true });
      expect(await read(h.root, "outside")).toBe("guard");
    }),
  );

  it.live("publishes nothing when a peer's folder is replaced by a link to the same bytes", () =>
    fixture(async (h) => {
      await crashAt(h, "prepared", {
        captured: { "a.tex": "base", "sub/guard.tex": "guard" },
        target: { "a.tex": "remote", "sub/guard.tex": "guard" },
      });
      await NodeFSP.rename(NodePath.join(h.cwd, "sub"), NodePath.join(h.cwd, "sub-original"));
      await put(NodePath.join(h.root, "outside"), { "guard.tex": "guard" });
      await NodeFSP.symlink(NodePath.join(h.root, "outside"), NodePath.join(h.cwd, "sub"));
      await h.restart();
      await editorReads(h);
      expect(await read(h.cwd, "a.tex")).toBe("base");
    }),
  );

  // Inside a plain save: its temporary file just opened, or written but not yet renamed in.
  it.live.each([
    { moment: "its temporary file was opened", operation: "open", suffix: ".scient-tmp" },
    { moment: "its temporary file was renamed in", operation: "rename", suffix: "/a.tex" },
  ] as const)("finishes the unit after a crash before $moment, leaving no temporary file", (kill) =>
    fixture(async (h) => {
      await crashAt(h, "done", edit, 99, kill);
      expect(await read(h.cwd, "a.tex")).toBe("base");
      await h.restart();
      expect(await h.apply("crash")).toMatchObject({ outcome: "complete", matchesTarget: true });
      expect(await read(h.cwd, "a.tex")).toBe("remote");
      expect(await read(h.cwd, "guard.tex")).toBe("guard");
      expect((await NodeFSP.readdir(h.cwd)).filter((name) => name.endsWith(".scient-tmp"))).toEqual(
        [],
      );
    }),
  );

  // A file with another name can't be replaced, so it is written in place, through that name too.
  it.live("finishes writing a hard-linked file in place after a crash as it was opened", () =>
    fixture(async (h) => {
      await put(h.cwd, edit.captured);
      await NodeFSP.link(NodePath.join(h.cwd, "a.tex"), NodePath.join(h.root, "other-name"));
      await crashAt(h, "done", edit, 99, { operation: "open", suffix: "/a.tex", writing: true });
      expect(await read(h.cwd, "a.tex")).toBe("base");
      await h.restart();
      expect(await h.apply("crash")).toMatchObject({ outcome: "complete", matchesTarget: true });
      expect(await read(h.root, "other-name")).toBe("remote");
    }),
  );

  it.live.each(["notes/old.tex", "notes/deep/old.tex"])(
    "applies a group whose folder becomes a file (%s)",
    (old) =>
      fixture(async (h) => {
        await put(h.cwd, emptied(old).captured);
        expect(await h.apply("emptied", planOf(emptied(old)))).toMatchObject({
          outcome: "complete",
          matchesTarget: true,
          interrupted: [],
        });
        expect(await read(h.cwd, "notes")).toBe("new");
      }),
  );
  it.live.each(["notes/old.tex", "notes/deep/old.tex"])(
    "recovers a group whose folder becomes a file after a crash (%s)",
    (old) =>
      fixture(async (h) => {
        await crashAt(h, "prepared", emptied(old));
        await h.restart();
        await editorReads(h);
        expect(await h.apply("crash")).toMatchObject({
          outcome: "complete",
          matchesTarget: true,
          interrupted: [],
        });
        expect(await read(h.cwd, "notes")).toBe("new");
      }),
  );

  // With every file of the unit changing, nothing else reads the folder before the
});
