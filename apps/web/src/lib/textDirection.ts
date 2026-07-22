// FILE: textDirection.ts
// Purpose: Resolves the base direction of natural-language text without letting
//          technical fragments or a single leading foreign word control a block.
// Layer: Web presentation utility

import { pathLooksLikeKnownFile } from "../file-icons";

export type ResolvedTextDirection = "ltr" | "rtl";
export type TextDirectionAttribute = ResolvedTextDirection | "auto";

export interface TextDirectionResolutionOptions {
  /** Weak conversational context, usually the most recent user-message direction. */
  readonly hint?: ResolvedTextDirection | undefined;
  /** Streaming text should resist changing away from its hint on one early word. */
  readonly provisional?: boolean | undefined;
}

interface DirectionalWordCounts {
  readonly ltr: number;
  readonly rtl: number;
}

// Unicode property escapes use the JavaScript engine's maintained Unicode data,
// avoiding the stale hand-written code-point ranges that previously misclassified
// digits and punctuation as RTL. These are the modern RTL scripts Scient needs to
// distinguish from the default LTR behavior of other letter scripts.
const RTL_SCRIPT_LETTER_PATTERN =
  /(?:\p{Script_Extensions=Hebrew}|\p{Script_Extensions=Arabic}|\p{Script_Extensions=Syriac}|\p{Script_Extensions=Thaana}|\p{Script_Extensions=Nko}|\p{Script_Extensions=Samaritan}|\p{Script_Extensions=Mandaic}|\p{Script_Extensions=Adlam}|\p{Script_Extensions=Hanifi_Rohingya}|\p{Script_Extensions=Yezidi}|\p{Script_Extensions=Mende_Kikakui})/u;
const LETTER_PATTERN = /\p{Letter}/u;
const DIRECTIONAL_WORD_PATTERN = /\p{Letter}[\p{Letter}\p{Mark}'\u2019\u05f3\u05f4-]*/gu;

// This stripping is only for deriving a weak direction hint from raw user text.
// Markdown blocks use semantic tree traversal instead, which can distinguish a
// human-readable link label from a bare URL or file chip without regex guessing.
const RAW_TECHNICAL_FRAGMENT_PATTERNS = [
  /```[\s\S]*?```/g,
  /`[^`\n]*`/g,
  /\b(?:https?|file):\/\/\S+/gi,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /(?:^|\s)(?:[@$][\w./:-]+|(?:~|\.{1,2})?[/\\]\S+|[A-Za-z]:\\\S+|[\w.-]+(?:[/\\][\w.@+~:-]+)+)(?=[,.;!?)}\]]*(?:\s|$))/g,
] as const;
const BARE_FILE_TOKEN_PATTERN =
  /(^|\s)([A-Za-z0-9_.-]+\.[A-Za-z][A-Za-z0-9]{0,9}(?::\d+(?::\d+)?)?)(?=[,.;!?)}\]]*(?:\s|$))/g;
const FILE_POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;

export function stripTechnicalTextFragments(text: string): string {
  let naturalText = text;
  for (const pattern of RAW_TECHNICAL_FRAGMENT_PATTERNS) {
    naturalText = naturalText.replace(pattern, " ");
  }
  return naturalText.replace(BARE_FILE_TOKEN_PATTERN, (match, prefix: string, candidate: string) =>
    pathLooksLikeKnownFile(candidate.replace(FILE_POSITION_SUFFIX_PATTERN, "")) ? prefix : match,
  );
}

function classifyWordDirection(word: string): ResolvedTextDirection | null {
  let ltrLetters = 0;
  let rtlLetters = 0;

  for (const character of word) {
    if (!LETTER_PATTERN.test(character)) {
      continue;
    }
    if (RTL_SCRIPT_LETTER_PATTERN.test(character)) {
      rtlLetters += 1;
    } else {
      ltrLetters += 1;
    }
  }

  if (ltrLetters === rtlLetters) {
    return null;
  }
  return rtlLetters > ltrLetters ? "rtl" : "ltr";
}

function countDirectionalWords(text: string): DirectionalWordCounts {
  let ltr = 0;
  let rtl = 0;

  for (const match of text.matchAll(DIRECTIONAL_WORD_PATTERN)) {
    const direction = classifyWordDirection(match[0]);
    if (direction === "rtl") {
      rtl += 1;
    } else if (direction === "ltr") {
      ltr += 1;
    }
  }

  return { ltr, rtl };
}

function dominantDirection(counts: DirectionalWordCounts): ResolvedTextDirection | null {
  if (counts.ltr === counts.rtl) {
    return null;
  }

  const direction = counts.rtl > counts.ltr ? "rtl" : "ltr";
  const winner = Math.max(counts.rtl, counts.ltr);
  const loser = Math.min(counts.rtl, counts.ltr);
  if (loser === 0 || winner / loser >= 1.5) {
    return direction;
  }
  return null;
}

export function resolveTextDirection(
  text: string,
  options: TextDirectionResolutionOptions = {},
): TextDirectionAttribute {
  const counts = countDirectionalWords(text);
  const hint = options.hint;

  // A conversational hint yields only when the opposite language is both
  // dominant and established by at least four words. Keep this threshold the
  // same during and after streaming so completion cannot flip unchanged text.
  if (hint) {
    const opposite = hint === "rtl" ? "ltr" : "rtl";
    const dominant = dominantDirection(counts);
    return dominant === opposite && counts[opposite] >= 4 ? opposite : hint;
  }

  return dominantDirection(counts) ?? hint ?? "auto";
}

export function resolveRawTextDirectionHint(text: string): ResolvedTextDirection | undefined {
  const direction = resolveTextDirection(stripTechnicalTextFragments(text));
  return direction === "auto" ? undefined : direction;
}
