import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import {
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { DroidControlClientFactory } from "./DroidControl.ts";
import { rewindDroidSession } from "./DroidRewind.ts";

const turn = (
  ordinal: number,
  nativeAcceptance: OrchestrationV2ProviderTurn["nativeAcceptance"] = "accepted",
): OrchestrationV2ProviderTurn => ({
  id: ProviderTurnId.make(`turn-${ordinal}`),
  providerThreadId: ProviderThreadId.make("droid-thread"),
  nodeId: NodeId.make(`node-${ordinal}`),
  runAttemptId: null,
  nativeTurnRef: null,
  ordinal,
  status: "completed",
  nativeAcceptance,
  startedAt: null,
  completedAt: null,
});

const droidWith = (texts: ReadonlyArray<string>, rewound: Array<string>) =>
  (async () => ({
    messages: texts.map((text, index) => ({
      id: `droid-${index + 1}`,
      role: "user",
      content: [{ type: "text", text }],
    })),
    close: async () => undefined,
    listSkills: async () => ({ skills: [] }),
    setSkillDisabled: async () => undefined,
    rewindBefore: async (messageId: string) => {
      rewound.push(messageId);
      return { newSessionId: "rewound" };
    },
  })) satisfies DroidControlClientFactory;

const rewind = (
  texts: ReadonlyArray<string>,
  turns: {
    readonly kept: ReadonlyArray<OrchestrationV2ProviderTurn>;
    readonly removed: ReadonlyArray<OrchestrationV2ProviderTurn>;
    readonly keptText: string;
  },
  rewound: Array<string>,
) =>
  rewindDroidSession(
    { binaryPath: "droid", environment: {} },
    {
      sessionId: "source",
      cwd: "/work",
      keptTurns: turns.kept,
      removedTurns: turns.removed,
      keptMessageText: turns.keptText,
    },
    droidWith(texts, rewound),
  );

it.effect("refuses, rewinding nothing, when Droid's history no longer matches", () =>
  Effect.gen(function* () {
    const rewound: Array<string> = [];
    // After compaction Droid's first prompt is a summary, not the kept message.
    const compacted = yield* rewind(
      ["Summary of the earlier work", "Second"],
      { kept: [turn(1)], removed: [turn(2)], keptText: "First" },
      rewound,
    ).pipe(Effect.flip);
    // A send whose delivery is unknown makes repeated text ambiguous.
    const uncertain = yield* rewind(
      ["Setup", "Continue", "Continue"],
      { kept: [turn(1), turn(2, "unknown"), turn(3)], removed: [turn(4)], keptText: "Continue" },
      rewound,
    ).pipe(Effect.flip);
    NodeAssert.match(compacted.detail, /no longer matches/u);
    NodeAssert.match(uncertain.detail, /no longer matches/u);
    NodeAssert.deepEqual(rewound, []);
  }),
);

it.effect("keeps the session when the removed turns never reached Droid", () =>
  Effect.gen(function* () {
    const rewound: Array<string> = [];
    const kept = yield* rewind(
      ["First"],
      { kept: [turn(1)], removed: [turn(2, "pending")], keptText: "First" },
      rewound,
    );
    NodeAssert.equal(kept, "source");
    NodeAssert.deepEqual(rewound, []);
  }),
);
