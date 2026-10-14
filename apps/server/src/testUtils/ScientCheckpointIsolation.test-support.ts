// @effect-diagnostics nodeBuiltinImport:off - synchronous safety checks at the test-only Git boundary.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

function canonicalDirectory(directory: string): string {
  const absolute = NodePath.resolve(directory);
  try {
    return NodeFS.realpathSync.native(absolute);
  } catch (error) {
    // Mock Git drivers can report directories that exist only in their fake filesystem.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return absolute;
    throw error;
  }
}

/** Keep safety failures observable even when the runtime recovers a checkpoint failure. */
export function makeCheckpointIsolationGuard(checkoutCommonDirectory: string) {
  const forbiddenDirectory = canonicalDirectory(checkoutCommonDirectory);
  const violations: string[] = [];

  return {
    check(input: { readonly cwd: string; readonly gitCommonDir: string }): void {
      const directory = canonicalDirectory(NodePath.resolve(input.cwd, input.gitCommonDir));
      if (directory !== forbiddenDirectory) return;
      const message =
        `Checkpoint capture must not use the test checkout's Git directory (${directory}). ` +
        `Bind ${input.cwd} to an independent checkpointWorkspace fixture.`;
      violations.push(message);
      throw new Error(message);
    },
    assertNoViolations(): void {
      const failures = violations.splice(0);
      if (failures.length > 0) throw new Error(failures.join("\n"));
    },
  };
}
