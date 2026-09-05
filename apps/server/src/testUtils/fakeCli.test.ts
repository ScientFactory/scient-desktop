// @effect-diagnostics nodeBuiltinImport:off - native launcher fixture qualification.
import * as ChildProcess from "node:child_process";
import * as FileSystem from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { expect, it } from "vite-plus/test";
import { writeFakeCli } from "./fakeCli.ts";

it.skipIf(process.platform === "win32")("runs a quoted fixture path without ambient PATH", () => {
  const directory = FileSystem.mkdtempSync(Path.join(OS.tmpdir(), "fake cli's fixture-"));
  try {
    const launcher = writeFakeCli({
      directory,
      name: "agent",
      source: "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
    });
    const result = ChildProcess.spawnSync(launcher, ["argument with spaces", "a'b"], {
      env: { PATH: "" },
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(JSON.stringify(["argument with spaces", "a'b"]));
  } finally {
    FileSystem.rmSync(directory, { recursive: true, force: true });
  }
});
