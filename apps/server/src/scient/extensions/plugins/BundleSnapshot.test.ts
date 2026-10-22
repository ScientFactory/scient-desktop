// @effect-diagnostics nodeBuiltinImport:off -- Tests mutate bundle directories on disk mid-read.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  BundleRejected,
  DEFAULT_BUNDLE_LIMITS,
  digestBundleFiles,
  snapshotBundle,
} from "./BundleSnapshot.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const directoryWith = async (files: Record<string, string>) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-bundle-snapshot-"));
  temporaryRoots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = NodePath.join(root, relativePath);
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, contents);
  }
  return root;
};

const SECRET = "outside-secret-bytes";

const rejection = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(BundleRejected);
  expect((error as Error).message).not.toContain(SECRET);
  return (error as Error).message;
};

describe("plugin bundle snapshot boundary", () => {
  it("reads every regular file once, sorted, with the release digest", async () => {
    const root = await directoryWith({ "b.txt": "b", "a/c.txt": "c", ".DS_Store": "x" });
    const snapshot = await snapshotBundle(root);
    expect(snapshot.files.map((file) => file.relativePath)).toEqual(["a/c.txt", "b.txt"]);
    expect(snapshot.digest).toBe(digestBundleFiles(snapshot.files));
  });

  it("rejects a root swapped for a link between its check and canonicalization", async () => {
    const outside = await directoryWith({ "scient.plugin.json": SECRET });
    const parent = await directoryWith({ "bundle/scient.plugin.json": "{}" });
    const root = NodePath.join(parent, "bundle");
    const message = await rejection(
      snapshotBundle(root, {
        beforeRead: async (_relativePath, kind) => {
          if (kind !== "root") return;
          await NodeFSP.rename(root, NodePath.join(parent, "original"));
          await NodeFSP.symlink(outside, root);
        },
      }),
    );
    expect(message).toContain("changed while the bundle was read");
  });

  it("rejects a root replaced by another directory during the walk", async () => {
    const parent = await directoryWith({ "bundle/a/one.txt": "1" });
    const root = NodePath.join(parent, "bundle");
    const message = await rejection(
      snapshotBundle(root, {
        beforeRead: async (relativePath, kind) => {
          if (kind !== "file" || relativePath !== "a/one.txt") return;
          await NodeFSP.rename(root, NodePath.join(parent, "original"));
          // Same layout, different directories: only identity checks can tell.
          await NodeFSP.mkdir(NodePath.join(root, "a"), { recursive: true });
          await NodeFSP.writeFile(NodePath.join(root, "a/one.txt"), SECRET);
        },
      }),
    );
    expect(message).toContain("changed while the bundle was read");
  });

  it("rejects a directory swapped for a link after its parent was listed", async () => {
    const outside = await directoryWith({ "resources/outside.txt": SECRET });
    const root = await directoryWith({ "resources/inside.txt": "inside" });
    const message = await rejection(
      snapshotBundle(root, {
        beforeRead: async (relativePath, kind) => {
          if (kind !== "directory" || relativePath !== "resources") return;
          await NodeFSP.rm(NodePath.join(root, "resources"), { recursive: true });
          await NodeFSP.symlink(
            NodePath.join(outside, "resources"),
            NodePath.join(root, "resources"),
          );
        },
      }),
    );
    expect(message).toContain("not a real directory");
  });

  it("rejects a parent directory swapped for a link while one of its files is opened", async () => {
    const outside = await directoryWith({ "resources/one.txt": SECRET });
    const root = await directoryWith({ "resources/one.txt": "inside" });
    const message = await rejection(
      snapshotBundle(root, {
        beforeRead: async (relativePath, kind) => {
          if (kind !== "file" || relativePath !== "resources/one.txt") return;
          await NodeFSP.rename(NodePath.join(root, "resources"), NodePath.join(root, "moved"));
          await NodeFSP.symlink(
            NodePath.join(outside, "resources"),
            NodePath.join(root, "resources"),
          );
        },
      }),
    );
    expect(message).toContain("changed while the bundle was read");
  });

  it("does not follow a file swapped for a link before it is opened", async () => {
    const outside = await directoryWith({ "secret.txt": SECRET });
    const root = await directoryWith({ "notes.txt": "inside" });
    const message = await rejection(
      snapshotBundle(root, {
        beforeRead: async (relativePath, kind) => {
          if (kind !== "file") return;
          await NodeFSP.rm(NodePath.join(root, relativePath));
          await NodeFSP.symlink(
            NodePath.join(outside, "secret.txt"),
            NodePath.join(root, relativePath),
          );
        },
      }),
    );
    expect(message).toContain("symbolic link");
  });

  it("rejects a file replaced by another file or a FIFO without blocking", async () => {
    const replaced = await directoryWith({ "notes.txt": "inside" });
    expect(
      await rejection(
        snapshotBundle(replaced, {
          beforeRead: async (relativePath) => {
            if (relativePath !== "notes.txt") return;
            await NodeFSP.rm(NodePath.join(replaced, relativePath));
            await NodeFSP.writeFile(NodePath.join(replaced, relativePath), SECRET);
          },
        }),
      ),
    ).toContain("changed while the bundle was read");

    const fifo = await directoryWith({ "notes.txt": "inside" });
    expect(
      await rejection(
        snapshotBundle(fifo, {
          beforeRead: async (relativePath) => {
            if (relativePath !== "notes.txt") return;
            await NodeFSP.rm(NodePath.join(fifo, relativePath));
            NodeChildProcess.execFileSync("mkfifo", [NodePath.join(fifo, relativePath)]);
          },
        }),
      ),
    ).toContain("not a regular file");
  });

  it("bounds the bytes it reads, not only the sizes it listed", async () => {
    // Each file is under the per-file limit when listed; the read loop must stop
    // the second one at the remaining total budget.
    const root = await directoryWith({ "a.txt": "123456", "b.txt": "abcdef" });
    const message = await rejection(
      snapshotBundle(root, { limits: { ...DEFAULT_BUNDLE_LIMITS, bytes: 10 } }),
    );
    expect(message).toContain("total size limit");
  });

  it("refuses a file rewritten in place after it was listed", async () => {
    // The append changes the size, so the refusal does not depend on timestamps.
    const root = await directoryWith({ "notes.txt": "small" });
    const message = await rejection(
      snapshotBundle(root, {
        beforeRead: async (relativePath) => {
          if (relativePath === "notes.txt") {
            await NodeFSP.appendFile(NodePath.join(root, relativePath), SECRET);
          }
        },
      }),
    );
    expect(message).toContain("changed while the bundle was read");
  });

  it("keeps reading when an ignored entry appears beside the bundle's files", async () => {
    // Finder writes `.DS_Store` into folders it shows; that must not refuse the bundle.
    const root = await directoryWith({ "a.txt": "a", "b.txt": "b" });
    const snapshot = await snapshotBundle(root, {
      beforeRead: async (relativePath) => {
        if (relativePath === "b.txt")
          await NodeFSP.writeFile(NodePath.join(root, ".DS_Store"), "x");
      },
    });
    expect(snapshot.files.map((file) => file.relativePath)).toEqual(["a.txt", "b.txt"]);
  });

  it("rejects hard links, including one to a file outside the bundle", async () => {
    const outside = await directoryWith({ "secret.txt": SECRET });
    const root = await directoryWith({ "notes.txt": "inside" });
    await NodeFSP.link(NodePath.join(outside, "secret.txt"), NodePath.join(root, "linked.txt"));
    expect(await rejection(snapshotBundle(root))).toContain("hard link");
  });

  it("bounds directories and entries, not only files", async () => {
    const root = await directoryWith({ "scient.plugin.json": "{}" });
    for (let index = 0; index < 60; index += 1) {
      await NodeFSP.mkdir(NodePath.join(root, `empty-${index}`));
    }
    expect(
      await rejection(snapshotBundle(root, { limits: { ...DEFAULT_BUNDLE_LIMITS, entries: 50 } })),
    ).toContain("more than 50 entries");
  });

  it("stops scanning when cancelled", async () => {
    const root = await directoryWith({ "a/one.txt": "1", "b/two.txt": "2" });
    const controller = new AbortController();
    const visited: string[] = [];
    const message = await rejection(
      snapshotBundle(root, {
        signal: controller.signal,
        beforeRead: async (relativePath) => {
          visited.push(relativePath);
          if (relativePath === "a") controller.abort();
        },
      }),
    );
    expect(message).toContain("cancelled");
    expect(visited).not.toContain("b");
  });
});
