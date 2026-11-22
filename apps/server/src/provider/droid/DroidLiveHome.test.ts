// @effect-diagnostics nodeBuiltinImport:off -- starts a detached writer, as Droid's exit courier is.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "vite-plus/test";

import { processesUsingHome, waitUntilHomeIdle } from "./DroidLiveHome.testkit.ts";

const platform = HostProcess.Platform.defaultValue();
/** The writers stand in for Droid's processes; the real ones are found by Droid's name. */
const node = NodePath.basename(process.execPath);

describe.skipIf(platform === "win32")("a Droid live test's HOME", () => {
  it("is idle only once a detached writer and what it left running have exited", async () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-droid-home-"));
    try {
      const marker = NodePath.join(home, "exit-spool", "done");
      // Like the courier: a non-system executable (macOS hides system binaries' environments) in a
      // process group of its own, gone from its parent's tree. It exits first and leaves a child
      // that writes under HOME later, so one round of waiting is not enough.
      const late = `setTimeout(() => { fs.mkdirSync(${JSON.stringify(NodePath.dirname(marker))}); fs.writeFileSync(${JSON.stringify(marker)}, "done\\n"); }, 1000)`;
      const writer = NodeChildProcess.spawn(
        process.execPath,
        [
          "-e",
          `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(`const fs = require("node:fs"); ${late}`)}], { detached: true, stdio: "ignore" }).unref()`,
        ],
        // Only HOME and PATH: the test runner's NODE_OPTIONS would load its hooks into the writers.
        { detached: true, stdio: "ignore", env: { HOME: home, PATH: process.env.PATH ?? "" } },
      );
      writer.unref();
      // As at a live test's end: the helper is already running when the wait starts.
      await new Promise((resolve) => writer.once("spawn", resolve));
      await waitUntilHomeIdle(home, platform, AbortSignal.timeout(15_000), node);
      expect(NodeFS.readFileSync(marker, "utf8")).toBe("done\n");
      expect((await processesUsingHome(home, platform, node)).users).toEqual([]);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("is idle at once when nothing uses it", async () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-droid-home-"));
    try {
      await waitUntilHomeIdle(home, platform, AbortSignal.timeout(15_000), node);
      expect((await processesUsingHome(home, platform, node)).users).toEqual([]);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
});
