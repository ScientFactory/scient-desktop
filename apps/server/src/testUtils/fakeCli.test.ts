// @effect-diagnostics nodeBuiltinImport:off - native launcher fixture qualification.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { expect, it } from "vite-plus/test";
import { writeFakeCli } from "./fakeCli.ts";

it.skipIf(HostProcessPlatform.defaultValue() === "win32")(
  "runs a quoted fixture path without ambient PATH",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fake cli's fixture-"));
    try {
      const launcher = writeFakeCli({
        directory,
        name: "agent",
        source: "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
      });
      const result = NodeChildProcess.spawnSync(launcher, ["argument with spaces", "a'b"], {
        env: { PATH: "" },
        encoding: "utf8",
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(JSON.stringify(["argument with spaces", "a'b"]));
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  },
);
