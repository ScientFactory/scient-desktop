// @effect-diagnostics nodeBuiltinImport:off -- Release qualification supervises the native test runner.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

export async function runLiveTests(input: {
  readonly label: string;
  readonly tests: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string>>;
  readonly platform: NodeJS.Platform;
}): Promise<void> {
  const repositoryRoot = NodePath.resolve(import.meta.dirname, "../..");
  const serverDirectory = NodePath.join(repositoryRoot, "apps/server");
  await new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      "vp",
      [
        "test",
        "run",
        "--no-file-parallelism",
        ...input.tests.map((file) =>
          NodePath.relative(serverDirectory, NodePath.resolve(repositoryRoot, file)),
        ),
      ],
      {
        cwd: serverDirectory,
        env: { ...process.env, ...input.environment },
        // Windows needs a shell to resolve the fixed vp.cmd shim and static arguments.
        shell: input.platform === "win32",
        stdio: "inherit",
        windowsHide: true,
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${input.label} failed${signal ? ` with signal ${signal}` : ` with exit code ${String(code)}`}.`,
          ),
        );
    });
  });
}
