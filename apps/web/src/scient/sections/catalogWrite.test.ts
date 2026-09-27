import {
  threadSectionCatalogsEqual,
  ThreadSectionId,
  type ThreadSection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { type LiveLayout, writeCatalog } from "./catalogWrite";
import { catalogWithCreatedSection } from "./logic";

/** A primary server applying the section precondition, as serverSettings does. */
function makeServer(initial: readonly ThreadSection[] = []) {
  let stored: LiveLayout = { sections: initial, generalIndex: 0 };
  return {
    read: () => stored,
    send: async (patch: Parameters<Parameters<typeof writeCatalog>[0]["send"]>[0]) => {
      const expected = patch.threadSectionsExpected;
      if (
        expected.threadSectionsGeneralIndex === stored.generalIndex &&
        threadSectionCatalogsEqual(expected.threadSections, stored.sections)
      ) {
        stored = { sections: patch.threadSections, generalIndex: patch.threadSectionsGeneralIndex };
      }
      return stored;
    },
  };
}

const create = (name: string) => (layout: LiveLayout) => ({
  layout: {
    catalog: catalogWithCreatedSection(layout.sections, name, ThreadSectionId.make(name)).catalog,
    generalIndex: layout.generalIndex,
  },
  result: name,
});

describe("writeCatalog", () => {
  it("keeps both of two concurrent edits based on the same catalog", async () => {
    const server = makeServer();
    const stale = server.read();
    // Two clients both start from the empty catalog.
    const first = await writeCatalog({ stored: stale, edit: create("Alpha"), send: server.send });
    const second = await writeCatalog({ stored: stale, edit: create("Beta"), send: server.send });
    expect(first.ok && second.ok).toBe(true);
    expect(server.read().sections.map((section) => section.name)).toEqual(["Alpha", "Beta"]);
  });

  it("gives up after repeated conflicts rather than overwriting", async () => {
    const server = makeServer();
    let calls = 0;
    const result = await writeCatalog({
      stored: server.read(),
      edit: create("Alpha"),
      // Another client always wins the race.
      send: async () => {
        calls += 1;
        return {
          sections: [{ id: ThreadSectionId.make(`other-${calls}`), name: "Other", order: 0 }],
          generalIndex: 0,
        };
      },
    });
    expect(result).toEqual({ ok: false, result: null });
    expect(calls).toBe(3);
  });

  it("skips the write when the edit changes nothing, and reports failures", async () => {
    const server = makeServer();
    expect(
      await writeCatalog({
        stored: server.read(),
        edit: () => ({ layout: null, result: "unchanged" }),
        send: () => Promise.reject(new Error("must not send")),
      }),
    ).toEqual({ ok: true, result: "unchanged" });
    expect(
      await writeCatalog({ stored: server.read(), edit: create("Alpha"), send: async () => null }),
    ).toEqual({ ok: false, result: null });
  });
});
