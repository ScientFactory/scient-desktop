import { describe, expect, it } from "vite-plus/test";

import {
  errorLabel,
  LifecycleRecorder,
  MAX_REPORT_BYTES,
  navigationCategory,
  upgradeRole,
} from "./browserLifecycleDiagnostics";

const secret = "token=s3cr3t-value";
const opened = `http://localhost:63315/__vitest_test__/?sessionId=abc&${secret}`;

describe("browser lifecycle redaction", () => {
  it("labels errors by allowlisted code or class, never by message", () => {
    const cases: Array<[unknown, string]> = [
      [
        Object.assign(new Error(`reset at /Users/me ${secret}`), { code: "ECONNRESET" }),
        "ECONNRESET",
      ],
      [Object.assign(new Error("x"), { code: `/Users/me/${secret}` }), "Error"],
      [Object.assign(new Error("x"), { name: `Custom ${secret}` }), "other"],
      [secret, "other"],
    ];
    for (const [error, label] of cases) expect(errorLabel(error)).toBe(label);
  });

  it("keeps only a navigation category relative to the opened page", () => {
    expect(navigationCategory("about:blank", opened)).toBe("about-blank");
    expect(navigationCategory(`http://localhost:63315/__vitest_test__/?${secret}#x`, opened)).toBe(
      "same-document",
    );
    expect(navigationCategory(`http://localhost:63315/other?${secret}`, opened)).toBe(
      "same-origin",
    );
    expect(navigationCategory(`https://example.com/?${secret}`, opened)).toBe("other-origin");
    expect(navigationCategory("not a url", opened)).toBe("other-origin");
  });

  it("reads the browser API role and session, and nothing from other upgrades", () => {
    expect(upgradeRole(`/__vitest_browser_api__?type=orchestrator&sessionId=s1&${secret}`)).toEqual(
      { role: "orchestrator", sessionId: "s1" },
    );
    expect(upgradeRole(`/__vitest_browser_api__?type=evil&sessionId=s1`)).toEqual({
      role: "other",
      sessionId: null,
    });
    expect(upgradeRole(`/?token=${secret}`)).toEqual({ role: "other", sessionId: null });
  });
});

describe("browser lifecycle report bounds", () => {
  const routine = (recorder: LifecycleRecorder, count: number) => {
    for (let socket = 1; socket <= count; socket++)
      recorder.record({ kind: "socket-open", role: "tester", socket, session: 1 }, "routine");
  };

  it("rolls routine events within the event and byte caps", () => {
    const recorder = new LifecycleRecorder(() => 0);
    routine(recorder, 5_000);
    const json = recorder.snapshot("shutdown");
    const report = JSON.parse(json);
    expect(json.length).toBeLessThanOrEqual(MAX_REPORT_BYTES);
    expect(report).toMatchObject({ recorded: 5_000, firstUnexplained: null });
    expect(report.events.at(-1).socket).toBe(5_000);
    expect(report.events.length).toBeLessThan(5_000);
  });

  it("freezes the first unexplained window so later churn cannot push it out", () => {
    const recorder = new LifecycleRecorder(() => 0);
    routine(recorder, 50);
    expect(recorder.record({ kind: "page-close", session: 1 }, "unexplained")).toBe(true);
    expect(recorder.record({ kind: "browser-disconnected" }, "unexplained")).toBe(false);
    routine(recorder, 5_000);
    const json = recorder.snapshot("shutdown");
    const report = JSON.parse(json);
    expect(json.length).toBeLessThanOrEqual(MAX_REPORT_BYTES);
    expect(report.firstUnexplained).toHaveLength(51);
    expect(report.firstUnexplained.at(-1)).toMatchObject({
      kind: "page-close",
      disposition: "unexplained",
    });
    expect(report.events.at(-1).socket).toBe(5_000);
  });
});
