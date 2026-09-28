import { describe, expect, it } from "@effect/vitest";
import { beforeEach } from "vite-plus/test";

import {
  SCIENT_ASSET_URL_PLACEHOLDER,
  STORAGE_PATH_PLACEHOLDER,
  redactScientAssetUrls,
  redactSnapshotStoragePaths,
  redactStoragePaths,
} from "./storagePaths.ts";
import {
  activity,
  exportMarkdown,
  message,
  resetClock,
  snapshotOf,
  thread,
} from "./thread.test-fixtures.ts";

beforeEach(resetClock);

const POSIX_ROOT = "/Users/alice_name/*scient*/userdata";
const WINDOWS_ROOT = "C:\\Users\\bob_smith\\AppData\\Roaming\\Scient";

describe("storage path redaction", () => {
  it("removes signed Scient asset capabilities even without configured storage roots", () => {
    const capability = "eyJwYXRoIjoiL1VzZXJzL2FsaWNlL3NlY3JldCJ9.signature";
    const absolute = `http://127.0.0.1:3773/api/assets/${capability}/report.html`;
    const relative = `/api/assets/${capability}/report.html`;
    const encodedRelative = `/api%2Fassets%2F${capability}%2Freport.html`;
    const protocolRelative = `//127.0.0.1:3773${encodedRelative}`;
    expect(redactScientAssetUrls(`Open ${absolute} and ${relative}`)).toBe(
      `Open ${SCIENT_ASSET_URL_PLACEHOLDER} and ${SCIENT_ASSET_URL_PLACEHOLDER}`,
    );
    expect(
      redactScientAssetUrls(`https://scient.example/api%2Fassets%2F${capability}%2Freport.html`),
    ).toBe(SCIENT_ASSET_URL_PLACEHOLDER);
    expect(redactScientAssetUrls(encodedRelative)).toBe(SCIENT_ASSET_URL_PLACEHOLDER);
    expect(redactScientAssetUrls(protocolRelative)).toBe(SCIENT_ASSET_URL_PLACEHOLDER);
    expect(redactScientAssetUrls(`/api%252Fassets%252F${capability}%252Freport.html`)).toBe(
      SCIENT_ASSET_URL_PLACEHOLDER,
    );
    expect(redactScientAssetUrls(`${encodedRelative}%BROKEN`)).toBe(SCIENT_ASSET_URL_PLACEHOLDER);
    expect(redactScientAssetUrls(`/api%252Fassets%252F${capability}%252Freport.html%BROKEN`)).toBe(
      SCIENT_ASSET_URL_PLACEHOLDER,
    );
    expect(
      redactScientAssetUrls(
        `//127.0.0.1:3773/api%252Fassets%252F${capability}%252Freport.html%BROKEN`,
      ),
    ).toBe(SCIENT_ASSET_URL_PLACEHOLDER);
    expect(redactScientAssetUrls(`/%61%70%69%25%32%46assets%2F${capability}/x`)).toBe(
      SCIENT_ASSET_URL_PLACEHOLDER,
    );
    expect(redactScientAssetUrls(`/api%${"25".repeat(20)}2Fassets%2F${capability}/x`)).toBe(
      SCIENT_ASSET_URL_PLACEHOLDER,
    );
    expect(redactScientAssetUrls("https://example.org/ordinary/page")).toBe(
      "https://example.org/ordinary/page",
    );
    const snapshot = snapshotOf(
      thread({
        messages: [message({ id: "m1", role: "user", text: `${absolute} ${encodedRelative}` })],
      }),
    );
    expect(redactSnapshotStoragePaths(snapshot, []).messages[0]?.text).toBe(
      `${SCIENT_ASSET_URL_PLACEHOLDER} ${SCIENT_ASSET_URL_PLACEHOLDER}`,
    );
  });

  it("finds a root with either separator and Windows case", () => {
    expect(redactStoragePaths(`${POSIX_ROOT}/logs/a.log`, [POSIX_ROOT])).toBe(
      `${STORAGE_PATH_PLACEHOLDER}/logs/a.log`,
    );
    expect(
      redactStoragePaths("c:/users/BOB_SMITH/appdata/roaming/scient\\attachments", [WINDOWS_ROOT]),
    ).toBe(`${STORAGE_PATH_PLACEHOLDER}\\attachments`);
    expect(redactStoragePaths("/users/ALICE_NAME/*SCIENT*/USERDATA/logs/a.log", [POSIX_ROOT])).toBe(
      `${STORAGE_PATH_PLACEHOLDER}/logs/a.log`,
    );
  });

  it("matches a root only where its path ends", () => {
    const roots = ["/data", "C:\\Scient"];
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["/data", "«scient-data»"],
      ["/data/x.log", "«scient-data»/x.log"],
      ["(see /data)", "(see «scient-data»)"],
      ["(see /data), then", "(see «scient-data»), then"],
      ["It is in /data.", "It is in «scient-data»."],
      ["Try /data. Then", "Try «scient-data». Then"],
      ["\"/data\" and '/data'", "\"«scient-data»\" and '«scient-data»'"],
      ["/database", "/database"],
      ["/data.bak", "/data.bak"],
      ["/data!archive/x", "/data!archive/x"],
      ["/data(backup)/x", "/data(backup)/x"],
      ["/data-old /data2 /data_x /data:x", "/data-old /data2 /data_x /data:x"],
      ["C:\\Scient\\a", "«scient-data»\\a"],
      ["c:/scient/a", "«scient-data»/a"],
      ["in C:\\Scient.", "in «scient-data»."],
      ["C:\\ScientData\\b C:\\Scient(1)\\c", "C:\\ScientData\\b C:\\Scient(1)\\c"],
    ];
    for (const [text, redacted] of cases) expect(redactStoragePaths(text, roots)).toBe(redacted);
  });

  it("removes roots before Markdown escaping can change their spelling", () => {
    const source = thread({
      title: `Notes on ${POSIX_ROOT}`,
      messages: [
        message({
          id: "m1",
          role: "user",
          text: `See ${POSIX_ROOT}/state.sqlite and ${WINDOWS_ROOT}\\logs`,
        }),
        message({ id: "m2", role: "assistant", text: "Done", turnId: "t1" }),
      ],
      activities: [
        activity({
          id: "a1",
          kind: "runtime.warning",
          turnId: "t1",
          summary: `Could not read ${WINDOWS_ROOT}\\cache`,
          payload: { message: `Missing ${POSIX_ROOT}/cache/x_y` },
        }),
      ],
    });
    const snapshot = redactSnapshotStoragePaths(
      snapshotOf(source, { workLog: true, reasoning: false, throughMessageId: null }),
      [POSIX_ROOT, WINDOWS_ROOT],
    );
    const { markdown } = exportMarkdown(snapshot);
    for (const leaked of ["alice", "bob", "AppData", "userdata"]) {
      expect(markdown).not.toContain(leaked);
    }
    expect(markdown).toContain(`${STORAGE_PATH_PLACEHOLDER}/state.sqlite`);
    expect(snapshot.captured.threadId).toBe("thread-1");
  });
});
