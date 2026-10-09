import { describe, expect, it } from "vite-plus/test";

import {
  TEMPLATE_PAGE_LIMIT,
  applyTemplateAction,
  defaultTemplateLayout,
  hideTemplate,
  moveTemplateToMore,
  moveTemplateToPage,
  reorderTemplates,
  resolveTemplateLayout,
  sameTemplateLayout,
  templateActions,
} from "./documentTemplateLayout";

const templates = ["blank", "article", "thesis", "problem-set", "lab-report", "letter", "cv"];
const initial = defaultTemplateLayout(templates);

describe("template layout", () => {
  it("starts with four on the page and the rest behind More", () => {
    expect(initial).toEqual({
      page: ["blank", "article", "thesis", "problem-set"],
      more: ["lab-report", "letter", "cv"],
      hidden: [],
    });
    expect(resolveTemplateLayout(null, templates)).toEqual(initial);
  });

  it("keeps a stored layout whole as templates come and go", () => {
    const stored = { page: ["cv", "gone", "cv", "blank"], more: ["letter"], hidden: ["thesis"] };
    expect(resolveTemplateLayout(stored, [...templates, "user:notes"])).toEqual({
      page: ["cv", "blank"],
      more: ["letter", "article", "problem-set", "lab-report", "user:notes"],
      hidden: ["thesis"],
    });
  });

  it("moves to the page at its end, and a full page makes room", () => {
    const one = moveTemplateToPage(initial, "cv");
    expect(one.page).toEqual(["blank", "article", "thesis", "problem-set", "cv"]);
    expect(one.page).toHaveLength(TEMPLATE_PAGE_LIMIT);
    const full = moveTemplateToPage(one, "letter");
    expect(full.page).toEqual(["blank", "article", "thesis", "problem-set", "letter"]);
    expect(full.more).toEqual(["cv", "lab-report"]);
  });

  it("moves to the top of More, hides, and reorders within a list", () => {
    const moved = moveTemplateToMore(initial, "thesis");
    expect(moved.page).toEqual(["blank", "article", "problem-set"]);
    expect(moved.more[0]).toBe("thesis");
    const hidden = hideTemplate(moved, "letter");
    expect(hidden.more).not.toContain("letter");
    expect(hidden.hidden).toEqual(["letter"]);
    expect(reorderTemplates(initial, "page", "problem-set", "blank").page).toEqual([
      "problem-set",
      "blank",
      "article",
      "thesis",
    ]);
    expect(reorderTemplates(initial, "more", "cv", "lab-report").more).toEqual([
      "cv",
      "lab-report",
      "letter",
    ]);
    expect(sameTemplateLayout(initial, defaultTemplateLayout(templates))).toBe(true);
    expect(sameTemplateLayout(initial, moved)).toBe(false);
  });

  it("offers each template the moves that fit where it is", () => {
    expect(templateActions(initial, "article", "blank").map((item) => item.label)).toEqual([
      "Set as default",
      "Move to More",
      "Hide",
    ]);
    expect(templateActions(initial, "cv", "cv")).toEqual([
      { id: "default", label: "Default", disabled: true },
      { id: "page", label: "Move to page" },
      { id: "hide", label: "Hide" },
    ]);
    expect(applyTemplateAction(initial, "page", "cv").page.at(-1)).toBe("cv");
    expect(applyTemplateAction(initial, "more", "article").more[0]).toBe("article");
    expect(applyTemplateAction(initial, "hide", "letter").hidden).toEqual(["letter"]);
  });
});
