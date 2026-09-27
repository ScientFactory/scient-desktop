import { describe, expect, it } from "@effect/vitest";

import { uploadTarget } from "./openedConversationFiles.ts";

describe("OS-opened conversation file upload target", () => {
  const permitted = new Set(["http://127.0.0.1:31234"]);
  const route = "/api/scient/conversation-import/v1/upload/signed-token";

  it("accepts only the exact managed backend origin and upload route", () => {
    expect(uploadTarget(`http://127.0.0.1:31234${route}`, permitted)?.pathname).toBe(route);
    expect(uploadTarget(`http://127.0.0.1:31235${route}`, permitted)).toBeNull();
    expect(uploadTarget(`https://example.com${route}`, permitted)).toBeNull();
    expect(uploadTarget(`http://127.0.0.1:31234/other`, permitted)).toBeNull();
    expect(uploadTarget(`http://127.0.0.1:31234${route}?redirect=evil`, permitted)).toBeNull();
    expect(uploadTarget(`http://user:pass@127.0.0.1:31234${route}`, permitted)).toBeNull();
  });
});
