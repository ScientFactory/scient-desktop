const STYLE_STATEMENT = /^\s*(?:style|classDef|linkStyle|cssClass)\b/iu;
const CSS_DECLARATION = /^\s*-?[a-z][a-z0-9-]*\s*:(?!:)/iu;

function statementsOf(line: string): string[] {
  const statements: string[] = [];
  let quoted = false;
  let start = 0;
  for (let at = 0; at < line.length; at += 1) {
    if (line[at] === '"') quoted = !quoted;
    else if (line[at] === ";" && !quoted) {
      statements.push(line.slice(start, at));
      start = at + 1;
    }
  }
  statements.push(line.slice(start));
  return statements;
}

/** Style-list declarations stay together; later node labels are not CSS. */
export function mermaidCssStatements(source: string): readonly string[] {
  const styles: string[] = [];
  for (const line of source.split(/\r\n?|\n/u)) {
    const statements = statementsOf(line);
    for (const [index, statement] of statements.entries()) {
      if (!STYLE_STATEMENT.test(statement)) continue;
      let css = statement;
      for (const next of statements.slice(index + 1)) {
        if (!CSS_DECLARATION.test(next) || STYLE_STATEMENT.test(next)) break;
        css += `;${next}`;
      }
      styles.push(css);
    }
  }
  return styles;
}
