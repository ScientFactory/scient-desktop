// @effect-diagnostics-next-line nodeBuiltinImport:off - Windows needs a junction to plant a link without elevation.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { prepareAntigravityProfile } from "../../provider/antigravityAuthSupport.ts";

// The same link type the profile preparation creates: a junction on Windows, a symlink elsewhere.
const plantLink = (target: string, link: string) =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    yield* Effect.promise(() =>
      NodeFSP.symlink(target, link, platform === "win32" ? "junction" : "dir"),
    );
  });

const isLink = (link: string) =>
  Effect.promise(() =>
    NodeFSP.lstat(link).then(
      (info) => info.isSymbolicLink(),
      () => false,
    ),
  );

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  const userHome = path.join(directory, "home");
  const profileDirectory = path.join(directory, "profile");
  yield* fs.makeDirectory(userHome, { recursive: true });
  return {
    fs,
    path,
    directory,
    userHome,
    profileDirectory,
    configTarget: path.join(userHome, ".gemini", "config", "skills"),
    cliTarget: path.join(userHome, ".gemini", "antigravity-cli", "skills"),
    configLink: path.join(profileDirectory, "config", "skills"),
    cliLink: path.join(profileDirectory, "antigravity-cli", "skills"),
    prepare: prepareAntigravityProfile({ profileDirectory, userHome }),
  };
});

it.layer(NodeServices.layer)("Antigravity user skill links", (it) => {
  it.effect("creates no link when the user has no Gemini skill directories", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* t.prepare;
      expect(yield* t.fs.exists(t.configLink)).toBe(false);
      expect(yield* t.fs.exists(t.cliLink)).toBe(false);
      expect(yield* isLink(t.configLink)).toBe(false);
      expect(yield* isLink(t.cliLink)).toBe(false);
    }),
  );

  it.effect(
    "removes a dangling link left by an earlier launch so the agent can create its own",
    () =>
      Effect.gen(function* () {
        const t = yield* setup;
        yield* t.fs.makeDirectory(t.path.dirname(t.configLink), { recursive: true });
        yield* t.fs.makeDirectory(t.path.dirname(t.cliLink), { recursive: true });
        yield* plantLink(t.configTarget, t.configLink);
        yield* plantLink(t.cliTarget, t.cliLink);
        expect(yield* isLink(t.configLink)).toBe(true);

        yield* t.prepare;
        expect(yield* isLink(t.configLink)).toBe(false);
        expect(yield* isLink(t.cliLink)).toBe(false);
        // What `session/new` does next: it must be able to create the directory.
        yield* t.fs.makeDirectory(t.configLink, { recursive: true });
        expect((yield* t.fs.stat(t.configLink)).type).toBe("Directory");
      }),
  );

  it.effect("links a directory once it exists, on the next launch", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* t.prepare;
      // Meanwhile the agent created its own, empty, directory.
      yield* t.fs.makeDirectory(t.configLink, { recursive: true });
      yield* t.fs.makeDirectory(t.path.join(t.configTarget, "review"), { recursive: true });

      yield* t.prepare;
      expect(yield* isLink(t.configLink)).toBe(true);
      expect(yield* t.fs.exists(t.path.join(t.configLink, "review"))).toBe(true);
      expect(yield* isLink(t.cliLink)).toBe(false);
    }),
  );

  it.effect("never touches a real directory, with or without a target", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* t.fs.makeDirectory(t.path.join(t.configLink, "own-skill"), { recursive: true });
      yield* t.prepare;
      expect(yield* t.fs.exists(t.path.join(t.configLink, "own-skill"))).toBe(true);

      yield* t.fs.makeDirectory(t.configTarget, { recursive: true });
      yield* t.prepare;
      expect(yield* isLink(t.configLink)).toBe(false);
      expect(yield* t.fs.exists(t.path.join(t.configLink, "own-skill"))).toBe(true);
    }),
  );

  it.effect("keeps a link that still resolves when the expected target is missing", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      const elsewhere = t.path.join(t.directory, "elsewhere");
      yield* t.fs.makeDirectory(elsewhere, { recursive: true });
      yield* t.fs.makeDirectory(t.path.dirname(t.configLink), { recursive: true });
      yield* plantLink(elsewhere, t.configLink);

      yield* t.prepare;
      expect(yield* isLink(t.configLink)).toBe(true);
      expect(yield* t.fs.exists(elsewhere)).toBe(true);
    }),
  );
});
