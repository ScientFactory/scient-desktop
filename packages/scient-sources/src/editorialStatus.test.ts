import { describe, expect, it } from "@effect/vitest";

import { editorialNoticeKind, editorialStatusFromNotices } from "./editorialStatus.ts";

describe("editorial status", () => {
  it("names each registry update type once and ignores updates that change nothing", () => {
    expect(editorialNoticeKind("Retraction")).toBe("retraction");
    expect(editorialNoticeKind("partial_retraction")).toBe("retraction");
    expect(editorialNoticeKind("expression_of_concern")).toBe("expression-of-concern");
    expect(editorialNoticeKind("Expression of concern")).toBe("expression-of-concern");
    expect(editorialNoticeKind("erratum")).toBe("correction");
    expect(editorialNoticeKind("new_version")).toBeNull();
  });

  it("lets the most serious notice decide and keeps one copy of each, newest first", () => {
    const status = editorialStatusFromNotices(
      [
        { kind: "correction", doi: "10.1/c", date: "2004-03-06" },
        { kind: "retraction", doi: "10.1/r", date: "2010-02-06", source: "retraction-watch" },
        { kind: "retraction", doi: "10.1/r", date: "2010-02-06", source: "publisher" },
      ],
      "2026-11-10T00:00:00.000Z",
    );
    expect(status.state).toBe("retracted");
    expect(status.notices.map((notice) => notice.kind)).toEqual(["retraction", "correction"]);
    expect(editorialStatusFromNotices([], "2026-11-10T00:00:00.000Z").state).toBe("none");
  });
});
