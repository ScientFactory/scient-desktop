import { DEFAULT_SERVER_SETTINGS, ThreadSectionId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyThreadSectionsPrecondition } from "./settingsPrecondition.ts";

const alpha = { id: ThreadSectionId.make("alpha"), name: "Alpha", order: 0 };
const beta = { id: ThreadSectionId.make("beta"), name: "Beta", order: 1 };
const current = {
  ...DEFAULT_SERVER_SETTINGS,
  threadSections: [alpha],
  threadSectionsGeneralIndex: 0,
};

describe("applyThreadSectionsPrecondition", () => {
  it("applies section keys while the stored catalog matches the expected one", () => {
    expect(
      applyThreadSectionsPrecondition(current, {
        threadSections: [alpha, beta],
        threadSectionsGeneralIndex: 0,
        threadSectionsExpected: { threadSections: [alpha], threadSectionsGeneralIndex: 0 },
      }),
    ).toEqual({ threadSections: [alpha, beta], threadSectionsGeneralIndex: 0 });
  });

  it("drops only the section keys when another client wrote first", () => {
    expect(
      applyThreadSectionsPrecondition(current, {
        threadSections: [beta],
        threadSectionsGeneralIndex: 1,
        threadSectionsDeleteEmptyAfterDays: 7,
        threadSectionsExpected: { threadSections: [], threadSectionsGeneralIndex: 0 },
      }),
    ).toEqual({ threadSectionsDeleteEmptyAfterDays: 7 });
    // A moved General also counts as a different catalog.
    expect(
      applyThreadSectionsPrecondition(current, {
        threadSections: [beta],
        threadSectionsExpected: { threadSections: [alpha], threadSectionsGeneralIndex: 1 },
      }),
    ).toEqual({});
  });

  it("passes patches without a precondition through unchanged", () => {
    expect(applyThreadSectionsPrecondition(current, { threadSections: [beta] })).toEqual({
      threadSections: [beta],
    });
  });

  it("keeps the projects a stored section was created for, whoever writes", () => {
    const a = { environmentId: "local", projectId: "a" };
    const b = { environmentId: "local", projectId: "b" };
    const stored = { ...current, threadSections: [{ ...alpha, createdInProjects: [a] }] };
    // A client that predates the field, or whose copy trails, writes without it.
    expect(
      applyThreadSectionsPrecondition(stored, {
        threadSections: [{ ...alpha, name: "Renamed" }, beta],
        threadSectionsExpected: { threadSections: [alpha], threadSectionsGeneralIndex: 0 },
      }).threadSections,
    ).toEqual([{ ...alpha, name: "Renamed", createdInProjects: [a] }, beta]);
    // New refs are added after the stored ones, without duplicates.
    expect(
      applyThreadSectionsPrecondition(stored, {
        threadSections: [{ ...alpha, createdInProjects: [b, a] }],
      }).threadSections,
    ).toEqual([{ ...alpha, createdInProjects: [a, b] }]);
  });
});
