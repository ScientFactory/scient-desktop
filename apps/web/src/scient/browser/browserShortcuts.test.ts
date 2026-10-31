import { beforeEach, describe, expect, it } from "vite-plus/test";

import { canAddShortcut, useBrowserShortcuts, visibleShortcuts } from "./browserShortcuts";

const names = () => visibleShortcuts(useBrowserShortcuts.getState()).map(({ name }) => name);
const visit = (url: string, times = 1, at = 1_000) => {
  for (let index = 0; index < times; index += 1) {
    useBrowserShortcuts.getState().recordVisit(url, at);
  }
};

beforeEach(() => {
  useBrowserShortcuts.setState({ added: [], hidden: [], visits: {} });
});

describe("visibleShortcuts", () => {
  it("starts with the scientific sites and Google's apps", () => {
    expect(names()).toEqual(["Scholar", "PubMed", "arXiv", "Overleaf", "Drive", "Calendar"]);
  });

  it("puts added sites first, then the most opened, then the starting set", () => {
    visit("https://www.nature.com/articles/a", 2);
    visit("https://github.com/owner/repo", 3);
    useBrowserShortcuts.getState().add("wikipedia.org");
    expect(names().slice(0, 4)).toEqual(["wikipedia.org", "github.com", "nature.com", "Scholar"]);
  });

  it("suggests a site only after it has been opened twice", () => {
    visit("https://www.nature.com/");
    expect(names()).not.toContain("nature.com");
    visit("https://nature.com/neuro");
    expect(names()).toContain("nature.com");
  });

  it("counts a site once however its pages are reached and opens the site's start", () => {
    visit("https://www.nature.com/a", 2);
    visit("https://www.nature.com/b", 2);
    const shortcuts = visibleShortcuts(useBrowserShortcuts.getState());
    expect(shortcuts.filter(({ key }) => key === "nature.com")).toEqual([
      { key: "nature.com", name: "nature.com", url: "https://www.nature.com/" },
    ]);
  });

  it("names a known site and doesn't repeat it from the starting set", () => {
    visit("https://drive.google.com/drive/my-drive", 5);
    expect(names().filter((name) => name === "Drive")).toHaveLength(1);
    expect(names()[0]).toBe("Drive");
  });

  it("leaves Google and Gmail to the row above", () => {
    visit("https://www.google.com/search?q=a", 5);
    visit("https://mail.google.com/mail/u/0/#inbox", 5);
    expect(names()).not.toContain("google.com");
    expect(names()).not.toContain("mail.google.com");
    expect(names()).not.toContain("Gmail");
  });

  it("keeps a removed site away until the user adds it back", () => {
    const { add, remove } = useBrowserShortcuts.getState();
    const scholar = visibleShortcuts(useBrowserShortcuts.getState())[0]!;
    remove(scholar);
    visit("https://scholar.google.com/", 5);
    expect(names()).not.toContain("Scholar");
    add("scholar.google.com");
    expect(names()).toContain("Scholar");
  });

  it("removes a site the user added without bringing it back", () => {
    const { add, remove } = useBrowserShortcuts.getState();
    add("https://example.org/page");
    const added = visibleShortcuts(useBrowserShortcuts.getState())[0]!;
    remove(added);
    expect(useBrowserShortcuts.getState().added).toEqual([]);
    expect(names()).not.toContain("example.org");
  });

  it("leaves a place for Add until eight sites are the user's own", () => {
    const { add } = useBrowserShortcuts.getState();
    visit("https://a.example/", 2);
    visit("https://b.example/", 2);
    expect(names()).toHaveLength(7);
    for (let index = 0; index < 8; index += 1) add(`https://site${index}.example/`);
    expect(canAddShortcut(useBrowserShortcuts.getState().added)).toBe(false);
    expect(names()).toHaveLength(8);
  });
});

describe("recordVisit", () => {
  it.each([
    "http://localhost:5173/",
    "http://127.0.0.1:3000/",
    "http://0.0.0.0:8000/",
    "https://accounts.google.com/signin",
    "not a url",
  ])("ignores %s", (url) => {
    visit(url);
    expect(useBrowserShortcuts.getState().visits).toEqual({});
  });

  it("forgets the sites not opened for longest past its limit", () => {
    for (let index = 0; index < 101; index += 1) visit(`https://site${index}.example/`, 1, index);
    const { visits } = useBrowserShortcuts.getState();
    expect(Object.keys(visits)).toHaveLength(100);
    expect(visits["site0.example"]).toBeUndefined();
  });
});

describe("add", () => {
  it("keeps an address once and ignores text that isn't one", () => {
    const { add } = useBrowserShortcuts.getState();
    add("example.org");
    add("https://example.org/");
    add("not a url");
    add("word");
    add("https://not%20a%20url/");
    expect(useBrowserShortcuts.getState().added).toEqual(["https://example.org/"]);
  });
});
