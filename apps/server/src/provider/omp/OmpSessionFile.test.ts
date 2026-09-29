// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeAssert from "node:assert/strict";

import { assertReadableOmpSessionFile, ompSessionFilesEqual } from "./OmpSessionFile.ts";

describe("Oh My Pi session file", () => {
  it.effect("rejects a symlink that escapes the session directory", () =>
    Effect.gen(function* () {
      const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-symlink-${process.pid}`);
      const session = NodePath.join(root, "session");
      const outside = NodePath.join(root, "outside.jsonl");
      NodeFS.rmSync(root, { recursive: true, force: true });
      NodeFS.mkdirSync(session, { recursive: true });
      NodeFS.writeFileSync(outside, "{}\n");
      NodeFS.symlinkSync(outside, NodePath.join(session, "session.jsonl"));
      const escaped = yield* assertReadableOmpSessionFile({
        sessionRoot: session,
        relativeSessionFile: "session.jsonl",
      }).pipe(
        Effect.flip,
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
      );
      NodeAssert.match(escaped, /outside its session directory/);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("compares reported session paths after realpath resolution", () =>
    Effect.gen(function* () {
      const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-realpath-${process.pid}`);
      const alias = `${root}-alias`;
      NodeFS.rmSync(root, { recursive: true, force: true });
      NodeFS.rmSync(alias, { recursive: true, force: true });
      NodeFS.mkdirSync(root, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(root, "session.jsonl"), "{}\n");
      NodeFS.symlinkSync(root, alias);
      const same = yield* ompSessionFilesEqual({
        sessionRoot: root,
        expectedRelativeFile: "session.jsonl",
        reportedFile: NodePath.join(alias, "session.jsonl"),
      });
      NodeAssert.equal(same, true);
      NodeFS.writeFileSync(NodePath.join(root, "other.jsonl"), "{}\n");
      const different = yield* ompSessionFilesEqual({
        sessionRoot: root,
        expectedRelativeFile: "session.jsonl",
        reportedFile: NodePath.join(root, "other.jsonl"),
      });
      NodeAssert.equal(different, false);
      yield* Effect.sync(() => {
        NodeFS.rmSync(root, { recursive: true, force: true });
        NodeFS.rmSync(alias, { recursive: true, force: true });
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
