import { describe, expect, it } from "vite-plus/test";

import {
  canPreloadBrowsePath,
  canonicalizeUneditedBrowseQuery,
  createBrowseNavigationCoordinator,
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "./filesystem.ts";

describe("filesystem browse model", () => {
  it("derives the browse target and navigation state", () => {
    expect(getFilesystemBrowsePath("~/projects/t3")).toEqual({
      isBrowsing: true,
      resolvedQuery: "~/projects/t3",
      directoryPath: "~/projects/",
      filterQuery: "t3",
      parentPath: "~/",
      canBrowseUp: true,
    });
    expect(getFilesystemBrowsePath("C:\\Users\\test", "MacIntel").isBrowsing).toBe(false);
    expect(getFilesystemBrowsePath("~/projects/", "", false).isBrowsing).toBe(false);
  });

  it("keeps add-project browsing active while a user filters by folder name", () => {
    expect(
      getFilesystemBrowsePath("OneDrive", "Win32", true, {
        baseDirectoryPath: "C:\\Users\\Sacha\\",
      }),
    ).toEqual({
      isBrowsing: true,
      resolvedQuery: "C:\\Users\\Sacha\\OneDrive",
      directoryPath: "C:\\Users\\Sacha\\",
      filterQuery: "OneDrive",
      parentPath: "C:\\Users\\",
      canBrowseUp: true,
    });
    expect(
      getFilesystemBrowsePath("Projects", "MacIntel", true, {
        baseDirectoryPath: "/Users/test/",
      }).resolvedQuery,
    ).toBe("/Users/test/Projects");
  });

  it("resolves a symbolic starting path without replacing typed text", () => {
    const scope = {
      baseDirectoryPath: "~/",
      alias: {
        path: "~/",
        resolvedPath: "C:\\Users\\Sacha\\",
      },
    } as const;
    expect(getFilesystemBrowsePath("~/One", "Win32", true, scope)).toEqual({
      isBrowsing: true,
      resolvedQuery: "C:\\Users\\Sacha\\One",
      directoryPath: "C:\\Users\\Sacha\\",
      filterQuery: "One",
      parentPath: "C:\\Users\\",
      canBrowseUp: true,
    });
    expect(getFilesystemBrowsePath("One", "Win32", true, scope).resolvedQuery).toBe(
      "C:\\Users\\Sacha\\One",
    );
  });

  it("canonicalizes only an untouched initial path", () => {
    expect(canonicalizeUneditedBrowseQuery("~/", "~/", "C:\\Users\\Sacha")).toBe(
      "C:\\Users\\Sacha\\",
    );
    expect(canonicalizeUneditedBrowseQuery("~/One", "~/", "C:\\Users\\Sacha")).toBe("~/One");
    expect(canonicalizeUneditedBrowseQuery("One", "~/", "C:\\Users\\Sacha")).toBe("One");
  });

  it("does not reinterpret an unsupported absolute Windows path as a local folder name", () => {
    expect(
      getFilesystemBrowsePath("C:\\Work\\Repo", "MacIntel", true, {
        baseDirectoryPath: "/Users/test/",
      }),
    ).toEqual({
      isBrowsing: true,
      resolvedQuery: "C:\\Work\\Repo",
      directoryPath: "",
      filterQuery: "",
      parentPath: null,
      canBrowseUp: false,
    });
  });

  it("filters names, hidden directories, and exact matches consistently", () => {
    const entries = [
      { name: ".config", fullPath: "/Users/test/.config" },
      { name: "Code", fullPath: "/Users/test/Code" },
      { name: "codething", fullPath: "/Users/test/codething" },
    ];

    expect(filterFilesystemBrowseEntries(entries, "co")).toEqual({
      visibleEntries: entries.slice(1, 3),
      exactEntry: null,
    });
    expect(filterFilesystemBrowseEntries(entries, "").visibleEntries).toEqual(entries.slice(1));
    expect(filterFilesystemBrowseEntries(entries, ".").visibleEntries).toEqual(entries.slice(0, 1));
    expect(filterFilesystemBrowseEntries(entries, "Code").exactEntry).toEqual(entries[1]);
  });
});

describe("browse navigation", () => {
  it("only commits the latest valid navigation", async () => {
    const navigation = createBrowseNavigationCoordinator();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const commits: string[] = [];
    const commit = (name: string) => () => commits.push(name);
    const firstRun = navigation.run(() => first.promise, commit("first"));
    const secondRun = navigation.run(() => second.promise, commit("second"));

    second.resolve();
    await expect(secondRun).resolves.toBe(true);
    first.resolve();
    await expect(firstRun).resolves.toBe(false);

    const invalidated = Promise.withResolvers<void>();
    const invalidatedRun = navigation.run(() => invalidated.promise, commit("stale"));
    navigation.invalidate();
    invalidated.resolve();

    await expect(invalidatedRun).resolves.toBe(false);
    expect(commits).toEqual(["second"]);
  });

  it("only preloads connected environments", () => {
    expect(canPreloadBrowsePath("connected")).toBe(true);
    expect(canPreloadBrowsePath("offline")).toBe(false);
    expect(canPreloadBrowsePath("reconnecting")).toBe(false);
    expect(canPreloadBrowsePath(null)).toBe(false);
  });
});
