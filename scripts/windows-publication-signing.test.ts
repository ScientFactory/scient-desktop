// @effect-diagnostics nodeBuiltinImport:off - Rehearse the publication gate with temporary files and a local gh fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { parse } from "yaml";

import { createScientReleaseHandoff } from "./create-scient-release-handoff.ts";
import {
  decideWindowsPublication,
  pinnedWindowsPublishers,
  readWindowsSigningAttestation,
} from "./windows-publication-signing.ts";

const PUBLISHER = "ScientFactory Ltd";
const signed = { signed: true, publisherName: PUBLISHER } as const;
const unsigned = { signed: false, publisherName: null } as const;

describe("Windows publication signing gate", () => {
  it("keeps today's unsigned exception while no installed client pins a publisher", () => {
    // Handoffs published before the signing record pin nothing.
    const pinned = pinnedWindowsPublishers([{ version: "0.6.29" }, { windows: { signed: false } }]);
    assert.deepStrictEqual(pinned, []);
    assert.throws(
      () => decideWindowsPublication({ candidate: unsigned, pinned, allowUnsigned: false }),
      /allow_unsigned_windows=true/,
    );
    assert.match(
      decideWindowsPublication({ candidate: unsigned, pinned, allowUnsigned: true }).warning ?? "",
      /unsigned Windows installer/,
    );
    assert.isNull(
      decideWindowsPublication({ candidate: signed, pinned, allowUnsigned: false }).warning,
    );
  });

  it("refuses an unsigned or differently signed installer once any channel pins a publisher", () => {
    const pinned = pinnedWindowsPublishers([
      { windows: { signed: false } },
      { windows: { signed: true, publisherName: PUBLISHER } },
    ]);
    assert.deepStrictEqual(pinned, [PUBLISHER]);
    assert.throws(
      () => decideWindowsPublication({ candidate: unsigned, pinned, allowUnsigned: true }),
      /cannot override/,
    );
    assert.throws(
      () =>
        decideWindowsPublication({
          candidate: { signed: true, publisherName: "Someone Else" },
          pinned,
          allowUnsigned: true,
        }),
      /signed by 'Someone Else'/,
    );
    assert.isNull(
      decideWindowsPublication({ candidate: signed, pinned, allowUnsigned: false }).warning,
    );
  });

  it("fails closed on attestations and records it cannot read", () => {
    assert.throws(
      () => readWindowsSigningAttestation({ platform: "win", arch: "x64", signed: true }),
      /must name its publisher/,
    );
    assert.throws(
      () =>
        readWindowsSigningAttestation({
          platform: "win",
          arch: "x64",
          signed: false,
          publisherName: PUBLISHER,
        }),
      /cannot name a publisher/,
    );
    assert.throws(() => pinnedWindowsPublishers([{ windows: { signed: "yes" } }]));
  });

  it("records the signing attestation in the handoff the next publication reads", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-windows-handoff-"));
    try {
      const assets = NodePath.join(root, "assets");
      NodeFS.mkdirSync(assets);
      NodeFS.writeFileSync(NodePath.join(assets, "Scient-0.6.30-x64.exe"), "installer");
      const attestation = NodePath.join(root, "signing-win-x64.json");
      const output = NodePath.join(assets, "scient-release-handoff.json");
      const create = () =>
        createScientReleaseHandoff([
          "--assets-dir",
          assets,
          "--version",
          "0.6.30",
          "--channel",
          "stable",
          "--repository",
          "ScientFactory/scient-desktop",
          "--source-sha",
          "a".repeat(40),
          "--source-tree",
          "b".repeat(40),
          "--windows-signing",
          attestation,
          "--output",
          output,
        ]);
      const pinnedAfter = (record: object) => {
        NodeFS.writeFileSync(
          attestation,
          JSON.stringify({ platform: "win", arch: "x64", ...record }),
        );
        create();
        return pinnedWindowsPublishers([JSON.parse(NodeFS.readFileSync(output, "utf8"))]);
      };

      assert.deepStrictEqual(pinnedAfter({ signed: true, publisherName: PUBLISHER }), [PUBLISHER]);
      assert.deepStrictEqual(pinnedAfter({ signed: false }), []);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});

const workflow = parse(
  NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "../.github/workflows/release.yml"),
    "utf8",
  ),
) as { jobs: { assemble: { steps: Array<{ name?: string; run?: string }> } } };
const gateStep = workflow.jobs.assemble.steps.find(
  (entry) => entry.name === "Require signed macOS and explicitly approved Windows publication",
)?.run;

// oxlint-disable-next-line t3code/no-global-process-runtime -- This synchronous platform gate skips the Linux Bash step on native Windows.
describe.skipIf(process.platform === "win32")("Windows publication gate step", () => {
  it("reads the newest Stable and Beta handoffs before deciding", () => {
    if (!gateStep) throw new Error("Missing the publication signing step.");
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-windows-gate-"));
    try {
      const bin = NodePath.join(root, "bin");
      NodeFS.mkdirSync(bin);
      NodeFS.mkdirSync(NodePath.join(root, "release-assets"));
      NodeFS.symlinkSync(import.meta.dirname, NodePath.join(root, "scripts"));
      for (const arch of ["arm64", "x64"]) {
        NodeFS.writeFileSync(
          NodePath.join(root, `release-assets/signing-mac-${arch}.json`),
          JSON.stringify({ platform: "mac", arch, signed: true }),
        );
      }
      NodeFS.writeFileSync(
        NodePath.join(root, "release-assets/signing-win-x64.json"),
        JSON.stringify({ platform: "win", arch: "x64", signed: false }),
      );
      // Only the newest Beta is signed: its clients can switch to Stable, so Stable is bound too.
      NodeFS.writeFileSync(
        NodePath.join(bin, "gh"),
        `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'api' && args[1].endsWith('/scient-desktop/releases/latest')) process.stdout.write('v0.6.30\\n');
else if (args[0] === 'api' && args[1].startsWith('repos/ScientFactory/scient-desktop-beta/releases')) process.stdout.write(process.env.BETA_TAG + '\\n');
else if (args[0] === 'release' && args[1] === 'download') {
  const handoff = args[2] === 'v0.6.30' ? { version: '0.6.30' } : { windows: { signed: true, publisherName: 'ScientFactory Ltd' } };
  fs.writeFileSync(args[args.indexOf('--output') + 1], JSON.stringify(handoff));
} else process.exit(2);
`,
        { mode: 0o700 },
      );
      const run = (betaTag: string) =>
        NodeChildProcess.spawnSync("bash", ["-c", gateStep], {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            RUNNER_TEMP: root,
            BETA_TAG: betaTag,
            ALLOW_UNSIGNED_WINDOWS: "true",
            SCIENT_DESKTOP_CANONICAL_REPOSITORY: "ScientFactory/scient-desktop",
            SCIENT_DESKTOP_BETA_REPOSITORY: "ScientFactory/scient-desktop-beta",
          },
          encoding: "utf8",
        });

      const pinned = run("v0.6.31-beta.20261116.1");
      assert.notStrictEqual(pinned.status, 0);
      assert.match(pinned.stderr, /pin publisher 'ScientFactory Ltd'/);
      // With no Beta published, the explicit exception still allows today's unsigned build.
      const none = run("");
      assert.strictEqual(none.status, 0, none.stderr);
      assert.match(none.stdout, /WARNING: Publishing an unsigned Windows installer/);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
