import { describe, expect, it } from "@effect/vitest";

import { Redactor, redactSection } from "./shareRedaction.ts";

const SAVED = "hunter2-correct-horse";
const make = (keep: ReadonlyArray<string> = []) =>
  new Redactor({
    savedSecrets: [SAVED, "short"],
    keep,
    idKey: new Uint8Array(32).fill(7),
    scope: "thread-1",
  });
const at = { field: "message", itemId: "m1" } as const;

describe("share redaction", () => {
  it("blanks saved values, including their URL-encoded and base64 forms", () => {
    const redactor = make();
    const base64 = Buffer.from(SAVED).toString("base64").replace(/=+$/u, "");
    const text = `pw ${SAVED}, url ${encodeURIComponent(SAVED)}, b64 ${base64}, short`;
    expect(redactor.redact(text, at)).toBe("pw [redacted], url [redacted], b64 [redacted], short");
    const [entry] = redactor.report().redactions;
    expect(entry?.kind).toBe("saved-secret");
    expect(JSON.stringify(redactor.report())).not.toContain(SAVED);
  });

  it.each([
    ["GitHub token", `token ghp_${"a".repeat(36)} end`, "token [redacted] end"],
    ["API key", `key sk-proj-${"b".repeat(40)} end`, "key [redacted] end"],
    ["AWS access key", "AKIAABCDEFGHIJKLMNOP here", "[redacted] here"],
    ["Slack token", "xoxb-1234567890-abcdef", "[redacted]"],
    ["Google API key", `AIza${"c".repeat(35)}`, "[redacted]"],
    ["Bearer token", `Authorization: Bearer ${"d".repeat(30)}`, "Authorization: Bearer [redacted]"],
    [
      "Web token",
      `jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${"e".repeat(20)}`,
      "jwt [redacted]",
    ],
    [
      "Password in a link",
      "git clone https://alice:s3cretpass@example.org/repo.git",
      "git clone https://alice:[redacted]@example.org/repo.git",
    ],
    [
      "Secret in a link",
      "https://x.test/cb?token=abc123def&x=1",
      "https://x.test/cb?token=[redacted]&x=1",
    ],
    [
      "Private key",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAB3Nza\n-----END OPENSSH PRIVATE KEY-----",
      "[redacted]",
    ],
  ])("blanks a %s", (label, text, expected) => {
    const redactor = make();
    expect(redactor.redact(text, at)).toBe(expected);
    expect(redactor.report().redactions.map((entry) => entry.label)).toEqual([label]);
  });

  it("replaces emails and home folders but leaves git remotes and ordinary paths", () => {
    const redactor = make();
    expect(
      redactor.redact(
        "Mail ada@lab.example.org about /Users/ada/data/run.csv, C:\\Users\\ada\\x.txt, /home/bob/y and git@github.com:acme/lab /opt/tools",
        at,
      ),
    ).toBe(
      "Mail [email] about ~/data/run.csv, ~\\x.txt, ~/y and git@github.com:acme/lab /opt/tools",
    );
  });

  it("keeps an item the person chose to keep, under the same id on a rebuild", () => {
    const first = make();
    first.redact("mail ada@lab.example.org", at);
    const id = first.report().redactions[0]!.id;
    const second = make([id]);
    expect(second.redact("mail ada@lab.example.org", at)).toBe("mail ada@lab.example.org");
    expect(second.report().kept.map((entry) => entry.id)).toEqual([id]);
    expect(second.report().redactions).toEqual([]);
  });

  it("walks a snapshot section's text but leaves ids, times and enums", () => {
    const redactor = make();
    const messages = redactSection(redactor, "messages", [
      {
        id: "message-ada@lab.example.org",
        role: "user",
        createdAt: "2026-11-10T10:00:00.000Z",
        text: `see ${SAVED}`,
        attachments: [
          { localId: "a1", name: "notes for ada@lab.example.org", mimeType: "text/csv" },
        ],
      },
    ]);
    expect(messages[0]).toEqual({
      id: "message-ada@lab.example.org",
      role: "user",
      createdAt: "2026-11-10T10:00:00.000Z",
      text: "see [redacted]",
      attachments: [{ localId: "a1", name: "notes for [email]", mimeType: "text/csv" }],
    });
    const locations = redactor.report().redactions.flatMap((entry) => entry.locations);
    expect(locations).toContainEqual({
      field: "attachment",
      itemId: "message-ada@lab.example.org",
    });
    expect(locations).toContainEqual({ field: "message", itemId: "message-ada@lab.example.org" });
  });
});
