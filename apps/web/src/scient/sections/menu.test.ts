import { ThreadSectionId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { buildSectionSubmenu, parseSectionMenuAction } from "./menu";

const RESEARCH = { id: ThreadSectionId.make("research"), name: "Research", order: 0 };
const PERMA = { id: ThreadSectionId.make("perma"), name: "Perma", order: 1 };

describe("buildSectionSubmenu", () => {
  it("lists General in layout order and checks the shared choice", () => {
    const menu = buildSectionSubmenu({
      sections: [RESEARCH, PERMA],
      generalIndex: 1,
      currentSectionIds: [null],
    });
    expect(menu.children?.map((item) => [item.label, item.checked])).toEqual([
      ["Research", false],
      ["General", true],
      ["Perma", false],
      ["New section…", undefined],
    ]);
  });

  it("checks nothing for a mixed selection and labels the bulk move", () => {
    const menu = buildSectionSubmenu({
      sections: [RESEARCH],
      generalIndex: 0,
      currentSectionIds: ["research", null],
    });
    expect(menu.label).toBe("Move to section (2)");
    expect(menu.children?.some((item) => item.checked === true)).toBe(false);
  });

  it("parses General as removing the section", () => {
    expect(parseSectionMenuAction("section:remove")).toEqual({ kind: "remove" });
    expect(parseSectionMenuAction("section:set:perma")).toEqual({
      kind: "set",
      sectionId: "perma",
    });
  });
});
