import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, vi } from "vite-plus/test";

const { showItemInFolder } = vi.hoisted(() => ({ showItemInFolder: vi.fn() }));

vi.mock("electron", () => ({ shell: { showItemInFolder } }));

import { revealSavedAsset } from "./documentArtifacts.ts";

describe("document artifact IPC", () => {
  beforeEach(() => showItemInFolder.mockReset());

  effectIt.effect("preserves the exact native destination path", () =>
    Effect.gen(function* () {
      const path = "/tmp/ report .pdf ";

      yield* revealSavedAsset.handler(path);

      expect(showItemInFolder).toHaveBeenCalledWith(path);
    }),
  );

  effectIt.effect("rejects empty and NUL-containing reveal paths", () =>
    Effect.gen(function* () {
      for (const path of ["", "bad\0path.pdf"]) {
        const result = yield* Effect.result(revealSavedAsset.handler(path));
        expect(result._tag).toBe("Failure");
      }
      expect(showItemInFolder).not.toHaveBeenCalled();
    }),
  );
});
