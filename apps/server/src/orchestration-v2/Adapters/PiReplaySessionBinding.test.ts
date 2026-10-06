// @effect-diagnostics nodeBuiltinImport:off - test-only preservation reads the original immutable recording.
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as Predicate from "effect/Predicate";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProviderReplayTranscript } from "@t3tools/contracts";
import { decodeProviderReplayNdjson } from "../testkit/ReplayTranscriptNdjson.ts";
import { assert, describe, it } from "@effect/vitest";
import type { ProviderReplayEntry } from "@t3tools/contracts";
import {
  PiReplaySessionBinding,
  reconcilePiSimpleSettleTail,
  reconcilePiRecordedSchedules,
} from "./PiReplaySessionBinding.testkit.ts";

const root = "/owned/pi/sessions";
const actualFile = `${root}/owned.jsonl`;
const recordedFile = "/pi-sessions/session-1.jsonl";
const args = ["--mode", "rpc", "--model", "provider/model", "--extension", "<any>"];
function transcript(): Array<ProviderReplayEntry> {
  return [
    { type: "expect_outbound", label: "process_start", frame: { type: "process_start", args } },
    { type: "expect_outbound", label: "get_state", frame: { type: "get_state", id: "t3-0" } },
    {
      type: "emit_inbound",
      label: "response:get_state",
      frame: {
        type: "response",
        command: "get_state",
        id: "t3-0",
        success: true,
        data: {
          sessionFile: recordedFile,
          sessionId: "recorded-id",
          model: { id: "provider/model" },
        },
      },
    },
    { type: "expect_outbound", label: "process_start@p2", frame: { type: "process_start", args } },
    { type: "expect_outbound", label: "get_state@p2", frame: { type: "get_state", id: "t3-1" } },
    {
      type: "emit_inbound",
      label: "response:get_state@p2",
      frame: {
        type: "response",
        command: "get_state",
        id: "t3-1",
        success: true,
        data: {
          sessionFile: recordedFile,
          sessionId: "recorded-id",
          model: { id: "provider/model" },
        },
      },
    },
  ];
}
const launch = (ordinal = 1, file = actualFile) => ({
  ordinal,
  cwd: "/workspace",
  args: [...args.slice(0, -1), "/actual-extension", "--session", file],
});
describe("Pi recorded session identity binding", () => {
  it("preserves original bytes, non-session arguments, ids and process ordinal while binding one owned file across reopen", () => {
    const recorded = transcript();
    const original = JSON.stringify(recorded);
    const binding = new PiReplaySessionBinding(recorded, root);
    const initial = binding.bind(launch());
    assert.deepEqual(initial.headers, [{ file: actualFile, id: "recorded-id", cwd: "/workspace" }]);
    assert.deepEqual(initial.entries[0], {
      type: "expect_outbound",
      label: "process_start",
      frame: { type: "process_start", args: [...args, "--session", actualFile] },
    });
    assert.deepEqual(initial.entries[2], {
      type: "emit_inbound",
      label: "response:get_state",
      frame: {
        type: "response",
        command: "get_state",
        id: "t3-0",
        success: true,
        data: {
          sessionFile: actualFile,
          sessionId: "recorded-id",
          model: { id: "provider/model" },
        },
      },
    });
    const reopened = binding.bind(launch(2));
    assert.deepEqual(reopened.entries[0], initial.entries[0]);
    assert.deepEqual(reopened.entries[3], {
      type: "expect_outbound",
      label: "process_start@p2",
      frame: { type: "process_start", args: [...args, "--session", actualFile] },
    });
    assert.equal(JSON.stringify(recorded), original);
  });
  it.each(["missing", "duplicate", "foreign", "noncanonical", "changed-arg", "reordered"])(
    "rejects %s launch identity",
    (condition) => {
      const binding = new PiReplaySessionBinding(transcript(), root);
      const input = launch();
      switch (condition) {
        case "missing":
          input.args.splice(-2);
          break;
        case "duplicate":
          input.args.unshift("--session", actualFile);
          break;
        case "foreign":
          input.args[input.args.length - 1] = "/foreign/owned.jsonl";
          break;
        case "noncanonical":
          input.args[input.args.length - 1] = `${root}/../sessions/owned.jsonl`;
          break;
        case "changed-arg":
          input.args[3] = "different/model";
          break;
        case "reordered":
          [input.args[0], input.args[1]] = [input.args[1]!, input.args[0]!];
          break;
      }
      assert.throws(() => binding.bind(input), /Pi replay/);
    },
  );
  it("rejects duplicate and skipped process ordinals", () => {
    const binding = new PiReplaySessionBinding(transcript(), root);
    assert.throws(() => binding.bind(launch(2)), /ordinal/);
    binding.bind(launch());
    assert.throws(() => binding.bind(launch()), /ordinal/);
  });
  it("rejects a different session file or workspace on reopen", () => {
    const binding = new PiReplaySessionBinding(transcript(), root);
    binding.bind(launch());
    assert.throws(() => binding.bind(launch(2, `${root}/different.jsonl`)), /reopen/);
    assert.throws(() => binding.bind({ ...launch(2), cwd: "/foreign" }), /workspace/);
  });
  it("rejects conflicting recorded session ids and undeclared sessionPath frames", () => {
    const conflict = transcript();
    conflict[5] = {
      type: "emit_inbound",
      label: "response:get_state@p2",
      frame: {
        type: "response",
        command: "get_state",
        success: true,
        data: { sessionFile: recordedFile, sessionId: "different-id" },
      },
    };
    assert.throws(() => new PiReplaySessionBinding(conflict, root), /inconsistent/);
    const foreign = transcript();
    foreign.push({
      type: "expect_outbound",
      label: "switch_session",
      frame: { type: "switch_session", sessionPath: "/foreign/session.jsonl" },
    });
    assert.throws(() => new PiReplaySessionBinding(foreign, root).bind(launch()), /undeclared/);
  });
});

const originalSimpleBytes = NodeFS.readFileSync(
  new URL("../testkit/fixtures/simple/pi_transcript.ndjson", import.meta.url),
  "utf8",
);
const originalSimple = () => decodeProviderReplayNdjson(originalSimpleBytes);
const decodeRecordedArgs = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const decodeTranscript = Schema.decodeUnknownSync(ProviderReplayTranscript);

describe("Pi simple recorded settle-tail reconciliation", () => {
  it.effect(
    "preserves all original frames and strict bindings while deriving only an explicit static final state",
    () =>
      Effect.gen(function* () {
        assert.equal(
          NodeCrypto.createHash("sha256").update(originalSimpleBytes).digest("hex"),
          "e22ab72047abe327745e481bf6290fe381f6bd990f51e47228869fb50bb0b8c0",
        );
        const recorded = yield* originalSimple();
        const before = structuredClone(recorded);
        const result = reconcilePiSimpleSettleTail(recorded);
        assert.equal(recorded.entries.length, 49);
        assert.equal(result.length, 51);
        assert.deepEqual(result.slice(0, 45), recorded.entries.slice(0, 45));
        assert.deepEqual(result.slice(45, 49), [
          recorded.entries[47],
          recorded.entries[48],
          recorded.entries[45],
          recorded.entries[46],
        ]);
        const state = recorded.entries[44]!;
        assert.equal(state.type, "emit_inbound");
        if (
          state.type !== "emit_inbound" ||
          !Predicate.isObject(state.frame) ||
          !Predicate.isObject(state.frame.data)
        )
          throw new Error("Expected recorded state");
        assert.deepEqual(result[49], {
          type: "expect_outbound",
          label: "synthetic:settle-confirmation:get_state",
          frame: { type: "get_state", id: "t3-900003" },
        });
        assert.deepEqual(result[50], {
          ...state,
          label: "synthetic:settle-confirmation:response:get_state",
          frame: { ...state.frame, id: "t3-900003" },
        });
        assert.deepEqual(recorded, before);
        const start = recorded.entries[0]!;
        if (
          start.type !== "expect_outbound" ||
          !Predicate.isObject(start.frame) ||
          !Array.isArray(start.frame.args)
        )
          throw new Error("Expected recorded argv");
        const recordedArgs = decodeRecordedArgs(start.frame.args);
        const binding = new PiReplaySessionBinding(result, root);
        const bound = binding.bind({
          ordinal: 1,
          cwd: "/workspace",
          args: [...recordedArgs.slice(0, -1), "/owned/extension.ts", "--session", actualFile],
        });
        const confirmation = bound.entries[50]!;
        if (
          confirmation.type !== "emit_inbound" ||
          !Predicate.isObject(confirmation.frame) ||
          !Predicate.isObject(confirmation.frame.data)
        )
          throw new Error("Expected confirmation state");
        assert.deepEqual(confirmation.frame.data, { ...state.frame.data, sessionFile: actualFile });
        assert.deepEqual(bound.headers, [
          { file: actualFile, id: "00000000-0000-4000-8000-000000000002", cwd: "/workspace" },
        ]);
        assert.throws(
          () =>
            binding.bind({
              ordinal: 2,
              cwd: "/foreign",
              args: [...recordedArgs.slice(0, -1), "/owned/extension.ts", "--session", actualFile],
            }),
          /workspace/,
        );
      }),
  );
  it.effect.each([
    "streaming",
    "compacting",
    "pending",
    "model",
    "effort",
    "uuid",
    "file",
    "stats-session",
    "tree-leaf",
    "process",
    "collision",
    "activity",
  ])("rejects changed %s truth rather than inventing confirmation", (condition) =>
    Effect.gen(function* () {
      const parsed = yield* originalSimple();
      const entries = parsed.entries.map((entry) => ({ ...entry }));
      const state = entries[44]!;
      const stats = entries[48]!;
      const tree = entries[46]!;
      if (
        state.type !== "emit_inbound" ||
        !Predicate.isObject(state.frame) ||
        !Predicate.isObject(state.frame.data) ||
        stats.type !== "emit_inbound" ||
        !Predicate.isObject(stats.frame) ||
        !Predicate.isObject(stats.frame.data) ||
        tree.type !== "emit_inbound" ||
        !Predicate.isObject(tree.frame) ||
        !Predicate.isObject(tree.frame.data)
      )
        throw new Error("Expected recorded tail");
      const changedState = { ...state.frame.data };
      switch (condition) {
        case "streaming":
          changedState.isStreaming = true;
          break;
        case "compacting":
          changedState.isCompacting = true;
          break;
        case "pending":
          changedState.pendingMessageCount = 1;
          break;
        case "model":
          changedState.model = { provider: "foreign", id: "foreign" };
          break;
        case "effort":
          changedState.thinkingLevel = "off";
          break;
        case "uuid":
          changedState.sessionId = "foreign";
          break;
        case "file":
          changedState.sessionFile = "/foreign/session.jsonl";
          break;
        case "stats-session":
          entries[48] = {
            ...stats,
            frame: { ...stats.frame, data: { ...stats.frame.data, sessionId: "foreign" } },
          };
          break;
        case "tree-leaf":
          entries[46] = {
            ...tree,
            frame: { ...tree.frame, data: { ...tree.frame.data, leafId: "foreign" } },
          };
          break;
        case "process":
          entries[44] = { ...state, label: "response:get_state@p2" };
          break;
        case "collision":
          entries[1] = {
            type: "expect_outbound",
            label: "get_state",
            frame: { type: "get_state", id: "t3-900003" },
          };
          break;
        case "activity":
          entries.splice(45, 0, {
            type: "emit_inbound",
            label: "agent_start",
            frame: { type: "agent_start" },
          });
          break;
      }
      if (
        ["streaming", "compacting", "pending", "model", "effort", "uuid", "file"].includes(
          condition,
        )
      )
        entries[44] = { ...state, frame: { ...state.frame, data: changedState } };
      assert.throws(() => reconcilePiSimpleSettleTail({ ...parsed, entries }), /pinned recording/);
    }),
  );
  it.effect(
    "rejects truncation, reapplication and any unpinned change but leaves other scenarios untouched",
    () =>
      Effect.gen(function* () {
        const original = yield* originalSimple();
        assert.throws(
          () =>
            reconcilePiSimpleSettleTail({ ...original, entries: original.entries.slice(0, 48) }),
          /pinned recording/,
        );
        const prepared = reconcilePiSimpleSettleTail(original);
        assert.throws(
          () => reconcilePiSimpleSettleTail({ ...original, entries: prepared }),
          /pinned recording/,
        );
        const changed = decodeTranscript({
          ...original,
          entries: original.entries.map((entry, index) =>
            index === 20 && entry.type === "emit_inbound" && Predicate.isObject(entry.frame)
              ? { ...entry, frame: { ...entry.frame, data: { disposition: "rejected" } } }
              : entry,
          ),
        });
        assert.throws(() => reconcilePiSimpleSettleTail(changed), /pinned recording/);
        assert.strictEqual(
          reconcilePiSimpleSettleTail({ ...original, scenario: "multi_turn" }),
          original.entries,
        );
      }),
  );
});

const originalSchedulePins = {
  multi_turn: "71b8237c9be726330faa7a9d8e7ae1888966bbe8f16ffd0096593459b3afb1a7",
  pi_compaction: "26226612d6558dbb6a3bcc5ae696859a5106e1e2b3ab1b52a2138f2dae043a67",
  provider_thread_resume: "9b54ec08420f59e0fa94786f91baebd7e0ae045343e7f568324163fb12fdcf38",
  message_steering: "57eed804122a202e5804019400e576fdf337221f23c9b7231b0e8b19b2cf20ab",
  thread_rollback: "bd1ddccb72e23676b8c22fda18e9b456457ff18df82354b829b113c4b87edac5",
  thread_rollback_after_stop: "e66dc46f638aa02af9d14817ece8cf4c8cd245613695ef596237b75a938f8f25",
} as const;

describe("Pi pinned native read schedules", () => {
  for (const [scenario, digest] of Object.entries(originalSchedulePins)) {
    const bytes = () =>
      NodeFS.readFileSync(
        new URL(`../testkit/fixtures/${scenario}/pi_transcript.ndjson`, import.meta.url),
        "utf8",
      );
    it.effect(
      `preserves ${scenario} recording, native activity and session selection with explicit read-only observations`,
      () =>
        Effect.gen(function* () {
          const raw = bytes();
          assert.equal(NodeCrypto.createHash("sha256").update(raw).digest("hex"), digest);
          const recorded = yield* decodeProviderReplayNdjson(raw);
          const before = structuredClone(recorded);
          const prepared = reconcilePiRecordedSchedules(recorded);
          const real = prepared.filter(
            (entry) => entry.type === "runtime_exit" || !entry.label?.startsWith("synthetic:"),
          );
          assert.equal(real.length, recorded.entries.length);
          for (const entry of recorded.entries)
            assert.equal(real.filter((candidate) => candidate === entry).length, 1);
          const activity = (entries: ReadonlyArray<ProviderReplayEntry>) =>
            entries.filter(
              (entry) =>
                entry.type !== "runtime_exit" &&
                Predicate.isObject(entry.frame) &&
                entry.frame.type !== "get_state" &&
                entry.frame.type !== "get_entries" &&
                entry.frame.type !== "get_session_stats" &&
                !(
                  entry.frame.type === "response" &&
                  ["get_state", "get_entries", "get_session_stats"].includes(
                    String(entry.frame.command),
                  )
                ),
            );
          assert.deepEqual(activity(prepared), activity(recorded.entries));
          const confirmations = prepared.filter(
            (entry) =>
              entry.type === "emit_inbound" &&
              entry.label?.startsWith("synthetic:settle-confirmation:"),
          );
          assert.equal(
            confirmations.length,
            new Map(
              Object.entries({
                multi_turn: 2,
                pi_compaction: 8,
                provider_thread_resume: 2,
                message_steering: 1,
                thread_rollback: 3,
                thread_rollback_after_stop: 3,
              }),
            ).get(scenario),
          );
          for (const entry of confirmations) {
            if (
              entry.type !== "emit_inbound" ||
              !Predicate.isObject(entry.frame) ||
              !Predicate.isObject(entry.frame.data)
            )
              throw new Error("Missing confirming state");
            const frame = entry.frame;
            const data = entry.frame.data;
            assert.equal(data.isStreaming, false);
            assert.equal(data.isCompacting, false);
            assert.equal(data.pendingMessageCount, 0);
            assert.isTrue(
              recorded.entries.some(
                (original) =>
                  original.type === "emit_inbound" &&
                  Predicate.isObject(original.frame) &&
                  original.frame.command === "get_state" &&
                  JSON.stringify(original.frame.data) === JSON.stringify(data) &&
                  original.label?.endsWith("@p2") === entry.label?.endsWith("@p2"),
              ),
            );
            const position = prepared.indexOf(entry);
            const request = prepared[position - 1]!;
            assert.deepEqual(request.type === "expect_outbound" ? request.frame : null, {
              type: "get_state",
              id: frame.id,
            });
            const dualProbe =
              scenario === "pi_compaction" &&
              ["t3-910001", "t3-930005", "t3-910004", "t3-930014"].includes(String(frame.id));
            if (dualProbe) {
              const reads = prepared
                .slice(0, position)
                .filter(
                  (candidate) =>
                    candidate.type === "emit_inbound" &&
                    candidate.label?.startsWith("synthetic:concurrent-compaction-probe:"),
                );
              const statistics = reads.findLast(
                (candidate) =>
                  candidate.type === "emit_inbound" &&
                  Predicate.isObject(candidate.frame) &&
                  candidate.frame.command === "get_session_stats",
              );
              const tree = reads.findLast(
                (candidate) =>
                  candidate.type === "emit_inbound" &&
                  Predicate.isObject(candidate.frame) &&
                  candidate.frame.command === "get_entries",
              );
              assert.isDefined(statistics);
              assert.isDefined(tree);
              assert.isBelow(prepared.indexOf(statistics), prepared.indexOf(tree));
              for (const copied of [statistics, tree]) {
                if (copied.type !== "emit_inbound" || !Predicate.isObject(copied.frame))
                  throw new Error("Missing copied read");
                const copiedFrame = copied.frame;
                assert.isTrue(
                  recorded.entries.some(
                    (original) =>
                      original.type === "emit_inbound" &&
                      Predicate.isObject(original.frame) &&
                      original.frame.command === copiedFrame.command &&
                      JSON.stringify(original.frame.data) === JSON.stringify(copiedFrame.data),
                  ),
                );
                const correlated = prepared.find(
                  (candidate) =>
                    candidate.type === "expect_outbound" &&
                    Predicate.isObject(candidate.frame) &&
                    candidate.frame.id === copiedFrame.id,
                );
                assert.isDefined(correlated);
                assert.isBelow(prepared.indexOf(correlated), prepared.indexOf(copied));
              }
            } else {
              const tree = prepared[position - 2]!;
              const statistics = prepared[position - 4]!;
              assert.isTrue(
                tree.type === "emit_inbound" &&
                  Predicate.isObject(tree.frame) &&
                  tree.frame.command === "get_entries",
              );
              assert.isTrue(
                statistics.type === "emit_inbound" &&
                  Predicate.isObject(statistics.frame) &&
                  statistics.frame.command === "get_session_stats",
              );
            }
          }
          const streaming = prepared.filter(
            (entry) =>
              entry.type === "emit_inbound" &&
              entry.label === "synthetic:streaming-identity-preflight:response:get_state",
          );
          assert.equal(streaming.length, scenario === "message_steering" ? 1 : 0);
          if (scenario === "message_steering") {
            const entry = streaming[0]!;
            const selected = recorded.entries[15]!;
            if (
              entry.type !== "emit_inbound" ||
              !Predicate.isObject(entry.frame) ||
              !Predicate.isObject(entry.frame.data) ||
              selected.type !== "emit_inbound" ||
              !Predicate.isObject(selected.frame) ||
              !Predicate.isObject(selected.frame.data)
            )
              throw new Error("Missing steering identity");
            const data = entry.frame.data;
            assert.equal(data.isStreaming, true);
            assert.equal(data.sessionFile, selected.frame.data.sessionFile);
            assert.equal(data.sessionId, selected.frame.data.sessionId);
            assert.deepEqual(data.model, selected.frame.data.model);
            assert.equal(data.thinkingLevel, selected.frame.data.thinkingLevel);
            assert.strictEqual(prepared[prepared.indexOf(entry) + 1], recorded.entries[27]);
          }
          assert.deepEqual(recorded, before);
          assert.equal(bytes(), raw);
        }),
    );
    it.effect(
      `refuses unpinned ${scenario} state, activity, order, truncation and reapplication`,
      () =>
        Effect.gen(function* () {
          const recorded = yield* decodeProviderReplayNdjson(bytes());
          const changedIdentity = structuredClone(recorded.entries);
          const state = changedIdentity.find(
            (entry) =>
              entry.type === "emit_inbound" &&
              Predicate.isObject(entry.frame) &&
              entry.frame.command === "get_state",
          );
          if (
            state?.type !== "emit_inbound" ||
            !Predicate.isObject(state.frame) ||
            !Predicate.isObject(state.frame.data)
          )
            throw new Error("Missing state");
          state.frame.data.sessionId = "foreign";
          const reordered = [...recorded.entries];
          [reordered[1], reordered[2]] = [reordered[2]!, reordered[1]!];
          for (const entries of [
            changedIdentity,
            reordered,
            recorded.entries.slice(0, -1),
            [
              ...recorded.entries,
              {
                type: "emit_inbound",
                label: "agent_start",
                frame: { type: "agent_start" },
              } satisfies ProviderReplayEntry,
            ],
            reconcilePiRecordedSchedules(recorded),
          ])
            assert.throws(
              () => reconcilePiRecordedSchedules({ ...recorded, entries }),
              /pinned recording/,
            );
        }),
    );
  }
});
