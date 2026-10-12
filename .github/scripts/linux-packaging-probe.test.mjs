import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeTest from "node:test";
import {
  inspectLinuxPayload,
  compareLinuxPayloads,
} from "../../scripts/qualify-linux-packaged-runtime.mjs";

const require = NodeModule.createRequire(new URL("../../scripts/package.json", import.meta.url));
const { createPackage, uncacheAll } = await import(require.resolve("@electron/asar"));
const binaries = [
  "resource-monitor/t3-resource-monitor",
  "whisper-runtime/whisper-server",
  "synctex-runtime/synctex",
  "kde-capture/t3-kde-snap-shot",
  "hyprland-capture/t3-hyprland-snap-shot",
];
const icon = "apps/desktop/prod-resources/icon.png";

async function fixture(parent, name, duplicate = false) {
  const root = NodePath.join(parent, name);
  const resources = NodePath.join(root, "resources");
  const source = NodePath.join(parent, `${name}-archive-source`);
  const write = (base, file, bytes) => {
    const target = NodePath.join(base, file);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, bytes);
  };
  for (const file of binaries) {
    write(resources, file, file);
    NodeFS.chmodSync(NodePath.join(resources, file), 0o755);
  }
  for (const dir of ["whisper-runtime", "synctex-runtime"]) {
    write(resources, `${dir}/LICENSE`, "retained license");
    write(resources, `${dir}/receipt.json`, "{}");
  }
  write(resources, "whisper-runtime/libwhisper.so", "retained shared library");
  write(source, icon, Buffer.from("89504e470d0a1a0a", "hex"));
  write(source, "app.js", "retained application code");
  if (duplicate) {
    for (const file of NodeFS.readdirSync(resources, { recursive: true })) {
      if (NodeFS.statSync(NodePath.join(resources, file)).isFile())
        write(
          source,
          `apps/desktop/prod-resources/${file}`,
          NodeFS.readFileSync(NodePath.join(resources, file)),
        );
    }
  }
  await createPackage(source, NodePath.join(resources, "app.asar"));
  return { root, source, archive: NodePath.join(resources, "app.asar") };
}

NodeTest.test(
  "real ASAR accepts retained branding/external runtimes and rejects duplicate staging",
  async () => {
    const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "linux-payload-test-"));
    try {
      const clean = await fixture(scratch, "clean");
      inspectLinuxPayload(clean.root);
      const baseline = await fixture(scratch, "baseline", true);
      NodeAssert.throws(() => inspectLinuxPayload(baseline.root), /Duplicate runtime staging/);
      const result = compareLinuxPayloads(clean.root, baseline.root);
      NodeAssert.ok(result.restoredBytes > 0);
      NodeAssert.equal(result.externalBytesAndModesVerified, true);
      NodeFS.writeFileSync(
        NodePath.join(baseline.source, "app.js"),
        "changed retained application",
      );
      await createPackage(baseline.source, baseline.archive);
      NodeAssert.throws(
        () => compareLinuxPayloads(clean.root, baseline.root),
        /Retained ASAR bytes changed/,
      );
    } finally {
      NodeFS.rmSync(scratch, { recursive: true, force: true });
    }
  },
);

NodeTest.test("archive inspection rejects missing registration icon and debug maps", async () => {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "linux-payload-test-"));
  try {
    const clean = await fixture(scratch, "clean");
    NodeFS.writeFileSync(NodePath.join(clean.source, "app.js.map"), "debug source map");
    await createPackage(clean.source, clean.archive);
    NodeAssert.throws(() => inspectLinuxPayload(clean.root), /Source maps/);
    NodeFS.rmSync(NodePath.join(clean.source, "app.js.map"));
    NodeFS.rmSync(NodePath.join(clean.source, icon));
    await createPackage(clean.source, clean.archive);
    uncacheAll();
    NodeAssert.throws(() => inspectLinuxPayload(clean.root), /registration icon/);
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
});

NodeTest.test("external input mode and baseline resource drift cannot silently pass", async () => {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "linux-payload-test-"));
  try {
    const clean = await fixture(scratch, "clean");
    const baseline = await fixture(scratch, "baseline", true);
    const executable = NodePath.join(clean.root, "resources/synctex-runtime/synctex");
    NodeFS.chmodSync(executable, 0o644);
    NodeAssert.throws(() => inspectLinuxPayload(clean.root), /not executable/);
    NodeFS.chmodSync(executable, 0o755);
    NodeFS.writeFileSync(
      NodePath.join(baseline.root, "resources/whisper-runtime/libwhisper.so"),
      "wrong library",
    );
    NodeAssert.throws(
      () => compareLinuxPayloads(clean.root, baseline.root),
      /External bytes changed/,
    );
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
});
