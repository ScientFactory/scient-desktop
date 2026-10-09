// @effect-diagnostics nodeBuiltinImport:off -- Standalone host compiler invocation, no server runtime.
import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import * as NodePath from "node:path";
import { buildFileExchange } from "./lib/scient-file-exchange-build.ts";

if (
  HostProcessPlatform.defaultValue() !== "darwin" &&
  HostProcessPlatform.defaultValue() !== "linux"
) {
  throw new Error("File exchange is available on macOS and Linux only.");
}
const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const platform = HostProcessPlatform.defaultValue();
const arch = HostProcessArchitecture.defaultValue();
if ((platform !== "darwin" && platform !== "linux") || (arch !== "arm64" && arch !== "x64")) {
  throw new Error("File exchange requires a macOS/Linux arm64/x64 build host.");
}
await buildFileExchange({
  repoRoot,
  platform,
  arch,
  outputDirectory: NodePath.join(repoRoot, "native/file-exchange", `${platform}-${arch}`),
});
