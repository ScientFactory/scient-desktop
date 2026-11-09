import { ThreadSectionId, type ThreadSection } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { sectionPickerList } from "./picker";

const sections: ThreadSection[] = [
  "Voice",
  "Compute",
  "Résumé",
  "Overleaf",
  "Design",
  "Mobile",
].map((name, order) => ({ id: ThreadSectionId.make(name.toLowerCase()), name, order }));
const names = (entries: ReadonlyArray<{ readonly name: string }>) =>
  entries.map((entry) => entry.name);

describe("sectionPickerList", () => {
  it("lists General, then the selected project's sections by name", () => {
    const list = sectionPickerList({
      sections,
      inScope: new Set(["voice", "compute"]),
      lastActivity: new Map([["voice", 2]]),
      query: "",
    });
    // Too few sections for a Recent group; other projects' sections stay hidden.
    expect(list).toEqual({
      recent: [],
      sections: [
        { id: "__general__", name: "General" },
        { id: "compute", name: "Compute" },
        { id: "voice", name: "Voice" },
      ],
      otherProjects: [],
      createName: null,
    });
  });

  it("leads a long list with the most recently active sections", () => {
    const list = sectionPickerList({
      sections,
      inScope: null,
      lastActivity: new Map([
        ["design", 5],
        ["voice", 9],
        ["mobile", 1],
      ]),
      query: "",
    });
    expect(names(list.recent)).toEqual(["Voice", "Design", "Mobile"]);
    expect(names(list.sections)).toEqual(["General", "Compute", "Overleaf", "Résumé"]);
  });

  it("searches across projects, ignoring case and accents, and offers the typed name", () => {
    const list = sectionPickerList({
      sections,
      inScope: new Set(["mobile", "overleaf"]),
      lastActivity: new Map(),
      query: "  e  ",
    });
    expect(names(list.sections)).toEqual(["General", "Mobile", "Overleaf"]);
    expect(names(list.otherProjects)).toEqual(["Compute", "Design", "Résumé", "Voice"]);
    expect(list.recent).toEqual([]);
    expect(list.createName).toBe("E");
  });

  it("offers no new section when one, in any project, already has the name", () => {
    const inScope = new Set(["voice"]);
    const createName = (query: string) =>
      sectionPickerList({ sections, inScope, lastActivity: new Map(), query }).createName;
    expect(createName("resume")).toBeNull();
    expect(createName("general")).toBeNull();
    expect(createName("research notes")).toBe("Research notes");
  });
});
