// @effect-diagnostics nodeBuiltinImport:off - Rehearse the publication gate with temporary files and a local gh fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

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
    const conflictingPins = pinnedWindowsPublishers([
      { windows: { signed: true, publisherName: PUBLISHER } },
      { windows: { signed: true, publisherName: "Different Channel Publisher" } },
    ]);
    for (const publisherName of conflictingPins) {
      assert.throws(
        () =>
          decideWindowsPublication({
            candidate: { signed: true, publisherName },
            pinned: conflictingPins,
            allowUnsigned: true,
          }),
        /would fail their update signature check/,
      );
    }
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

const stableRepository = "ScientFactory/scient-desktop";
const betaRepository = "ScientFactory/scient-desktop-beta";
const stableTag = "v0.6.30";
const betaTag = "v0.6.31-beta.20261116.1";
const betaRelease = { tag_name: betaTag, draft: false };

function publicationFixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-windows-gate-"));
  const bin = NodePath.join(root, "bin");
  const assets = NodePath.join(root, "release-assets");
  const attestation = NodePath.join(assets, "signing-win-x64.json");
  const candidateHandoff = NodePath.join(assets, "scient-release-handoff.json");
  const statePath = NodePath.join(root, "published.json");
  NodeFS.mkdirSync(bin);
  NodeFS.mkdirSync(assets);
  NodeFS.writeFileSync(NodePath.join(assets, "Scient-0.6.31-x64.exe"), "fixture installer");
  const setCandidate = (
    windows: { signed: boolean; publisherName?: string },
    channel: "stable" | "beta" = "stable",
  ) => {
    NodeFS.writeFileSync(attestation, JSON.stringify({ platform: "win", arch: "x64", ...windows }));
    createScientReleaseHandoff([
      "--assets-dir",
      assets,
      "--version",
      channel === "beta" ? betaTag.slice(1) : "0.6.31",
      "--channel",
      channel,
      "--repository",
      stableRepository,
      "--source-sha",
      "a".repeat(40),
      "--source-tree",
      "b".repeat(40),
      "--windows-signing",
      attestation,
      "--output",
      candidateHandoff,
    ]);
  };
  const setPublished = (state: {
    betaPages?: unknown;
    stableHandoff?: unknown;
    betaHandoff?: unknown;
    failure?: { key: string; status: number };
  }) => NodeFS.writeFileSync(statePath, JSON.stringify(state));
  NodeFS.writeFileSync(
    NodePath.join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.PUBLISHED_STATE, 'utf8'));
const endpoint = args.find(arg => arg.startsWith('repos/'));
let key;
let result;
if (args[0] === 'api' && endpoint === 'repos/${stableRepository}/releases/latest') {
  key = 'stable';
  result = { tag_name: '${stableTag}' };
} else if (args[0] === 'api' && args.includes('--paginate') && args.includes('--slurp') && endpoint === 'repos/${betaRepository}/releases?per_page=100') {
  key = 'beta';
  result = state.betaPages ?? [[]];
} else if (args[0] === 'release' && args[1] === 'download' && args[args.indexOf('--output') + 1] === '-') {
  const repo = args[args.indexOf('--repo') + 1];
  if (repo === '${stableRepository}' && args[2] === '${stableTag}') {
    key = 'stable-handoff';
    result = state.stableHandoff ?? { version: '0.6.30' };
  } else if (repo === '${betaRepository}' && args[2] === '${betaTag}') {
    key = 'beta-handoff';
    result = state.betaHandoff ?? { windows: { signed: true, publisherName: '${PUBLISHER}' } };
  }
}
if (!key) process.exit(2);
if (state.failure?.key === key) {
  process.stderr.write('HTTP ' + state.failure.status + '\\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify(result));
`,
    { mode: 0o700 },
  );
  setCandidate({ signed: false });
  setPublished({});
  return {
    setCandidate,
    setPublished,
    candidateHandoff,
    attestation,
    run(phase: "assembly" | "publication", allowUnsigned = true) {
      return NodeChildProcess.spawnSync(
        process.execPath,
        [
          NodePath.join(import.meta.dirname, "windows-publication-signing.ts"),
          phase === "assembly" ? "--attestation" : "--candidate-handoff",
          phase === "assembly" ? attestation : candidateHandoff,
          "--allow-unsigned",
          String(allowUnsigned),
          "--stable-repository",
          stableRepository,
          "--beta-repository",
          betaRepository,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            GH_TOKEN: "local-fixture",
            PUBLISHED_STATE: statePath,
          },
          encoding: "utf8",
        },
      );
    },
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

// oxlint-disable-next-line t3code/no-global-process-runtime -- The gh fixture uses a POSIX shebang, like the Linux publication job.
describe.skipIf(process.platform === "win32")("Windows publication gate CLI", () => {
  it("reads the newest Stable and Beta handoffs before deciding", () => {
    using fixture = publicationFixture();
    // A full first page of drafts must not hide the newest published Beta on the next page.
    fixture.setPublished({
      betaPages: [
        Array.from({ length: 100 }, () => ({ ...betaRelease, draft: true })),
        [betaRelease],
      ],
    });
    const pinned = fixture.run("assembly");
    assert.notStrictEqual(pinned.status, 0);
    assert.match(pinned.stderr, /pin publisher 'ScientFactory Ltd'/);
    fixture.setPublished({});
    const none = fixture.run("assembly");
    assert.strictEqual(none.status, 0, none.stderr);
    assert.match(none.stdout, /WARNING: Publishing an unsigned Windows installer/);
    const unapproved = fixture.run("assembly", false);
    assert.notStrictEqual(unapproved.status, 0);
    assert.match(unapproved.stderr, /allow_unsigned_windows=true/);
  });

  it("rejects the same unsigned candidate when Beta gains a pin while Stable awaits approval", () => {
    using fixture = publicationFixture();
    const candidate = NodeFS.readFileSync(fixture.candidateHandoff, "utf8");
    const assembled = fixture.run("assembly");
    assert.strictEqual(assembled.status, 0, assembled.stderr);
    NodeFS.unlinkSync(fixture.attestation);
    const beforePin = fixture.run("publication");
    assert.strictEqual(beforePin.status, 0, beforePin.stderr);

    fixture.setPublished({ betaPages: [[betaRelease]] });
    const afterPin = fixture.run("publication");
    assert.notStrictEqual(afterPin.status, 0);
    assert.match(afterPin.stderr, /cannot override/);
    assert.strictEqual(NodeFS.readFileSync(fixture.candidateHandoff, "utf8"), candidate);

    fixture.setCandidate({ signed: true, publisherName: PUBLISHER });
    const compatible = fixture.run("publication", false);
    assert.strictEqual(compatible.status, 0, compatible.stderr);
    fixture.setCandidate({ signed: true, publisherName: "Someone Else" });
    const incompatible = fixture.run("publication");
    assert.notStrictEqual(incompatible.status, 0);
    assert.match(incompatible.stderr, /signed by 'Someone Else'/);
  });

  it("also enforces a Stable pin when publishing Beta and refuses missing candidate signing", () => {
    using fixture = publicationFixture();
    fixture.setCandidate({ signed: false }, "beta");
    fixture.setPublished({ stableHandoff: { windows: signed } });
    const pinned = fixture.run("publication");
    assert.notStrictEqual(pinned.status, 0);
    assert.match(pinned.stderr, /pin publisher 'ScientFactory Ltd'/);

    fixture.setPublished({});
    const handoff = JSON.parse(NodeFS.readFileSync(fixture.candidateHandoff, "utf8"));
    delete handoff.windows;
    NodeFS.writeFileSync(fixture.candidateHandoff, JSON.stringify(handoff));
    const missing = fixture.run("publication");
    assert.notStrictEqual(missing.status, 0);
    assert.match(missing.stderr, /candidate handoff must record Windows signing/);
  });

  it("fails closed on public lookup and download errors, including 404 and 5xx", () => {
    using fixture = publicationFixture();
    for (const key of ["stable", "beta", "stable-handoff", "beta-handoff"]) {
      for (const status of [404, 503]) {
        fixture.setPublished({ betaPages: [[betaRelease]], failure: { key, status } });
        const failed = fixture.run("publication");
        assert.notStrictEqual(failed.status, 0, `${key}: HTTP ${status}`);
        assert.match(failed.stderr, new RegExp(`HTTP ${status}`));
      }
    }
  });

  it("fails closed on malformed public inventories and Windows signing records", () => {
    using fixture = publicationFixture();
    for (const state of [
      { betaPages: {} },
      { betaPages: [[{ tag_name: betaTag }]] },
      { stableHandoff: [] },
      { stableHandoff: { windows: null } },
      { betaPages: [[betaRelease]], betaHandoff: { windows: { signed: true } } },
    ]) {
      fixture.setPublished(state);
      const failed = fixture.run("publication");
      assert.notStrictEqual(failed.status, 0, JSON.stringify(state));
      assert.match(failed.stderr, /Cannot read|Invalid|must name its publisher/);
    }
  });
});
