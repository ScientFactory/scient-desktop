// @effect-diagnostics nodeBuiltinImport:off -- Build-time cross-repository contract fixture generator.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { buildAnalyticsConformanceFixture } from "./conformance.ts";

const defaultPath = NodeURL.fileURLToPath(new URL("../fixtures/contract-v4.json", import.meta.url));
const args = process.argv.slice(2);
const check = args.includes("--check");
const wireArgument = args.find((arg) => arg.startsWith("--wire="));
const paths = args.filter((arg) => arg !== "--check" && arg !== wireArgument);
if (wireArgument) {
  const target = NodePath.resolve(wireArgument.slice("--wire=".length));
  const source = await NodeFSP.readFile(new URL("./wireContract.ts", import.meta.url), "utf8");
  const wire = `// Generated from scient-desktop/packages/scient-analytics/src/wireContract.ts. Do not edit here.\n${source}`;
  if (check) {
    if ((await NodeFSP.readFile(target, "utf8")) !== wire)
      throw new Error(`Stale analytics wire contract: ${target}`);
  } else {
    await NodeFSP.writeFile(target, wire);
  }
}
const body = `${JSON.stringify(buildAnalyticsConformanceFixture(), null, 2)}\n`;
for (const path of paths.length === 0
  ? [defaultPath]
  : paths.map((path) => NodePath.resolve(path))) {
  if (check) {
    if ((await NodeFSP.readFile(path, "utf8")) !== body)
      throw new Error(`Stale analytics contract fixture: ${path}`);
  } else {
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, body);
  }
}
