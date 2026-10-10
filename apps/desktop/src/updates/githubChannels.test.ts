// @effect-diagnostics nodeBuiltinImport:off - The locked updater qualifier runs with synthetic state in a child process.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

describe("locked electron-updater integration", () => {
  it("discovers each platform's channel and downloads a checksum-verified Beta without an installer", () => {
    const output = NodeChildProcess.execFileSync(
      process.execPath,
      [NodePath.resolve(import.meta.dirname, "../../scripts/qualify-update-channels.cjs")],
      { encoding: "utf8", timeout: 30_000 },
    );
    const result = JSON.parse(output) as {
      nativeInstall: boolean;
      cases: Array<{ downloadVerified?: boolean; corruptDownloadRejected?: boolean }>;
    };
    expect(result.nativeInstall).toBe(false);
    expect(result.cases).toHaveLength(17);
    expect(result.cases.at(-1)?.downloadVerified).toBe(true);
    expect(result.cases.at(-1)?.corruptDownloadRejected).toBe(true);
  });
});
