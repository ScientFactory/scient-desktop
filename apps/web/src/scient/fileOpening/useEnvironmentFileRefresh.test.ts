import { EnvironmentFilePath, type EnvironmentFileChangeEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  advanceEnvironmentFileChangeCursor,
  type EnvironmentFileChangeCursor,
  resolveEnvironmentFileWatchPath,
} from "./useEnvironmentFileRefresh";

function event(
  tag: EnvironmentFileChangeEvent["_tag"],
  path = "/workspace/report.html",
): EnvironmentFileChangeEvent {
  return { _tag: tag, path: EnvironmentFilePath.make(path) };
}

describe("environment file refresh cursor", () => {
  const initial: EnvironmentFileChangeCursor = {
    watchedPath: "/workspace/report.html",
    event: null,
  };

  it("refreshes on watcher readiness and each distinct change hint", () => {
    const ready = event("watch-ready");
    const afterReady = advanceEnvironmentFileChangeCursor(initial, "/workspace/report.html", ready);
    expect(afterReady.shouldRefresh).toBe(true);

    const duplicate = advanceEnvironmentFileChangeCursor(
      afterReady.cursor,
      "/workspace/report.html",
      ready,
    );
    expect(duplicate.shouldRefresh).toBe(false);

    const changed = advanceEnvironmentFileChangeCursor(
      duplicate.cursor,
      "/workspace/report.html",
      event("file-changed"),
    );
    expect(changed.shouldRefresh).toBe(true);
  });

  it("resets deduplication when the canonical path changes", () => {
    const sharedEvent = event("watch-ready", "/workspace/first.html");
    const first = advanceEnvironmentFileChangeCursor(initial, "/workspace/first.html", sharedEvent);
    const second = advanceEnvironmentFileChangeCursor(
      first.cursor,
      "/workspace/second.html",
      sharedEvent,
    );

    expect(second.shouldRefresh).toBe(true);
    expect(second.cursor.watchedPath).toBe("/workspace/second.html");
  });

  it("does not refresh without a delivered watcher event", () => {
    expect(advanceEnvironmentFileChangeCursor(initial, "/workspace/report.html", null)).toEqual({
      cursor: { watchedPath: "/workspace/report.html", event: null },
      shouldRefresh: false,
    });
  });
});

describe("environment file watch path", () => {
  it("watches the requested path while the file is missing", () => {
    expect(resolveEnvironmentFileWatchPath("/workspace/new-file.md", null)).toBe(
      "/workspace/new-file.md",
    );
  });

  it("switches to the authoritative canonical path after inspection", () => {
    expect(
      resolveEnvironmentFileWatchPath("/workspace/link.md", {
        canonicalPath: EnvironmentFilePath.make("/workspace/real.md"),
      }),
    ).toBe("/workspace/real.md");
  });
});
