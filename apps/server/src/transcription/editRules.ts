import type { TranscriptionWord } from "@t3tools/contracts";

const tokens = (text: string) => text.match(/[\p{L}\p{M}\p{Nd}]+(?:['’][\p{L}\p{M}]+)*/gu) ?? [];
const scripts = [
  "Latin",
  "Hebrew",
  "Arabic",
  "Greek",
  "Cyrillic",
  "Han",
  "Hiragana",
  "Katakana",
  "Hangul",
  "Devanagari",
  "Bengali",
  "Thai",
  "Armenian",
  "Georgian",
  "Tamil",
  "Ethiopic",
].map((name) => new RegExp("\\p{Script=" + name + "}", "u"));
const script = (word: string) =>
  [
    ...new Set(
      [...word]
        .filter((c) => /\p{L}/u.test(c))
        .map((c) => scripts.findIndex((pattern) => pattern.test(c))),
    ),
  ].join(",");
const negation =
  /^(?:no|not|never|none|neither|nor|without|cannot|nobody|nothing|.*n['’]t|לא|אי|ללא|אין|בלי|בלתי|אל|אף|אינ(?:ו|ה|ם|ן|י|ך|נו|כם|כן)|لا|ما|لم|لن|لي(?:س|ست|سوا|سا|ستا|سن)|لس(?:ت|تم|تن|تما|نا)|غير|بدون|دون|مش)$/iu;
const numberWord =
  /^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirtee?n|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|hundred|thousand|million|billion|אפס|אחד|אחת|שניים|שנים|שתיים|שתי|שלוש|שלושה|ארבע|ארבעה|חמש|חמישה|שש|שישה|שבע|שבעה|שמונה|תשע|תשעה|עשר|עשרה|עשרים|מאה|אלף|صفر|واحد|واحدة|اثنان|اثنين|اثنتان|ثلاثة|أربعة|خمسة|ستة|سبعة|ثمانية|تسعة|عشرة|عشرين|مائة|مئة|ألف|مليون)$/iu;
const fold = (word: string) => word.normalize("NFC").toLowerCase();
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function protectedToken(word: string, pattern: RegExp) {
  let rest = word.normalize("NFD").replace(/\p{M}/gu, "");
  while (rest) {
    if (pattern.test(rest)) return true;
    const prefix = rest.match(/^(?:[ושבהכלמ]|ال|[وفبلك])/u)?.[0];
    if (!prefix) return false;
    rest = rest.slice(prefix.length);
  }
  return false;
}

function sentenceMarks(text: string) {
  return [...text.matchAll(/[.!?…؟۔。！？።׃]/gu)].map(({ 0: mark, index }) => [
    mark,
    tokens(text.slice(0, index)).length,
    text.slice(index + 1).trim().length === 0,
  ]);
}

function smallEdit(before: string, after: string) {
  const left = [...before];
  const right = [...after];
  if (Math.abs(left.length - right.length) > 2 || Math.min(left.length, right.length) < 3)
    return false;
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (const [index, char] of left.entries()) {
    const next = [index + 1];
    for (const [column, other] of right.entries()) {
      next.push(
        Math.min(row[column + 1]! + 1, next[column]! + 1, row[column]! + Number(char !== other)),
      );
    }
    row = next;
  }
  return row.at(-1)! <= 2;
}

export function safeEdit(
  before: string,
  after: string,
  words: readonly TranscriptionWord[],
  corroborated: boolean,
  nextText?: string,
) {
  const beforeMarks = sentenceMarks(before);
  const afterMarks = sentenceMarks(after);
  if (
    !same(beforeMarks, afterMarks) &&
    !(
      afterMarks.length === beforeMarks.length + 1 &&
      same(beforeMarks, afterMarks.slice(0, -1)) &&
      /[.!?…؟۔。！？።׃]$/u.test(after.trimEnd()) &&
      !/[.!?…؟۔。！？።׃]$/u.test(before.trimEnd()) &&
      nextText &&
      (/^\s*\n\s*\n/u.test(nextText) || /^\p{Lu}\p{Ll}+[ \t]/u.test(nextText.trimStart()))
    )
  )
    return;
  const left = tokens(before);
  const right = tokens(after);
  if (left.length === 0 || left.length !== right.length) return;
  if (
    !same(
      left.filter((word) => protectedToken(word, negation)),
      right.filter((word) => protectedToken(word, negation)),
    )
  )
    return;
  const digits = (text: string) => text.match(/[\p{Nd}]+/gu) ?? [];
  if (!same(digits(before), digits(after))) return;
  if (
    !same(
      left.filter((word) => protectedToken(word, numberWord)),
      right.filter((word) => protectedToken(word, numberWord)),
    )
  )
    return;
  const notation = (text: string) =>
    text
      .replace(/(?<=\p{L})['’](?=\p{L})/gu, "")
      .match(
        /[^\p{L}\p{M}\p{Nd}\s.,!?،؟。！？…۔።׃]|[.,،](?=\p{Nd})|(?<=\p{Nd})[.,،](?=\s*\p{Nd})/gu,
      ) ?? [];
  if (!same(notation(before), notation(after))) return;
  // When notation is present, a moved operator can change meaning even if its characters match.
  if (notation(before).length && before !== after) return;
  const leftFolded = left.map(fold);
  const rightFolded = right.map(fold);
  const glossaryIndices = new Set<number>();
  for (const word of words) {
    if (!word.preferred) continue;
    const preferred = tokens(word.preferred);
    for (const variant of [word.term, ...(word.variants ?? [])]) {
      const original = tokens(variant).map(fold);
      if (!original.length || original.length !== preferred.length) continue;
      for (let start = 0; start <= left.length - original.length; start++) {
        if (
          original.every(
            (value, index) =>
              leftFolded[start + index] === value && right[start + index] === preferred[index],
          )
        ) {
          for (let index = start; index < start + original.length; index++)
            glossaryIndices.add(index);
        }
      }
    }
  }
  let reason = "case or punctuation";
  for (const [index, original] of left.entries()) {
    const replacement = right[index]!;
    if (original === replacement) continue;
    const old = leftFolded[index]!;
    const next = rightFolded[index]!;
    if (
      script(original) !== script(replacement) ||
      script(original).includes("-1") ||
      /\p{Nd}/u.test(original + replacement)
    )
      return;
    const preferred = glossaryIndices.has(index);
    if (old === next) {
      if (/\p{Lu}/u.test(original.slice(1) + replacement.slice(1)) && !preferred) return;
      continue;
    }
    if (leftFolded.includes(next) || rightFolded.includes(old)) return;
    if (preferred) {
      reason = "preferred glossary spelling";
      continue;
    }
    if (/\p{Lu}/u.test(original + replacement)) return;
    if (!smallEdit(old, next)) return;
    reason = corroborated ? "corroborated by re-listen" : "small spelling repair";
  }
  return reason;
}
