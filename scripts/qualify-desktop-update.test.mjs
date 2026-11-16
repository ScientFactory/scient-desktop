import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { qualifyTiming, timingEvents, verifyHandoff } from "./qualify-desktop-update.mjs";

const sourceSha = "a".repeat(40);
const identity = { attemptId: "attempt-1", fromVersion: "0.0.1", targetVersion: "0.0.2" };
const launch = { launchId: "launch-2", processId: 123 };
function receipts() {
  return [
    { ...identity, event: "confirmed" },
    { ...identity, event: "shutdown-started", elapsedMs: 20 },
    { ...identity, event: "native-handoff", elapsedMs: 30 },
    { ...identity, ...launch, event: "launched", confirmToLaunchMs: 40, handoffToLaunchMs: 10 },
    { ...identity, ...launch, event: "backend-ready", launchToBackendMs: 12 },
    {
      ...identity,
      ...launch,
      event: "workspace-ready",
      projectRestored: true,
      confirmToReadyMs: 60,
      launchToReadyMs: 20,
    },
  ];
}
const qualify = (events) => qualifyTiming(events, "0.0.1", "0.0.2");

NodeTest.test("reports preparation, shutdown and genuinely usable workspace separately", () => {
  NodeAssert.deepEqual(qualify(receipts()), {
    attemptId: "attempt-1",
    processId: 123,
    preparationAndSaveMs: 20,
    shutdownMs: 10,
    handoffToLaunchMs: 10,
    launchToBackendMs: 12,
    launchToReadyMs: 20,
    confirmToReadyMs: 60,
  });
});

NodeTest.test("does not qualify a launch or a rendered window as a usable workspace", () => {
  NodeAssert.throws(
    () => qualify(receipts().filter((event) => event.event !== "workspace-ready")),
    /workspace-ready/,
  );
  const events = receipts();
  events.at(-1).projectRestored = false;
  NodeAssert.throws(() => qualify(events), /project.*restored/i);
});

NodeTest.test(
  "rejects readiness from another launch, another process, or a mismatched version",
  () => {
    for (const change of [
      { launchId: "unrelated-launch" },
      { processId: 456 },
      { targetVersion: "0.0.3" },
    ]) {
      const events = receipts();
      Object.assign(events.at(-1), change);
      NodeAssert.throws(() => qualify(events));
    }
  },
);

NodeTest.test("rejects duplicate relaunch readiness and abandoned attempts", () => {
  const duplicate = receipts();
  duplicate.push({ ...duplicate.at(-1) });
  NodeAssert.throws(() => qualify(duplicate), /Exactly one workspace-ready/);
  NodeAssert.throws(
    () => qualify([...receipts(), { ...identity, event: "abandoned" }]),
    /abandoned/,
  );
});

NodeTest.test("rejects missing measurements and readiness predating the backend", () => {
  const missing = receipts();
  delete missing.at(-1).confirmToReadyMs;
  NodeAssert.throws(() => qualify(missing), /confirmToReadyMs/);
  const early = receipts();
  early.at(-1).launchToReadyMs = 1;
  NodeAssert.throws(() => qualify(early), /preceded/);
});

NodeTest.test(
  "reads only the actual structured restart log events and tolerates an incomplete final write",
  () => {
    const fields = { ...identity, event: "confirmed", component: "desktop-restart" };
    const text =
      JSON.stringify({
        events: [
          { name: "restart timing", attributes: fields },
          { name: "unrelated event", attributes: fields },
        ],
      }) + '\n{"events":';
    NodeAssert.deepEqual(timingEvents(text), [fields]);
  },
);

function candidate() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-update-evidence-test-"));
  const bytes = Buffer.from("immutable synthetic artifact");
  NodeFS.writeFileSync(NodePath.join(root, "payload.zip"), bytes);
  NodeFS.writeFileSync(
    NodePath.join(root, "scient-release-handoff.json"),
    JSON.stringify({
      schemaVersion: 1,
      product: "Scient",
      source: { repository: "ScientFactory/scient-desktop", commit: sourceSha },
      assets: [
        {
          name: "payload.zip",
          size: bytes.length,
          sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
        },
      ],
    }),
  );
  return root;
}

NodeTest.test(
  "refuses altered candidate bytes and a source commit different from the attestation",
  () => {
    const root = candidate();
    try {
      NodeAssert.equal(verifyHandoff(root, sourceSha).source.commit, sourceSha);
      NodeAssert.throws(() => verifyHandoff(root, "b".repeat(40)), /requested source commit/);
      NodeFS.writeFileSync(NodePath.join(root, "payload.zip"), "altered immutable artifact!!");
      NodeAssert.throws(() => verifyHandoff(root, sourceSha));
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);

NodeTest.test(
  "refuses unsealed files instead of accidentally qualifying a substituted manifest",
  () => {
    const root = candidate();
    try {
      NodeFS.writeFileSync(NodePath.join(root, "latest-mac.yml"), "version: 9.9.9\n");
      NodeAssert.throws(() => verifyHandoff(root, sourceSha), /unsealed/);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
