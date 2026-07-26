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

  it("uses truthful generic copy without linking when the source is unavailable", () => {
    expect(
      resolveForkProvenance(
        {
          id: FORK_ID,
          forkSourceThreadId: SOURCE_ID,
          forkSourceMessageId: null,
        },
        undefined,
      ),
    ).toEqual({
      sourceThreadId: SOURCE_ID,
      sourceMessageId: null,
      sourceTitle: null,
      sourceAvailable: false,
    });
  });

  it("does not mistake the automatic fork title family for the unavailable source title", () => {
    expect(
      resolveForkProvenance(
        {
          id: FORK_ID,
          forkSourceThreadId: SOURCE_ID,
          forkSourceMessageId: null,
          // A child of "Experiment (2)" can carry only this family base.
          forkTitleBase: "Experiment",
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
