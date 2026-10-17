/** A stored JSON string can be read without allocating its containing payload.
 * Decode escapes incrementally so UTF-16 offsets, including surrogate halves,
 * have exactly the same meaning as String.slice on the original source. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const JSON_FIELD_READ_BYTES = 64 * 1024;
export class JsonStringFieldReadError extends Schema.TaggedError<JsonStringFieldReadError>()(
  "JsonStringFieldReadError",
  { field: Schema.String, detail: Schema.String },
) {}

export const readJsonStringFieldPage = Effect.fn("ContextHistory.readStringPage")(function* <
  E,
>(input: {
  readonly field: "summary" | "summaryText";
  readonly offset: number;
  readonly maxChars: number;
  readonly read: (byteOffset: number, byteLength: number) => Effect.Effect<Uint8Array, E>;
  readonly onPage?: (text: string) => Effect.Effect<void, E>;
}) {
  if (input.onPage !== undefined && input.maxChars <= 0)
    return yield* new JsonStringFieldReadError({
      field: input.field,
      detail: "Streaming pages must have positive length.",
    });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteOffset = 0;
  let depth = 0;
  let keyExpected = false;
  let targetNext = false;
  let role: "key" | "target" | "skip" | undefined;
  let escaped = false;
  let unicode = "";
  let unicodeRemaining = 0;
  let keyPosition = 0;
  let keyMatches = true;
  let position = 0;
  const selected = new Uint16Array(input.maxChars + 2);
  let selectedChars = 0;
  const emit = (text: string) => {
    if (role === "key") {
      for (let at = 0; at < text.length; at++) {
        if (text[at] !== input.field[keyPosition++]) keyMatches = false;
      }
    } else if (role === "target") {
      for (let at = 0; at < text.length; at++) {
        if (position++ >= input.offset && selectedChars < selected.length) {
          selected[selectedChars++] = text.charCodeAt(at);
        }
      }
    }
  };
  const page = () => {
    const parts: Array<string> = [];
    const end = Math.min(selectedChars, input.maxChars);
    for (let at = 0; at < end; at += 4_096)
      parts.push(String.fromCharCode(...selected.subarray(at, Math.min(end, at + 4_096))));
    return {
      text: parts.join(""),
      nextTextOffset: selectedChars > input.maxChars ? input.offset + input.maxChars : null,
    };
  };
  while (true) {
    const bytes = yield* input.read(byteOffset, JSON_FIELD_READ_BYTES);
    if (bytes.byteLength === 0)
      return yield* new JsonStringFieldReadError({
        field: input.field,
        detail: "The requested source string is missing or incomplete.",
      });
    byteOffset += bytes.byteLength;
    const chunk = yield* Effect.try({
      try: () => decoder.decode(bytes, { stream: true }),
      catch: () =>
        new JsonStringFieldReadError({
          field: input.field,
          detail: "Invalid source JSON encoding.",
        }),
    });
    for (const char of chunk) {
      if (role !== undefined) {
        if (unicodeRemaining > 0) {
          if (!/^[0-9a-f]$/i.test(char))
            return yield* new JsonStringFieldReadError({
              field: input.field,
              detail: "Invalid JSON unicode escape.",
            });
          unicode += char;
          if (--unicodeRemaining === 0) {
            emit(String.fromCharCode(Number.parseInt(unicode, 16)));
            unicode = "";
          }
        } else if (escaped) {
          escaped = false;
          if (char === "u") unicodeRemaining = 4;
          else {
            const escape = (
              {
                '"': '"',
                "\\": "\\",
                "/": "/",
                b: "\b",
                f: "\f",
                n: "\n",
                r: "\r",
                t: "\t",
              } as const
            )[char as '"' | "\\" | "/" | "b" | "f" | "n" | "r" | "t"];
            if (escape === undefined)
              return yield* new JsonStringFieldReadError({
                field: input.field,
                detail: "Invalid JSON string escape.",
              });
            emit(escape);
          }
        } else if (char === "\\") escaped = true;
        else if (char === '"') {
          if (role === "target") {
            const last = page();
            if (input.onPage !== undefined) {
              if (last.text.length > 0) yield* input.onPage(last.text);
              return { text: "", nextTextOffset: null };
            }
            return last;
          }
          if (role === "key") targetNext = keyMatches && keyPosition === input.field.length;
          role = undefined;
        } else emit(char);
        while (selectedChars > input.maxChars) {
          if (input.onPage === undefined) return page();
          yield* input.onPage(page().text);
          selected.copyWithin(0, input.maxChars);
          selectedChars -= input.maxChars;
        }
        continue;
      }
      if (char === '"') {
        role = depth === 1 && keyExpected ? "key" : depth === 1 && targetNext ? "target" : "skip";
        keyPosition = 0;
        keyMatches = true;
        if (role === "target") targetNext = false;
      } else if (char === "{" || char === "[") {
        if (depth === 1 && targetNext)
          return yield* new JsonStringFieldReadError({
            field: input.field,
            detail: "The source field is not a string.",
          });
        depth++;
        if (depth === 1) keyExpected = true;
      } else if (char === "}" || char === "]") depth--;
      else if (depth === 1 && char === ",") {
        keyExpected = true;
        targetNext = false;
      } else if (depth === 1 && char === ":") keyExpected = false;
      else if (depth === 1 && targetNext && !/\s/.test(char))
        return yield* new JsonStringFieldReadError({
          field: input.field,
          detail: "The source field is not a string.",
        });
    }
    yield* Effect.yieldNow;
  }
});
