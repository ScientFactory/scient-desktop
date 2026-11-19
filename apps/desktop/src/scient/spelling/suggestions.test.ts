// @effect-diagnostics nodeBuiltinImport:off -- The suggester under test caches plain files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeSuggester } from "./suggestions.ts";

const ENGLISH = {
  "https://cdn.jsdelivr.net/npm/dictionary-en@4.0.0/index.aff":
    "SET UTF-8\nTRY esianrtolcdugmphbyfvkwz\n",
  "https://cdn.jsdelivr.net/npm/dictionary-en@4.0.0/index.dic":
    "3\nacknowledgment\nacknowledgments\nresults\n",
} as Record<string, string>;

let directory: string;

beforeEach(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-spelling-"));
});

afterEach(async () => {
  await NodeFSP.rm(directory, { recursive: true, force: true });
});

function setup(fetchText: (url: string) => Promise<string>) {
  const onError = vi.fn<(message: string, cause: unknown) => void>();
  return { suggester: makeSuggester({ directory, fetchText, onError }), onError };
}

const serve = async (url: string) => {
  const text = ENGLISH[url];
  if (text === undefined) throw new Error(`unexpected ${url}`);
  return text;
};

describe("makeSuggester", () => {
  it("suggests from a downloaded dictionary, and reads it from disk afterwards", async () => {
    const { suggester } = setup(serve);
    suggester.prepare(["en-US", "af"]);
    await vi.waitFor(() =>
      expect(suggester.suggest("acknolegments", ["en-US", "af"])).toEqual([
        expect.arrayContaining(["acknowledgments"]),
      ]),
    );
    expect(suggester.suggest("results", ["en-US"])).toEqual([]);

    const offline = setup(() => Promise.reject(new Error("offline"))).suggester;
    offline.prepare(["en"]);
    await vi.waitFor(() => expect(offline.suggest("acknolegments", ["en"])).toHaveLength(1));
  });

  it("retries a dictionary that failed to load", async () => {
    const fetchText = vi.fn(serve).mockRejectedValueOnce(new Error("offline"));
    const { suggester, onError } = setup(fetchText);
    suggester.prepare(["en-US"]);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(suggester.suggest("acknolegments", ["en-US"])).toEqual([]);
    suggester.prepare(["en-US"]);
    await vi.waitFor(() => expect(suggester.suggest("acknolegments", ["en-US"])).toHaveLength(1));
  });
});
