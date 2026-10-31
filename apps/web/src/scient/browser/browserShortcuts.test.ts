import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  canAddShortcut,
  GOOGLE_APPS,
  universityMoodle,
  useBrowserShortcuts,
  visibleShortcuts,
} from "./browserShortcuts";

const names = () => visibleShortcuts(useBrowserShortcuts.getState()).map(({ name }) => name);
const visit = (url: string, times = 1, at = 1_000) => {
  for (let index = 0; index < times; index += 1) {
    useBrowserShortcuts.getState().recordVisit(url, at);
  }
};

beforeEach(() => {
  useBrowserShortcuts.setState({ added: [], names: {}, hidden: [], visits: {} });
});

describe("visibleShortcuts", () => {
  it("starts with the scientific sites and Google's apps", () => {
    expect(names()).toEqual(["Scholar", "PubMed", "arXiv", "Overleaf", "Drive", "Calendar"]);
  });

  it("puts added sites first, then the most opened, then the starting set", () => {
    visit("https://www.nature.com/articles/a", 2);
    visit("https://github.com/owner/repo", 3);
    useBrowserShortcuts.getState().save(null, "wikipedia.org", "");
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
    visit("https://calendar.google.com/calendar/u/0/r", 5);
    expect(names().filter((name) => name === "Calendar")).toHaveLength(1);
    expect(names()[0]).toBe("Calendar");
  });

  it("names and pictures a Google app reached from anywhere", () => {
    visit("https://www.youtube.com/watch?v=abc", 2);
    expect(visibleShortcuts(useBrowserShortcuts.getState())[0]).toMatchObject({
      key: "youtube.com",
      name: "YouTube",
      icon: expect.stringMatching(/^data:image\//),
    });
  });

  it("names a site that several apps share after the first of them", () => {
    visit("https://docs.google.com/spreadsheets/d/abc", 2);
    expect(names()[0]).toBe("Docs");
  });

  it("doesn't turn searches or Gmail into shortcuts", () => {
    visit("https://www.google.com/search?q=a", 5);
    visit("https://mail.google.com/mail/u/0/#inbox", 5);
    expect(names()).not.toContain("Google");
    expect(names()).not.toContain("Gmail");
  });

  it("keeps Google as a shortcut when the user adds it", () => {
    useBrowserShortcuts.getState().save(null, "google.com", "");
    expect(names()[0]).toBe("Google");
  });

  it("keeps a removed site away until the user adds it back", () => {
    const { save, remove } = useBrowserShortcuts.getState();
    const scholar = visibleShortcuts(useBrowserShortcuts.getState())[0]!;
    remove(scholar);
    visit("https://scholar.google.com/", 5);
    expect(names()).not.toContain("Scholar");
    save(null, "scholar.google.com", "");
    expect(names()).toContain("Scholar");
  });

  it("removes a site the user added without bringing it back", () => {
    const { save, remove } = useBrowserShortcuts.getState();
    save(null, "https://example.org/page", "Lab page");
    const added = visibleShortcuts(useBrowserShortcuts.getState())[0]!;
    remove(added);
    expect(useBrowserShortcuts.getState().added).toEqual([]);
    expect(useBrowserShortcuts.getState().names).toEqual({});
    expect(names()).not.toContain("example.org");
  });

  it("leaves a place for Add until eight sites are the user's own", () => {
    const { save } = useBrowserShortcuts.getState();
    visit("https://a.example/", 2);
    visit("https://b.example/", 2);
    expect(names()).toHaveLength(7);
    for (let index = 0; index < 8; index += 1) save(null, `https://site${index}.example/`, "");
    expect(canAddShortcut(useBrowserShortcuts.getState().added)).toBe(false);
    expect(names()).toHaveLength(8);
  });
});

it("fills every row of the Apps menu with different apps", () => {
  expect(new Set(GOOGLE_APPS.map(({ name }) => name)).size).toBe(GOOGLE_APPS.length);
  expect(GOOGLE_APPS.length % 3).toBe(0);
  expect(GOOGLE_APPS.map(({ name }) => name)).toContain("Drive");
  expect(GOOGLE_APPS.every(({ icon }) => icon?.startsWith("data:image/"))).toBe(true);
});

describe("universityMoodle", () => {
  it.each(["mail.huji.ac.il", "huji.ac.il", "cs.huji.ac.il", "MAIL.HUJI.AC.IL"])(
    "finds the Moodle of %s",
    (domain) => {
      expect(universityMoodle(["gmail.com", domain])).toMatchObject({
        name: "Moodle",
        url: "https://moodle.huji.ac.il/",
      });
    },
  );

  it.each(["gmail.com", "nothuji.ac.il", "huji.ac.il.example.org"])("ignores %s", (domain) => {
    expect(universityMoodle([domain])).toBeUndefined();
  });

  it("doesn't repeat a Moodle on the top row as a shortcut", () => {
    visit("https://moodle.huji.ac.il/2026-27/", 3);
    const moodle = universityMoodle(["huji.ac.il"])!;
    expect(names()).toContain("Moodle");
    const onTopRow = visibleShortcuts(useBrowserShortcuts.getState(), [moodle]);
    expect(onTopRow.map(({ name }) => name)).not.toContain("Moodle");
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

describe("save", () => {
  const shortcutNamed = (name: string) =>
    visibleShortcuts(useBrowserShortcuts.getState()).find((shortcut) => shortcut.name === name)!;

  it("keeps an address once and ignores text that isn't one", () => {
    const { save } = useBrowserShortcuts.getState();
    save(null, "example.org", "");
    save(null, "https://example.org/", "");
    save(null, "not a url", "");
    save(null, "word", "");
    save(null, "https://not%20a%20url/", "");
    expect(useBrowserShortcuts.getState().added).toEqual(["https://example.org/"]);
  });

  it("uses the name given, trimmed, and the site's own when there is none", () => {
    const { save } = useBrowserShortcuts.getState();
    save(null, "example.org", "  Lab wiki ");
    save(null, "scholar.google.com", "");
    expect(names().slice(0, 2)).toEqual(["Lab wiki", "Scholar"]);
  });

  it("renames a site in place", () => {
    const { save } = useBrowserShortcuts.getState();
    save(null, "first.example", "");
    save(null, "second.example", "");
    save(shortcutNamed("first.example"), "first.example", "Renamed");
    expect(names().slice(0, 2)).toEqual(["Renamed", "second.example"]);
  });

  it("clears a name back to the site's own", () => {
    const { save } = useBrowserShortcuts.getState();
    save(null, "example.org", "Lab wiki");
    save(shortcutNamed("Lab wiki"), "example.org", "");
    expect(names()[0]).toBe("example.org");
  });

  it("changes a link and keeps its place and name", () => {
    const { save } = useBrowserShortcuts.getState();
    save(null, "first.example", "Mine");
    save(null, "second.example", "");
    save(shortcutNamed("Mine"), "https://moved.example/path", "Mine");
    const [moved] = visibleShortcuts(useBrowserShortcuts.getState());
    expect(moved).toMatchObject({ name: "Mine", url: "https://moved.example/path" });
    expect(useBrowserShortcuts.getState().added).toHaveLength(2);
    expect(Object.keys(useBrowserShortcuts.getState().names)).toEqual([
      "https://moved.example/path",
    ]);
  });

  it("makes an edited suggestion the user's own", () => {
    const { save } = useBrowserShortcuts.getState();
    save(shortcutNamed("arXiv"), "https://arxiv.org/list/cs.AI/recent", "AI papers");
    expect(names()[0]).toBe("AI papers");
    expect(names()).not.toContain("arXiv");
    expect(names().filter((name) => name === "AI papers")).toHaveLength(1);
  });

  it("doesn't bring a suggestion back after moving it to another site", () => {
    const { save } = useBrowserShortcuts.getState();
    save(shortcutNamed("arXiv"), "https://biorxiv.org/", "bioRxiv");
    expect(names()).toContain("bioRxiv");
    expect(names()).not.toContain("arXiv");
  });

  it("merges an edit onto a site that is already saved", () => {
    const { save } = useBrowserShortcuts.getState();
    save(null, "first.example", "");
    save(null, "second.example", "");
    save(shortcutNamed("second.example"), "first.example", "Both");
    expect(useBrowserShortcuts.getState().added).toEqual(["https://first.example/"]);
    expect(names()[0]).toBe("Both");
  });

  it("keeps two pages of one site apart", () => {
    const { save } = useBrowserShortcuts.getState();
    save(null, "https://example.org/a", "A");
    save(null, "https://example.org/b", "B");
    expect(names().slice(0, 2)).toEqual(["A", "B"]);
    save(shortcutNamed("B"), "https://example.org/b", "Beta");
    expect(names().slice(0, 2)).toEqual(["A", "Beta"]);
  });
});

it("keeps shortcuts saved before names existed", () => {
  useBrowserShortcuts.setState({ added: ["https://example.org/"] });
  expect(names()[0]).toBe("example.org");
});
