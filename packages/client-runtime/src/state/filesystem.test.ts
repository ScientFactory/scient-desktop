import { describe, expect, it } from "vite-plus/test";
import { AuthFilesystemReadScope, AuthOrchestrationReadScope } from "@t3tools/contracts";

import {
  canPreloadBrowsePath,
  canonicalizeUneditedBrowseQuery,
  createBrowseNavigationCoordinator,
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
  resolveFilesystemReadAccess,
} from "./filesystem.ts";

/** A server that already splits scopes; it never falls back to a parent grant. */
const SPLIT_SCOPES_SERVER = { serverUpdateScope: "environment:maintain" } as const;

describe("filesystem read access", () => {
  it("waits for the initial catalog before declaring a missing environment disconnected", () => {
    expect(
      resolveFilesystemReadAccess({
        isCatalogReady: false,
        connection: null,
        session: null,
        sessionError: null,
      }),
    ).toEqual({ canReadFiles: false, isPending: true, error: null });
  });

  it("stops waiting when the loaded catalog has no matching environment", () => {
    expect(
      resolveFilesystemReadAccess({
        isCatalogReady: true,
        connection: null,
        session: null,
        sessionError: null,
      }),
    ).toEqual({
      canReadFiles: false,
      isPending: false,
      error: "This environment is not connected.",
    });
  });

  it.each(["available", "offline", "error"] as const)(
    "stops waiting for an unresolved session when the connection is %s",
    (phase) => {
      expect(
        resolveFilesystemReadAccess({
          isCatalogReady: true,
          connection: { phase, error: null },
          session: null,
          sessionError: null,
        }),
      ).toEqual({
        canReadFiles: false,
        isPending: false,
        error: "This environment is not connected.",
      });
    },
  );

  it.each(["connected", "connecting", "reconnecting"] as const)(
    "waits for the session check while %s",
    (phase) => {
      expect(
        resolveFilesystemReadAccess({
          isCatalogReady: true,
          connection: { phase, error: null },
          session: null,
          sessionError: null,
        }),
      ).toEqual({ canReadFiles: false, isPending: true, error: null });
    },
  );

  it("reports the transport failure when the session cannot be checked", () => {
    expect(
      resolveFilesystemReadAccess({
        isCatalogReady: true,
        connection: { phase: "error", error: "The relay is unavailable." },
        session: null,
        sessionError: null,
      }),
    ).toEqual({ canReadFiles: false, isPending: false, error: "The relay is unavailable." });
  });

  it.each([false, true])(
    "preserves a cached file grant offline with catalog ready=%s",
    (isCatalogReady) => {
      const input = {
        isCatalogReady,
        connection: { phase: "offline", error: null },
        session: { authenticated: true, scopes: [AuthFilesystemReadScope] },
        sessionError: null,
      } as const;
      expect(resolveFilesystemReadAccess(input)).toEqual({
        canReadFiles: true,
        isPending: false,
        error: null,
      });
      expect(
        resolveFilesystemReadAccess({ ...input, sessionError: "The session has expired." }),
      ).toEqual({ canReadFiles: false, isPending: false, error: "The session has expired." });
    },
  );

  it.each([
    { authenticated: true, scopes: [AuthOrchestrationReadScope], auth: SPLIT_SCOPES_SERVER },
    { authenticated: false, scopes: [AuthFilesystemReadScope], auth: SPLIT_SCOPES_SERVER },
  ] as const)("does not infer file access from an ungranted session", (session) => {
    expect(
      resolveFilesystemReadAccess({
        isCatalogReady: true,
        connection: { phase: "connected", error: null },
        session,
        sessionError: null,
      }),
    ).toEqual({ canReadFiles: false, isPending: false, error: null });
  });

  it("falls back to the orchestration grant on a server that predates filesystem:read", () => {
    expect(
      resolveFilesystemReadAccess({
        isCatalogReady: true,
        connection: { phase: "connected", error: null },
        session: { authenticated: true, scopes: [AuthOrchestrationReadScope], auth: {} },
        sessionError: null,
      }),
    ).toEqual({ canReadFiles: true, isPending: false, error: null });
  });
});

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
