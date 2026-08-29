/**
 * Optional host qualification for Cursor's no-browser login transport.
 *
 * The probe uses an isolated account home, waits only for Cursor to emit its
 * official HTTPS authorization URL, and then cancels. It never opens a browser
 * or submits credentials.
 *
 * Enable with:
 * T3_CURSOR_LOGIN_PROBE=I_ACCEPT_NO_BROWSER_LOGIN_PROBE
 * T3_CURSOR_LOGIN_PROBE_BINARY=/path/to/cursor-agent
 */
// @effect-diagnostics nodeBuiltinImport:off -- Gated host qualification owns a temporary account home.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { CursorSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { describe, expect } from "vite-plus/test";

import { makeCursorConnectionActions } from "./CursorConnectionActions.ts";

const binaryPath = process.env.T3_CURSOR_LOGIN_PROBE_BINARY?.trim();
const enabled =
  process.env.T3_CURSOR_LOGIN_PROBE === "I_ACCEPT_NO_BROWSER_LOGIN_PROBE" &&
  binaryPath !== undefined &&
  binaryPath.length > 0;
const decodeCursorSettings = Schema.decodeSync(CursorSettings);

describe.runIf(enabled)("Cursor no-browser login transport", () => {
  it.effect("emits an official authorization URL without opening a browser", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-cursor-login-")),
        ),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        XDG_CONFIG_HOME: NodePath.join(root, ".config"),
        XDG_CACHE_HOME: NodePath.join(root, ".cache"),
        XDG_DATA_HOME: NodePath.join(root, ".local", "share"),
        APPDATA: NodePath.join(root, "AppData", "Roaming"),
        LOCALAPPDATA: NodePath.join(root, "AppData", "Local"),
      };
      const actions = yield* makeCursorConnectionActions(
        decodeCursorSettings({ binaryPath }),
        environment,
        spawner,
      );

      const attempt = yield* actions.start("cursor_browser");
      yield* Effect.addFinalizer(() => attempt.cancel.pipe(Effect.ignore));
      expect(attempt.authorizationUrl).toMatch(
        /^https:\/\/(?:[^./]+\.)*cursor\.com\/(?:[^\s]*\/)?(?:login|auth)/iu,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
