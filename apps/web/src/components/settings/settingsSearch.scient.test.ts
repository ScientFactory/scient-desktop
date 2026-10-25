import { describe, expect, it } from "vite-plus/test";

import {
  searchableSetting,
  searchSettings,
  SETTINGS_SEARCH_ITEMS,
  SETTINGS_SECTION_LABELS,
} from "./settingsSearch";

describe("Scient settings search", () => {
  // regression: dd3895663a fix(cli): install and advertise the Scient command
  it("finds the canonical Scient command and its former t3 name", () => {
    expect(searchableSetting("cli-command").title).toBe("scient command");
    const items = SETTINGS_SEARCH_ITEMS.filter((item) => item.id === "cli-command").map((item) => ({
      ...item,
      desktopOnly: false,
    }));
    expect(searchSettings("scient command", items).map((item) => item.id)).toEqual(["cli-command"]);
    expect(searchSettings("t3", items).map((item) => item.id)).toEqual(["cli-command"]);
  });

  // regression: 352cbecb13 fix(privacy): withhold unapproved policy links
  it("does not offer the withheld privacy-policy link", () => {
    expect(SETTINGS_SEARCH_ITEMS.map((item) => item.id)).not.toContain("privacy-policy");
    expect(searchSettings("privacy policy")).toEqual([]);
    expect(searchSettings("diagnostics")[0]).toMatchObject({ id: "diagnostics" });
  });

  it("keeps the safety-held telemetry export action out of settings search", () => {
    expect(searchSettings("OpenTelemetry export")).toEqual([]);
    expect(SETTINGS_SEARCH_ITEMS.map((item) => item.id)).not.toContain("telemetry-export");
  });
});

describe("searchSettings ranking", () => {
  // regression: 71d12d8c4a feat(web): make keybindings searchable from settings search (#12175)
  // Sole guard of the secondary-item ordering: upstream dropped this row in its snap, and no
  // other test fails when keybinding commands outrank ordinary settings.
  it("ranks keybinding commands after other settings", () => {
    const ids = searchSettings("model").map((item) => item.id);
    const commandIndex = ids.indexOf("keybinding-modelPicker.toggle");
    expect(commandIndex).toBeGreaterThan(-1);
    for (const id of ["custom-models", "default-model", "text-generation-model"]) {
      expect(ids.indexOf(id)).toBeGreaterThan(-1);
      expect(commandIndex).toBeGreaterThan(ids.indexOf(id));
    }
  });
});

describe("settings sidebar order", () => {
  it("shows Shortcuts without changing the existing route", () => {
    expect(SETTINGS_SECTION_LABELS["/settings/keybindings"]).toBe("Shortcuts");
    expect(searchSettings("keybindings").some((item) => item.id === "keybindings")).toBe(true);
  });
});

// Restored after a mutation audit (Codex review r4): each case is the only guard of where
// settings search sends its query.
describe("Scient settings search routing", () => {
  it.each(["font weight", "text thickness"])("finds interface typography by %s", (query) => {
    expect(searchSettings(query)[0]).toMatchObject({
      id: "interface-font",
      to: "/settings/appearance",
    });
  });
  it("routes Scientific Computing to its dedicated settings page", () => {
    expect(searchSettings("scientific computing")[0]).toMatchObject({
      id: "scientific-computing",
      to: "/settings/scientific-computing",
    });
  });
  it("finds Word export by the words people look for it with", () => {
    for (const query of ["word export", "pandoc", "docx", "export"]) {
      expect(searchSettings(query)[0], query).toMatchObject({
        id: "word-export",
        to: "/settings/documents",
      });
    }
    expect(searchSettings("word wrap")[0]?.id).toBe("word-wrap");
  });
  it("finds the Documents page by format, engine, and template", () => {
    for (const [query, id] of [
      ["documents", "documents"],
      ["latex", "latex-installation"],
      ["tinytex", "latex-installation"],
      ["template", "new-document-template"],
    ] as const) {
      expect(searchSettings(query)[0], query).toMatchObject({ id, to: "/settings/documents" });
    }
    // Markdown shortcuts lead; the Documents page still answers.
    expect(searchSettings("markdown").some((item) => item.id === "documents")).toBe(true);
  });
  it("routes compiler status into technical details and installation into actionable tools", () => {
    for (const query of [
      "compiler status",
      "available compilers",
      "compiler versions",
      "executable paths",
    ]) {
      expect(searchSettings(query)[0], query).toMatchObject({
        id: "latex-compilers",
        to: "/settings/documents",
        targetId: "latex-compilers",
      });
    }
    for (const query of ["install latex", "additional compilers", "tinytex"]) {
      expect(searchSettings(query)[0], query).toMatchObject({
        id: "latex-installation",
        to: "/settings/documents",
        targetId: "latex-installation",
      });
    }
    expect(searchSettings("default latex compiler")[0]).toMatchObject({
      id: "new-document-compiler",
      targetId: "new-document-compiler",
    });
  });
  it("routes compilation modes to the Documents picker", () => {
    for (const query of ["autocompile", "auto-compile", "pdf compilation"]) {
      expect(searchSettings(query)[0], query).toMatchObject({
        id: "latex-compilation",
        to: "/settings/documents",
        targetId: "latex-compilation",
      });
    }
  });
});
