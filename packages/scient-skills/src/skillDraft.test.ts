import { describe, expect, it } from "vite-plus/test";

import { prepareSkillDocument, skillNameFrom } from "./skillDraft.ts";

const skill = (header: string, body = "Do the thing carefully.") =>
  `---\n${header}\n---\n\n${body}\n`;

describe("skillNameFrom", () => {
  it("makes lowercase hyphenated names from file names and titles", () => {
    expect(skillNameFrom("Lab Notes.md")).toBe("lab-notes");
    expect(skillNameFrom("  Écrire un Résumé!! ")).toBe("ecrire-un-resume");
    expect(skillNameFrom("my_skill.zip")).toBe("my-skill");
    expect(skillNameFrom("???")).toBeUndefined();
  });
});

describe("prepareSkillDocument", () => {
  it("keeps a ready skill as it is", () => {
    const contents = skill("name: lab-notes\ndescription: Keep lab notes.");
    expect(prepareSkillDocument(contents, "lab-notes")).toEqual({
      status: "ready",
      name: "lab-notes",
      description: "Keep lab notes.",
      contents,
      notes: [],
    });
  });

  it("fixes a missing or unusable name, keeping the rest of the header", () => {
    const missing = prepareSkillDocument(
      skill("# who wrote it\ndescription: Keep lab notes.\nlicense: MIT"),
      "Lab Notes.md",
    );
    expect(missing).toMatchObject({ status: "ready", name: "lab-notes" });
    expect(missing.status === "ready" && missing.contents).toContain("license: MIT");
    expect(missing.status === "ready" && missing.contents).toContain("# who wrote it");
    expect(missing.status === "ready" && missing.notes).toEqual([
      "Named “lab-notes” after its file.",
    ]);

    const loose = prepareSkillDocument(skill("name: Lab Notes\ndescription: Keep lab notes."), "x");
    expect(loose).toMatchObject({
      status: "ready",
      name: "lab-notes",
      notes: ["Renamed to “lab-notes” to fit skill names."],
    });
  });

  it("reads past a byte-order mark", () => {
    expect(
      prepareSkillDocument(String.fromCharCode(0xfeff) + skill("name: a\ndescription: b"), "a"),
    ).toMatchObject({
      status: "ready",
      name: "a",
    });
  });

  it("leaves to an agent what needs judgment", () => {
    expect(prepareSkillDocument("Some notes about PCR.", "pcr-notes.md")).toEqual({
      status: "needs-agent",
      reason: "It has no skill header with a name and a description.",
      name: "pcr-notes",
    });
    expect(prepareSkillDocument(skill("name: pcr"), "pcr")).toMatchObject({
      status: "needs-agent",
      reason: "It has no description, which agents use to decide when to use it.",
    });
    expect(prepareSkillDocument(skill("name: pcr\ndescription: d", ""), "pcr")).toMatchObject({
      status: "needs-agent",
      reason: "It has a header but no instructions.",
    });
    expect(prepareSkillDocument("---\n: [\n---\nbody", "x")).toMatchObject({
      status: "needs-agent",
      reason: "Its header could not be read.",
    });
  });
});
