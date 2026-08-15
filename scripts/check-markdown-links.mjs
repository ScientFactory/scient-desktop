import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

const INLINE_LINK = /!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^)]*["'])?\)/g;
const REFERENCE_LINK = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm;
const EXTERNAL_OR_ANCHOR = /^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i;
const IGNORE_NEXT_LINE = "<!-- markdown-link-check: ignore-next-line -->";

function unwrapDestination(destination) {
  return destination.startsWith("<") && destination.endsWith(">")
    ? destination.slice(1, -1)
    : destination;
}

function lineNumberAt(markdown, index) {
  return markdown.slice(0, index).split("\n").length;
}

function maskExcludedMarkdown(markdown) {
  let openFence = null;
  let ignoreNextLine = false;

  return markdown
    .split("\n")
    .map((line) => {
      if (openFence) {
        const closingFence = line.match(/^ {0,3}(`{3,}|~{3,})[\t ]*$/);
        if (
          closingFence &&
          closingFence[1][0] === openFence.character &&
          closingFence[1].length >= openFence.length
        ) {
          openFence = null;
        }
        return " ".repeat(line.length);
      }

      if (ignoreNextLine) {
        if (line.trim() === "") return line;
        ignoreNextLine = false;
        return " ".repeat(line.length);
      }

      if (line.trim() === IGNORE_NEXT_LINE) {
        ignoreNextLine = true;
        return " ".repeat(line.length);
      }

      const openingFence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (openingFence) {
        openFence = {
          character: openingFence[1][0],
          length: openingFence[1].length,
        };
        return " ".repeat(line.length);
      }

      return line;
    })
    .join("\n");
}

export function markdownDestinations(markdown) {
  const checkableMarkdown = maskExcludedMarkdown(markdown);
  const destinations = [];
  for (const pattern of [INLINE_LINK, REFERENCE_LINK]) {
    pattern.lastIndex = 0;
    for (const match of checkableMarkdown.matchAll(pattern)) {
      destinations.push({
        destination: unwrapDestination(match[1]),
        line: lineNumberAt(checkableMarkdown, match.index),
      });
    }
  }
  return destinations;
}

export function resolveLocalDestination(markdownFile, destination, repositoryRoot) {
  if (EXTERNAL_OR_ANCHOR.test(destination)) return null;

  const pathWithoutQueryOrFragment = destination.split(/[?#]/, 1)[0];
  if (!pathWithoutQueryOrFragment) return null;

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathWithoutQueryOrFragment);
  } catch {
    return { error: `invalid URL encoding in ${destination}` };
  }

  const resolved = decodedPath.startsWith("/")
    ? NodePath.resolve(repositoryRoot, `.${decodedPath}`)
    : NodePath.resolve(NodePath.dirname(markdownFile), decodedPath);
  const relative = NodePath.relative(repositoryRoot, resolved);
  if (relative.startsWith("..") || NodePath.isAbsolute(relative)) {
    return { error: `target escapes the repository: ${destination}` };
  }
  return { resolved };
}

export function checkMarkdownFile(markdownFile, repositoryRoot = NodeProcess.cwd()) {
  const markdown = NodeFS.readFileSync(markdownFile, "utf8");
  const failures = [];
  for (const { destination, line } of markdownDestinations(markdown)) {
    const local = resolveLocalDestination(markdownFile, destination, repositoryRoot);
    if (local === null) continue;
    if (local.error) {
      failures.push(`${markdownFile}:${line}: ${local.error}`);
      continue;
    }
    if (!NodeFS.existsSync(local.resolved)) {
      failures.push(`${markdownFile}:${line}: missing local target ${destination}`);
    }
  }
  return failures;
}

function main(files) {
  if (files.length === 0) {
    console.error("Usage: node scripts/check-markdown-links.mjs <markdown-file> [...]");
    return 2;
  }

  const failures = files.flatMap((file) => checkMarkdownFile(NodePath.resolve(file)));
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    return 1;
  }
  console.log(`Checked local Markdown links in ${files.length} file(s).`);
  return 0;
}

if (NodeURL.fileURLToPath(import.meta.url) === NodePath.resolve(NodeProcess.argv[1] ?? "")) {
  NodeProcess.exit(main(NodeProcess.argv.slice(2)));
}
