// @effect-diagnostics nodeBuiltinImport:off -- Redaction ids are keyed hashes; Node's crypto computes them synchronously.
import * as NodeCrypto from "node:crypto";

import type {
  ScientCloudRedaction,
  ScientCloudRedactionField,
  ScientCloudRedactionKind,
} from "@t3tools/contracts";

/**
 * Finds what must not leave the computer in a share: saved secret values (exact match, with
 * their URL-encoded and base64 forms), token-shaped strings, email addresses and home folder
 * paths. Reports where each was found, never the value.
 */

const SAVED_SECRET_MIN_LENGTH = 6;
const SECRET_REPLACEMENT = "[redacted]";
const EMAIL_REPLACEMENT = "[email]";
const HOME_REPLACEMENT = "~";

interface Detector {
  readonly kind: ScientCloudRedactionKind;
  readonly label: string;
  readonly replacement: string;
  readonly pattern: RegExp;
}

const secret = (label: string, pattern: RegExp): Detector => ({
  kind: "secret-pattern",
  label,
  replacement: SECRET_REPLACEMENT,
  pattern,
});

const home = (pattern: RegExp): Detector => ({
  kind: "home-path",
  label: "Home folder path",
  replacement: HOME_REPLACEMENT,
  pattern,
});

/** Earlier detectors win where matches overlap. */
const PATTERN_DETECTORS: ReadonlyArray<Detector> = [
  secret(
    "Private key",
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  ),
  secret("Web token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g),
  secret("API key", /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g),
  secret("GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g),
  secret("Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g),
  secret("AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g),
  secret("Google API key", /\bAIza[0-9A-Za-z_-]{35}/g),
  secret("Bearer token", /(?<=\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/g),
  secret("Password in a link", /(?<=\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/gi),
  secret(
    "Secret in a link",
    /(?<=[?&](?:password|passwd|pwd|token|access_token|api_key|apikey|secret|key)=)[^\s&#"']+/gi,
  ),
  {
    kind: "email",
    label: "Email address",
    replacement: EMAIL_REPLACEMENT,
    pattern: /\b(?!git@)[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
  },
  home(/(?:file:\/\/)?\/(?:Users|home)\/[^/\s"'`<>()[\]{}]+/g),
  home(/\b[A-Za-z]:\\Users\\[^\\\s"'`<>()[\]{}]+/gi),
  home(/\\\\[^\\\s"'`]+\\[^\\\s"'`]+/g),
];

export interface SavedSecret {
  readonly value: string;
}

/** Search forms of each saved value, longest first so a longer value claims its text first. */
function savedSecretNeedles(values: ReadonlyArray<string>): ReadonlyArray<string> {
  const needles = new Set<string>();
  for (const value of values) {
    if (value.length < SAVED_SECRET_MIN_LENGTH) continue;
    needles.add(value);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) needles.add(encoded);
    needles.add(Buffer.from(value, "utf8").toString("base64").replace(/=+$/u, ""));
  }
  return [...needles].toSorted((a, b) => b.length - a.length);
}

interface Match {
  readonly start: number;
  readonly end: number;
  readonly kind: ScientCloudRedactionKind;
  readonly label: string;
  readonly replacement: string;
  readonly value: string;
}

export interface RedactionLocation {
  readonly field: ScientCloudRedactionField;
  readonly itemId: string | null;
}

/**
 * One share build's redaction pass. Ids are keyed by a per-run secret and the thread, so the
 * same value keeps its id across rebuilds (un-redacting) but cannot be guessed from outside.
 */
export class Redactor {
  readonly #needles: ReadonlyArray<string>;
  readonly #keep: ReadonlySet<string>;
  readonly #idKey: Uint8Array;
  readonly #scope: string;
  readonly #found = new Map<string, ScientCloudRedaction & { locations: RedactionLocation[] }>();

  constructor(input: {
    readonly savedSecrets: ReadonlyArray<string>;
    readonly keep: ReadonlyArray<string>;
    readonly idKey: Uint8Array;
    readonly scope: string;
  }) {
    this.#needles = savedSecretNeedles(input.savedSecrets);
    this.#keep = new Set(input.keep);
    this.#idKey = input.idKey;
    this.#scope = input.scope;
  }

  get savedSecretCount(): number {
    return this.#needles.length;
  }

  #id(kind: string, value: string): string {
    return NodeCrypto.createHmac("sha256", this.#idKey)
      .update(`${this.#scope}\u0000${kind}\u0000${value}`)
      .digest("base64url")
      .slice(0, 22);
  }

  #matches(text: string): Match[] {
    const found: Match[] = [];
    for (const needle of this.#needles) {
      let at = text.indexOf(needle);
      while (at !== -1) {
        found.push({
          start: at,
          end: at + needle.length,
          kind: "saved-secret",
          label: "Saved secret",
          replacement: SECRET_REPLACEMENT,
          value: needle,
        });
        at = text.indexOf(needle, at + needle.length);
      }
    }
    for (const detector of PATTERN_DETECTORS) {
      for (const match of text.matchAll(detector.pattern)) {
        if (match[0].length === 0) continue;
        found.push({
          start: match.index,
          end: match.index + match[0].length,
          kind: detector.kind,
          label: detector.label,
          replacement: detector.replacement,
          value: match[0],
        });
      }
    }
    // Keep the first claimant of each span: saved values, then detectors in order.
    const accepted: Match[] = [];
    for (const match of found) {
      if (accepted.some((other) => match.start < other.end && other.start < match.end)) continue;
      accepted.push(match);
    }
    return accepted.toSorted((a, b) => a.start - b.start);
  }

  /** Whether `redact` would change anything in the text. */
  holdsPrivateText(text: string): boolean {
    return this.#matches(text).length > 0;
  }

  /** Records a whole item (a text attachment) left out because it holds private text. */
  excludeItem(location: RedactionLocation, label: string): boolean {
    const id = this.#id("attachment", `${location.field}:${location.itemId ?? ""}`);
    const kept = this.#keep.has(id);
    this.#record(id, { kind: "attachment", label, replacement: "" }, location);
    return !kept;
  }

  #record(
    id: string,
    what: { kind: ScientCloudRedactionKind; label: string; replacement: string },
    location: RedactionLocation,
  ) {
    const existing = this.#found.get(id);
    if (existing === undefined) {
      this.#found.set(id, {
        id,
        kind: what.kind,
        label: what.label,
        replacement: what.replacement,
        count: 1,
        locations: [location],
      });
      return;
    }
    existing.locations.push(location);
    this.#found.set(id, { ...existing, count: existing.count + 1 });
  }

  redact(text: string, location: RedactionLocation): string {
    const matches = this.#matches(text);
    if (matches.length === 0) return text;
    let out = "";
    let cursor = 0;
    for (const match of matches) {
      const id = this.#id(match.kind, match.value);
      this.#record(
        id,
        { kind: match.kind, label: match.label, replacement: match.replacement },
        location,
      );
      if (this.#keep.has(id)) continue;
      out += text.slice(cursor, match.start) + match.replacement;
      cursor = match.end;
    }
    return out + text.slice(cursor);
  }

  report(): { redactions: ScientCloudRedaction[]; kept: ScientCloudRedaction[] } {
    const redactions: ScientCloudRedaction[] = [];
    const kept: ScientCloudRedaction[] = [];
    for (const entry of this.#found.values()) {
      const locations = dedupeLocations(entry.locations);
      (this.#keep.has(entry.id) ? kept : redactions).push({ ...entry, locations });
    }
    return { redactions, kept };
  }
}

function dedupeLocations(locations: ReadonlyArray<RedactionLocation>): RedactionLocation[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = `${location.field}\u0000${location.itemId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const SKIPPED_KEY =
  /(?:^id$|Id$|At$|^n$|^_tag$|^format$|^version$|^contentDigest$|^kind$|^role$|^status$|^level$|^itemType$|^provider$|^model$|^sizeBytes$)/u;

const FIELD_OF: Record<string, ScientCloudRedactionField> = {
  thread: "title",
  provenance: "title",
  sidecar: "title",
  warnings: "attachment",
  messages: "message",
  reasoning: "reasoning",
  workLog: "work-log",
  proposedPlans: "plan",
  questionAnswers: "question-answer",
};

/** Redacts every text value of a JSON-shaped snapshot section, keeping ids, times and enums. */
export function redactSection<T>(redactor: Redactor, section: string, value: T): T {
  const field = FIELD_OF[section];
  if (field === undefined) return value;
  const walk = (node: unknown, itemId: string | null, inAttachment: boolean): unknown => {
    if (typeof node === "string") {
      return redactor.redact(node, { field: inAttachment ? "attachment" : field, itemId });
    }
    if (Array.isArray(node)) return node.map((child) => walk(child, itemId, inAttachment));
    if (node === null || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      out[key] = SKIPPED_KEY.test(key)
        ? child
        : walk(child, itemId, inAttachment || key === "attachments");
    }
    return out;
  };
  if (Array.isArray(value)) {
    return value.map((item) =>
      walk(item, typeof item?.id === "string" ? item.id : null, false),
    ) as T;
  }
  return walk(value, null, false) as T;
}
