// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a build step run before deploy.
/** Builds the share page app into share/dist when its Vite entry exists; the Worker serves it. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const root = NodePath.resolve(import.meta.dirname, "..");
const config = NodePath.join(root, "share", "vite.config.ts");

if (!NodeFS.existsSync(config)) {
  console.log("No share/vite.config.ts; deploying without the share page app.");
} else {
  NodeChildProcess.execFileSync("pnpm", ["exec", "vp", "build", "--config", config], {
    cwd: NodePath.resolve(root, "../../apps/web"),
    stdio: "inherit",
  });
}
