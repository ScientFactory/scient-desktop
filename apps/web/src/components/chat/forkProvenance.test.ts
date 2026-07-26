// FILE: forkProvenance.test.ts
// Purpose: Prove fork provenance stays truthful with live, restored, and deleted sources.
// Layer: Web chat presentation helper tests

import { MessageId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { resolveForkProvenance } from "./forkProvenance";

const FORK_ID = ThreadId.makeUnsafe("fork-thread");
const SOURCE_ID = ThreadId.makeUnsafe("source-thread");

describe("resolveForkProvenance", () => {
  it("uses the live source title and records a message-boundary fork", () => {
    expect(
      resolveForkProvenance(
        {
          id: FORK_ID,
          forkSourceThreadId: SOURCE_ID,
          forkSourceMessageId: MessageId.makeUnsafe("source-message"),
          forkTitleBase: "Title when forked",
        },
        { id: SOURCE_ID, title: "Renamed source" },
      ),
    ).toEqual({
      sourceThreadId: SOURCE_ID,
      sourceMessageId: "source-message",
      sourceTitle: "Renamed source",
      sourceAvailable: true,
    });
  });

  it("uses persisted fork metadata without linking when the source is unavailable", () => {
    expect(
      resolveForkProvenance(
        {
          id: FORK_ID,
          forkSourceThreadId: SOURCE_ID,
          forkSourceMessageId: null,
          forkTitleBase: "Deleted source",
        },
        undefined,
      ),
    ).toEqual({
      sourceThreadId: SOURCE_ID,
      sourceMessageId: null,
      sourceTitle: "Deleted source",
      sourceAvailable: false,
    });
  });

  it("falls back to generic truthful copy when old restored metadata has no title", () => {
    expect(
      resolveForkProvenance(
        {
          id: FORK_ID,
          forkSourceThreadId: SOURCE_ID,
          forkSourceMessageId: null,
          forkTitleBase: "  ",
        },
        null,
      ),
    ).toMatchObject({ sourceTitle: null, sourceAvailable: false });
  });

  it("does not label ordinary threads or Side conversations as forks", () => {
    expect(resolveForkProvenance({ id: FORK_ID }, null)).toBeNull();
    expect(
      resolveForkProvenance(
        {
          id: FORK_ID,
          forkSourceThreadId: SOURCE_ID,
          sidechatSourceThreadId: SOURCE_ID,
        },
        { id: SOURCE_ID, title: "Source" },
      ),
    ).toBeNull();
  });
});
