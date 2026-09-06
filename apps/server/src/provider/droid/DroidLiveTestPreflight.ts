// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import catalog from "../../scient/providerLifecycle/bundled-managed-runtime-catalog.json" with { type: "json" };

/** These fixtures qualify the bundled release, whose wire behavior is version-specific. */
export async function qualifyDroidTestBinary(binary: string | undefined): Promise<void> {
  if (!binary) return;
  const expected = catalog.providers.droid.version;
  const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(binary, ["--version"], {
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    env: { ...process.env, FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" },
  });
  const actual = stdout.trim();
  const diagnostic = `Droid live qualification: ${binary}; expected ${expected}; reported ${actual}`;
  if (actual !== expected && actual !== `v${expected}`) {
    throw new Error(`${diagnostic}. Select the bundled runtime with SCIENT_DROID_TEST_BINARY.`);
  }
  process.stdout.write(`${diagnostic}\n`);
}
