# Update-manifest fixtures

The root captures retain Electron Builder 26.15.6 output. They remain parser
compatibility inputs after the desktop builder changes.

`electron-builder-26.16.1/` captures the installed, lockfile-pinned
`app-builder-lib` 26.16.1 `writeUpdateInfoFiles` emitter using those historical
artifact records as synthetic input. This qualifies the emitted YAML format,
not native packaging, signing, upload or updater execution. No artifact is
published. Electron Builder is MIT-licensed; these are test data, not a bundled
copy of its implementation.
Raw YAML is stored as JSON string values in `manifests.json` so source
formatting cannot change the emitter's quoting or other syntax.

From the repository root, with frozen dependencies installed:

```sh
node --input-type=module <<'JS'
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { createRequire } from "node:module";
const desktop = createRequire(new URL("./apps/desktop/package.json", import.meta.url));
const builder = createRequire(desktop.resolve("electron-builder/package.json"));
const scripts = createRequire(new URL("./scripts/package.json", import.meta.url));
const version = "26.16.1";
if (desktop("electron-builder/package.json").version !== version ||
    builder("app-builder-lib/package.json").version !== version) {
  throw new Error("Install the pinned Electron Builder 26.16.1 before capture");
}
const emitter = builder.resolve("app-builder-lib/out/publish/updateInfoBuilder.js");
const { writeUpdateInfoFiles } = builder(emitter);
const root = path.resolve("scripts/fixtures/release-manifests");
const output = path.join(root, `electron-builder-${version}`);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "scient-manifest-capture-"));
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const inputSha256 = {};
const manifests = {};
const tasks = [];
for (const name of ["latest-mac.yml", "latest.yml", "latest-linux.yml"]) {
  const bytes = await fs.readFile(path.join(root, name));
  inputSha256[name] = sha256(bytes);
  tasks.push({
    file: path.join(temporary, name),
    info: scripts("yaml").parse(bytes.toString("utf8")),
    publishConfiguration: { provider: "generic", url: "https://example.invalid/" },
    arch: null,
    packager: {},
  });
}
try {
  await writeUpdateInfoFiles(tasks, {
    emitArtifactCreated: async ({ file, fileContent }) => {
      manifests[path.basename(file)] = fileContent.toString("utf8");
    },
  });
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
if (Object.keys(manifests).length !== 3) throw new Error("Expected three local manifests");
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, "manifests.json"), JSON.stringify(
  Object.fromEntries(tasks.map(({ file }) => [path.basename(file), manifests[path.basename(file)]])),
  null, 2,
) + "\n");
await fs.writeFile(path.join(output, "metadata.json"), JSON.stringify({
  electronBuilderVersion: version,
  capture: "writeUpdateInfoFiles with historical artifact records; no native build or publication",
  emitterSha256: sha256(await fs.readFile(emitter)),
  inputSha256,
  outputSha256: Object.fromEntries(tasks.map(({ file }) => [
    path.basename(file), sha256(manifests[path.basename(file)]),
  ])),
}, null, 2) + "\n");
JS
```

All release dates and artifact records come from the immutable input captures,
so rerunning this procedure must leave the output unchanged. The metadata records
the exact emitter and input digests. Keep prior captures when adding another
builder version; do not rewrite their provenance to match a package declaration.
