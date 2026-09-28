import { MarkdownPersistenceCoordinator } from "@scientfactory/scient-markdown";
import { describe, expect, it, vi } from "vite-plus/test";

import { savedMarkdownRevision } from "./markdownSavedRevision";

const revision = `sha256:${"a".repeat(64)}`;
const newerRevision = `sha256:${"b".repeat(64)}`;

function persistence(initialRevision = revision) {
  const coordinator = new MarkdownPersistenceCoordinator({
    source: "Saved",
    revision: initialRevision,
    write: async () => ({ revision: newerRevision }),
    read: async () => ({ source: "Saved", revision: initialRevision }),
    classifyFailure: () => "terminal",
  });
  return {
    coordinator,
    flushNow: vi.fn(() => coordinator.flushNow()),
    getSnapshot: coordinator.getSnapshot,
  };
}

describe("savedMarkdownRevision", () => {
  it("flushes edits and passes the confirmed revision to Word export", async () => {
    const lease = persistence();
    lease.coordinator.change("Edited", lease.getSnapshot().editVersion);
    expect(await savedMarkdownRevision(lease)).toBe(newerRevision);
    expect(lease.flushNow).toHaveBeenCalledOnce();
  });

  it("rejects an unresolved save, conflict, or unknown revision", async () => {
    const lease = persistence();
    expect(
      await savedMarkdownRevision({
        flushNow: async () => false,
        getSnapshot: lease.getSnapshot,
      }),
    ).toBeNull();
    expect(
      await savedMarkdownRevision({
        flushNow: async () => true,
        getSnapshot: () => ({ ...lease.getSnapshot(), pending: true }),
      }),
    ).toBeNull();
    expect(
      await savedMarkdownRevision({
        flushNow: async () => true,
        getSnapshot: () => ({
          ...lease.getSnapshot(),
          conflict: { externalSource: "External", externalRevision: newerRevision },
        }),
      }),
    ).toBeNull();
    expect(await savedMarkdownRevision(persistence("unknown"))).toBeNull();
  });
});
