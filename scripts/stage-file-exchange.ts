// @effect-diagnostics nodeBuiltinImport:off -- Standalone host compiler invocation, no server runtime.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

if (
  HostProcess.Platform.defaultValue() !== "darwin" &&
  HostProcess.Platform.defaultValue() !== "linux"
) {
  throw new Error("File exchange is available on macOS and Linux only.");
}
const root = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const destination = NodePath.join(
  root,
  "native/file-exchange",
  `${HostProcess.Platform.defaultValue()}-${HostProcess.Architecture.defaultValue()}`,
);
await NodeFSP.mkdir(destination, { recursive: true });
NodeChildProcess.execFileSync(
  "cc",
  [
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-fstack-protector-strong",
    NodePath.join(root, "native/file-exchange/exchange.c"),
    "-o",
    NodePath.join(destination, "scient-file-exchange"),
  ],
  { stdio: "inherit" },
);
