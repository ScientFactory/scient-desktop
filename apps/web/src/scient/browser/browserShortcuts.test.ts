import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  canAddShortcut,
  GOOGLE_APPS,
  migrateShortcuts,
  type SavedShortcuts,
  type Shortcut,
  universitySite,
  useBrowserShortcuts,
  visibleShortcuts,
} from "./browserShortcuts";

const NOTHING: SavedShortcuts = { added: [], names: {}, hidden: [], visits: {} };
const saved = (profileId = "default") =>
  useBrowserShortcuts.getState().profiles[profileId] ?? NOTHING;
const names = (profileId?: string) => visibleShortcuts(saved(profileId)).map(({ name }) => name);
const visit = (url: string, times = 1, at = 1_000) => {
  for (let index = 0; index < times; index += 1) {
    useBrowserShortcuts.getState().recordVisit("default", url, at);
  }
};

const profileActions = (profileId = "default") => ({
  save: (...args: [Shortcut | null, string, string]) =>
    useBrowserShortcuts.getState().save(profileId, ...args),
  remove: (shortcut: Shortcut) => useBrowserShortcuts.getState().remove(profileId, shortcut),
});

beforeEach(() => {
  useBrowserShortcuts.setState({ profiles: {}, unclaimed: null });
});

describe("visibleShortcuts", () => {
  it("starts with the scientific sites and Google's apps", () => {
    expect(names()).toEqual(["Scholar", "PubMed", "arXiv", "Overleaf", "Drive", "Calendar"]);
  });

  it("puts added sites first, then the most opened, then the starting set", () => {
    visit("https://www.nature.com/articles/a", 2);
    visit("https://github.com/owner/repo", 3);
    profileActions().save(null, "wikipedia.org", "");
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
    const shortcuts = visibleShortcuts(saved());
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
    expect(visibleShortcuts(saved())[0]).toMatchObject({
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
    profileActions().save(null, "google.com", "");
    expect(names()[0]).toBe("Google");
  });

  it("keeps a removed site away until the user adds it back", () => {
    const { save, remove } = profileActions();
    const scholar = visibleShortcuts(saved())[0]!;
    remove(scholar);
    visit("https://scholar.google.com/", 5);
    expect(names()).not.toContain("Scholar");
    save(null, "scholar.google.com", "");
    expect(names()).toContain("Scholar");
  });

  it("removes a site the user added without bringing it back", () => {
    const { save, remove } = profileActions();
    save(null, "https://example.org/page", "Lab page");
    const added = visibleShortcuts(saved())[0]!;
    remove(added);
    expect(saved().added).toEqual([]);
    expect(saved().names).toEqual({});
    expect(names()).not.toContain("example.org");
  });

  it("leaves a place for Add until eight sites are the user's own", () => {
    const { save } = profileActions();
    visit("https://a.example/", 2);
    visit("https://b.example/", 2);
    expect(names()).toHaveLength(7);
    for (let index = 0; index < 8; index += 1) save(null, `https://site${index}.example/`, "");
    expect(canAddShortcut(saved().added)).toBe(false);
    expect(names()).toHaveLength(8);
  });
});

it("fills every row of the Apps menu with different apps", () => {
  expect(new Set(GOOGLE_APPS.map(({ name }) => name)).size).toBe(GOOGLE_APPS.length);
  expect(GOOGLE_APPS.length % 3).toBe(0);
  expect(GOOGLE_APPS.map(({ name }) => name)).toContain("Drive");
  expect(GOOGLE_APPS.every(({ icon }) => icon?.startsWith("data:image/"))).toBe(true);
});

describe("universitySite", () => {
  const site = (address: string | undefined, signInSites: ReadonlyArray<string> = []) => {
    const found = universitySite(address, signInSites, saved().visits);
    return found && { name: found.name, url: found.url };
  };

  it.each(["mail.huji.ac.il", "huji.ac.il", "cs.huji.ac.il", "MAIL.HUJI.AC.IL", "huji.ac.il."])(
    "finds the Moodle of an address at %s",
    (domain) => {
      expect(site(domain)).toEqual({ name: "Moodle", url: "https://moodle.huji.ac.il/" });
    },
  );

  it.each(["post.tau.ac.il", "campus.technion.ac.il", "post.bgu.ac.il", "ariel.ac.il"])(
    "knows the listed university at %s",
    (domain) => {
      expect(site(domain)?.url).toMatch(/^https:\/\/moodle\.[a-z]+\.ac\.il\/$/);
    },
  );

  it("knows the Open University's Opal, and Reichman by its old IDC addresses too", () => {
    expect(site("openu.ac.il")).toEqual({ name: "Opal", url: "https://opal.openu.ac.il/" });
    expect(site("post.idc.ac.il")).toEqual(site("post.runi.ac.il"));
    expect(site("post.runi.ac.il")?.url).toBe("https://moodle.runi.ac.il/");
  });

  it("shows nothing for a personal address, whatever university sites the profile uses", () => {
    visit("https://moodle.tau.ac.il/my/", 5);
    expect(
      site("gmail.com", ["moodle.huji.ac.il", "https://moodle2.cs.huji.ac.il"]),
    ).toBeUndefined();
    expect(site(undefined, ["moodle.huji.ac.il"])).toBeUndefined();
  });

  it.each(["nothuji.ac.il", "huji.ac.il.example.org"])("ignores %s", (domain) => {
    expect(site(domain)).toBeUndefined();
  });

  it.each([
    ["mail.ucl.ac.uk", "https://moodle.ucl.ac.uk/"],
    ["cs.ox.ac.uk", "https://moodle2.cs.ox.ac.uk/"],
    ["epfl.ch", "https://moodle.epfl.ch/"],
    ["student.ethz.ch", "https://moodle-app2.let.ethz.ch/"],
    ["une.edu.au", "https://moodle.une.edu.au/"],
    ["s.kyushu-u.ac.jp", "https://moodle.s.kyushu-u.ac.jp/"],
    ["grad.ufsc.br", "https://moodle.ufsc.br/"],
    ["mit.edu", "https://moodle.mit.edu/"],
  ])("learns the Moodle of an unlisted university at %s from a sign-in", (domain, url) => {
    expect(site(domain, [url.replace(/\/$/, ""), "https://www.google.com"])).toEqual({
      name: "Moodle",
      url,
    });
  });

  it("keeps the port of a Moodle that has its own", () => {
    expect(
      site("ucl.ac.uk", ["https://moodle.ucl.ac.uk:8443", "moodle2.ucl.ac.uk:8080"])?.url,
    ).toBe("https://moodle.ucl.ac.uk:8443/");
    expect(site("ucl.ac.uk", ["moodle2.ucl.ac.uk:8080"])?.url).toBe(
      "https://moodle2.ucl.ac.uk:8080/",
    );
  });

  it("learns it from opening it twice, and prefers the one opened most", () => {
    visit("https://moodle.ucl.ac.uk/course/", 1);
    expect(site("ucl.ac.uk")).toBeUndefined();
    visit("https://moodle.ucl.ac.uk/course/", 1);
    expect(site("ucl.ac.uk")?.url).toBe("https://moodle.ucl.ac.uk/");
    visit("https://moodle-archive.ucl.ac.uk/", 3);
    expect(site("ucl.ac.uk", ["moodle.ucl.ac.uk"])?.url).toBe("https://moodle-archive.ucl.ac.uk/");
  });

  it("only takes a Moodle on the address's own university", () => {
    expect(
      site("ucl.ac.uk", ["moodle.ox.ac.uk", "moodle.org", "moodle-ucl.example.com"]),
    ).toBeUndefined();
    expect(site("moodle-consulting.com", ["https://moodle-consulting.com"])).toBeUndefined();
  });

  it("doesn't repeat a Moodle on the top row as a shortcut", () => {
    visit("https://moodle.huji.ac.il/2026-27/", 3);
    expect(names()).toContain("Moodle");
    const onTopRow = visibleShortcuts(saved(), [site("huji.ac.il")!]);
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
    expect(saved().visits).toEqual({});
  });

  it("forgets the sites not opened for longest past its limit", () => {
    for (let index = 0; index < 101; index += 1) visit(`https://site${index}.example/`, 1, index);
    const { visits } = saved();
    expect(Object.keys(visits)).toHaveLength(100);
    expect(visits["site0.example"]).toBeUndefined();
  });
});

describe("save", () => {
  const shortcutNamed = (name: string) =>
    visibleShortcuts(saved()).find((shortcut) => shortcut.name === name)!;

  it("keeps an address once and ignores text that isn't one", () => {
    const { save } = profileActions();
    save(null, "example.org", "");
    save(null, "https://example.org/", "");
    save(null, "not a url", "");
    save(null, "word", "");
    save(null, "https://not%20a%20url/", "");
    expect(saved().added).toEqual(["https://example.org/"]);
  });

  it("uses the name given, trimmed, and the site's own when there is none", () => {
    const { save } = profileActions();
    save(null, "example.org", "  Lab wiki ");
    save(null, "scholar.google.com", "");
    expect(names().slice(0, 2)).toEqual(["Lab wiki", "Scholar"]);
  });

  it("renames a site in place", () => {
    const { save } = profileActions();
    save(null, "first.example", "");
    save(null, "second.example", "");
    save(shortcutNamed("first.example"), "first.example", "Renamed");
    expect(names().slice(0, 2)).toEqual(["Renamed", "second.example"]);
  });

  it("clears a name back to the site's own", () => {
    const { save } = profileActions();
    save(null, "example.org", "Lab wiki");
    save(shortcutNamed("Lab wiki"), "example.org", "");
    expect(names()[0]).toBe("example.org");
  });

  it("changes a link and keeps its place and name", () => {
    const { save } = profileActions();
    save(null, "first.example", "Mine");
    save(null, "second.example", "");
    save(shortcutNamed("Mine"), "https://moved.example/path", "Mine");
    const [moved] = visibleShortcuts(saved());
    expect(moved).toMatchObject({ name: "Mine", url: "https://moved.example/path" });
    expect(saved().added).toHaveLength(2);
    expect(Object.keys(saved().names)).toEqual(["https://moved.example/path"]);
  });

  it("makes an edited suggestion the user's own", () => {
    const { save } = profileActions();
    save(shortcutNamed("arXiv"), "https://arxiv.org/list/cs.AI/recent", "AI papers");
    expect(names()[0]).toBe("AI papers");
    expect(names()).not.toContain("arXiv");
    expect(names().filter((name) => name === "AI papers")).toHaveLength(1);
  });

  it("doesn't bring a suggestion back after moving it to another site", () => {
    const { save } = profileActions();
    save(shortcutNamed("arXiv"), "https://biorxiv.org/", "bioRxiv");
    expect(names()).toContain("bioRxiv");
    expect(names()).not.toContain("arXiv");
  });

  it("merges an edit onto a site that is already saved", () => {
    const { save } = profileActions();
    save(null, "first.example", "");
    save(null, "second.example", "");
    save(shortcutNamed("second.example"), "first.example", "Both");
    expect(saved().added).toEqual(["https://first.example/"]);
    expect(names()[0]).toBe("Both");
  });

  it("keeps two pages of one site apart", () => {
    const { save } = profileActions();
    save(null, "https://example.org/a", "A");
    save(null, "https://example.org/b", "B");
    expect(names().slice(0, 2)).toEqual(["A", "B"]);
    save(shortcutNamed("B"), "https://example.org/b", "Beta");
    expect(names().slice(0, 2)).toEqual(["A", "Beta"]);
  });
});

describe("profiles", () => {
  it("keeps what each profile adds, edits, removes and opens to itself", () => {
    const home = profileActions("home");
    const work = profileActions("work");
    home.save(null, "https://example.org/", "Home site");
    work.remove(visibleShortcuts(saved("work"))[0]!);
    for (let visit = 0; visit < 2; visit += 1) {
      useBrowserShortcuts.getState().recordVisit("work", "https://github.com/", 1_000);
    }

    expect(names("home")[0]).toBe("Home site");
    expect(names("home")).toContain("Scholar");
    expect(names("home")).not.toContain("github.com");
    expect(names("work")[0]).toBe("github.com");
    expect(names("work")).not.toContain("Scholar");
    expect(names("work")).not.toContain("Home site");
  });

  it("gives a new profile the starting set", () => {
    profileActions("home").save(null, "https://example.org/", "");
    expect(names("new")).toEqual(["Scholar", "PubMed", "arXiv", "Overleaf", "Drive", "Calendar"]);
  });

  it("keeps nothing for incognito", () => {
    const { recordVisit } = useBrowserShortcuts.getState();
    recordVisit(INCOGNITO_BROWSER_PROFILE_ID, "https://example.org/", 1_000);
    profileActions(INCOGNITO_BROWSER_PROFILE_ID).save(null, "https://example.org/", "");
    expect(useBrowserShortcuts.getState().profiles).toEqual({});
  });

  it("forgets a removed profile and leaves the others", () => {
    profileActions("home").save(null, "https://example.org/", "");
    profileActions("work").save(null, "https://example.com/", "");
    useBrowserShortcuts.getState().forgetProfile("home");
    expect(Object.keys(useBrowserShortcuts.getState().profiles)).toEqual(["work"]);
  });

  it("adds a merged profile's shortcuts after the other's own", () => {
    profileActions("default").save(null, "https://example.org/", "");
    profileActions("home").save(null, "https://example.com/", "");
    profileActions("home").save(null, "https://example.org/", "");
    useBrowserShortcuts.getState().mergeProfile("home", "default");
    const { profiles } = useBrowserShortcuts.getState();
    expect(Object.keys(profiles)).toEqual(["default"]);
    expect(profiles["default"]?.added).toEqual(["https://example.org/", "https://example.com/"]);
  });
});

describe("shortcuts saved before each profile had its own", () => {
  const old = { added: ["https://example.org/"], hidden: ["arxiv.org"], visits: {} };

  it("waits for the default profile, filling in anything an older version didn't save", () => {
    expect(migrateShortcuts(old, 1)).toEqual({
      profiles: {},
      unclaimed: { ...old, names: {} },
    });
  });

  it("leaves the current format alone", () => {
    const current = { profiles: { work: NOTHING }, unclaimed: null };
    expect(migrateShortcuts(current, 2)).toBe(current);
  });

  it("join anything the default profile did while settings were loading", () => {
    useBrowserShortcuts.setState(migrateShortcuts(old, 1));
    visit("https://github.com/", 2);
    useBrowserShortcuts.getState().claimUnclaimed("default");

    expect(saved().added).toEqual(["https://example.org/"]);
    expect(names().slice(0, 2)).toEqual(["example.org", "github.com"]);
    expect(names()).not.toContain("arXiv");
  });

  it("go to the default profile once, and no other", () => {
    useBrowserShortcuts.setState(migrateShortcuts(old, 1));
    const { claimUnclaimed } = useBrowserShortcuts.getState();
    claimUnclaimed("imported");
    claimUnclaimed("work");

    expect(useBrowserShortcuts.getState().unclaimed).toBeNull();
    expect(names("imported")[0]).toBe("example.org");
    expect(names("imported")).not.toContain("arXiv");
    expect(names("work")).toContain("arXiv");
  });
});
