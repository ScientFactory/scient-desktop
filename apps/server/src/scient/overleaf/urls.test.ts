import { describe, expect, it } from "vite-plus/test";

import { normalizeRelativeFolder, parseOverleafProjectInput } from "./urls.ts";

describe("parseOverleafProjectInput", () => {
  it("normalizes Cloud project and official Git URLs", () => {
    expect(parseOverleafProjectInput("https://www.overleaf.com/project/abc_123")).toEqual({
      host: "git.overleaf.com",
      projectId: "abc_123",
      projectUrl: "https://www.overleaf.com/project/abc_123",
      gitUrl: "https://git@git.overleaf.com/abc_123",
      kind: "cloud",
    });
    expect(parseOverleafProjectInput("https://git@git.overleaf.com/abc_123").gitUrl).toBe(
      "https://git@git.overleaf.com/abc_123",
    );
    expect(parseOverleafProjectInput("https://git.overleaf.com/git/abc_123").gitUrl).toBe(
      "https://git@git.overleaf.com/abc_123",
    );
  });

  it("parses a pasted clone command as text without accepting shell syntax", () => {
    expect(
      parseOverleafProjectInput("git clone https://git@git.overleaf.com/paper-id paper"),
    ).toMatchObject({ projectId: "paper-id" });
    expect(() =>
      parseOverleafProjectInput("git clone --depth 1 https://git@git.overleaf.com/paper-id"),
    ).toThrow(/options/u);
    expect(() =>
      parseOverleafProjectInput("git clone https://git@git.overleaf.com/paper-id ; calc"),
    ).toThrow(/shell syntax/u);
    expect(() =>
      parseOverleafProjectInput("git clone https://git@git.overleaf.com/paper-id paper;calc"),
    ).toThrow(/shell syntax/u);
  });

  it("supports Server Pro hosts and ports while stripping no host identity", () => {
    expect(parseOverleafProjectInput("https://papers.example.edu:8443/project/xyz")).toEqual({
      host: "papers.example.edu:8443",
      projectId: "xyz",
      projectUrl: "https://papers.example.edu:8443/project/xyz",
      gitUrl: "https://git@papers.example.edu:8443/git/xyz",
      kind: "server-pro",
    });
  });

  it("rejects secrets, non-HTTPS URLs, fragments, and unrelated paths", () => {
    expect(() => parseOverleafProjectInput("https://user:secret@git.overleaf.com/id")).toThrow(
      /credentials/u,
    );
    expect(() => parseOverleafProjectInput("http://www.overleaf.com/project/id")).toThrow(/HTTPS/u);
    expect(() => parseOverleafProjectInput("https://www.overleaf.com/project/id#history")).toThrow(
      /fragments/u,
    );
    expect(() => parseOverleafProjectInput("https://www.overleaf.com/learn/id")).toThrow(
      /supported/u,
    );
  });
});

describe("normalizeRelativeFolder", () => {
  it("accepts root and nested mappings", () => {
    expect(normalizeRelativeFolder(".")).toBe("");
    expect(normalizeRelativeFolder("")).toBe("");
    expect(normalizeRelativeFolder("papers\\article/")).toBe("papers/article");
  });

  it("rejects path escape and .git components", () => {
    expect(() => normalizeRelativeFolder("../paper")).toThrow(/inside/u);
    expect(() => normalizeRelativeFolder("paper/.git/worktrees/x")).toThrow(/inside/u);
    expect(() => normalizeRelativeFolder("paper//chapter")).toThrow(/inside/u);
    expect(() => normalizeRelativeFolder("papers/CON")).toThrow(/reserved/u);
  });
});
