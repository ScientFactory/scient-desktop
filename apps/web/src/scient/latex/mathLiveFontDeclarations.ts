const LEGACY_MATH_FONTS: Readonly<Record<string, string>> = {
  rm: "mathrm",
  bf: "mathbf",
  it: "mathit",
  sf: "mathsf",
  tt: "mathtt",
  cal: "mathcal",
};

/** Adapt TeX's scoped font declarations for MathLive, without changing stored source. */
export function mathLiveFontDeclarations(source: string): string {
  if (!/\\(?:rm|bf|it|sf|tt|cal)\b/u.test(source) || source.length > 65536) return source;
  let at = 0;
  let invalid = false;
  const group = (nested: boolean, depth: number, literal = false): string => {
    if (depth > 128) {
      invalid = true;
      at = source.length;
      return "";
    }
    let result = "";
    let fontOpen = false;
    const closeFont = () => {
      if (fontOpen) result += "}";
      fontOpen = false;
    };
    while (at < source.length) {
      const character = source[at++]!;
      if (character === "}") {
        closeFont();
        if (!nested) invalid = true;
        return result;
      }
      if (character === "{") {
        result += `{${group(true, depth + 1, literal)}}`;
      } else if (character === "%") {
        const end = source.indexOf("\n", at);
        result += character + source.slice(at, end < 0 ? source.length : end + 1);
        at = end < 0 ? source.length : end + 1;
      } else if (character === "\\") {
        const token = /^[A-Za-z]+|[^\r\n]/u.exec(source.slice(at))?.[0] ?? "";
        at += token.length;
        const font = !literal && LEGACY_MATH_FONTS[token];
        if (font) {
          closeFont();
          result += `\\${font}{`;
          fontOpen = true;
          while (/\s/u.test(source[at] ?? "") && at < source.length) at++;
        } else {
          // Alignment cells have their own scope. Escaped braces/ampersands are tokens.
          if (token === "\\") closeFont();
          result += `\\${token}`;
          if (/^(?:text(?:rm|sf|tt|bf|it|normal)?|operatorname)$/u.test(token)) {
            const argument = /^\*?\s*\{/u.exec(source.slice(at));
            if (argument) {
              result += argument[0];
              at += argument[0].length;
              result += group(true, depth + 1, true) + "}";
            }
          }
        }
      } else {
        if (character === "&") closeFont();
        result += character;
      }
    }
    if (nested) invalid = true;
    closeFont();
    return result;
  };
  const result = group(false, 0);
  return invalid ? source : result;
}
