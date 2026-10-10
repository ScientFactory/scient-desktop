// @effect-diagnostics nodeBuiltinImport:off -- Standalone host compiler invocation, no server runtime.
import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

if (
  HostProcessPlatform.defaultValue() !== "darwin" &&
  HostProcessPlatform.defaultValue() !== "linux"
) {
  throw new Error("File exchange is available on macOS and Linux only.");
}
const root = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const destination = NodePath.join(
  root,
  "native/file-exchange",
  `${HostProcessPlatform.defaultValue()}-${HostProcessArchitecture.defaultValue()}`,
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
