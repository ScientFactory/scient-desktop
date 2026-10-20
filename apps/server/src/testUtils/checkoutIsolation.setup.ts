// @effect-diagnostics nodeBuiltinImport:off - vitest setup outside any Effect runtime.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// Git started anywhere below the source checkout's root must not find its repository: a
// test that falls back to `process.cwd()` (apps/server) would otherwise capture, publish,
// restore or clean inside the repository under test. Every Git child inherits this,
// whichever process runner starts it. Fixtures live in the OS temp directory, outside it.
const checkoutRoot = NodeURL.fileURLToPath(new URL("../../../../", import.meta.url));

// Setup files run again for every test file in the same worker process.
const ceilings = process.env.GIT_CEILING_DIRECTORIES?.split(NodePath.delimiter) ?? [];
if (!ceilings.includes(checkoutRoot)) {
  process.env.GIT_CEILING_DIRECTORIES = [...ceilings, checkoutRoot]
    .filter(Boolean)
    .join(NodePath.delimiter);
}
