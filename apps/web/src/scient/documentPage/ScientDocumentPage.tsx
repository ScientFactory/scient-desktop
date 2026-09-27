import {
  DOCUMENT_ASSET_URL_PREFIX,
  type ScientDocumentPageAsset,
  type ScientDocumentPageInput,
} from "@t3tools/contracts";
import {
  Children,
  createContext,
  isValidElement,
  use,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type Options as ReactMarkdownOptions,
} from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

import { resolveMarkdownDirection } from "../bidi/contentDirection";
import { rehypeScientBidi } from "../bidi/rehypeScientBidi";
import { renderMermaidDiagram } from "../diagrams/mermaidRuntime";
import { isScientMathCodeClassName } from "../math/remarkScientMath";
import { renderCachedScientMath } from "../math/ScientMath";
import { useScientMathMarkdownText, useScientMathRemarkPlugins } from "../math/scientMathText";
import { resolveScientRichFenceKind } from "../presentation/scientRichFenceKind";
import { scientMarkdownRemarkPlugins } from "../markdown/scientMarkdownProfiles";
import type { DocumentPageTracker } from "./documentPageReadiness";

import "../bidi/scient-bidi.css";
import "../math/scient-math.css";
import "./scient-document-page.css";

/**
 * The document page: one complete, non-virtualized, print-ready rendering of
 * a captured document bundle. It shares chat's Markdown grammar, math, Mermaid
 * runtime, and bidirectional text handling, but none of chat's interaction:
 * links to files, citations, and chips print as plain text, and nothing here
 * talks to a Scient server beyond the capture it was given.
 */

type KatexRuntime = typeof import("../math/katexRuntime");

interface DocumentPageContext {
  readonly assets: ReadonlyMap<string, ScientDocumentPageAsset>;
  readonly assetBaseUrl: URL;
  readonly katex: KatexRuntime;
  readonly tracker: DocumentPageTracker;
}

const DocumentPageContextValue = createContext<DocumentPageContext | null>(null);

function useDocumentPage(): DocumentPageContext {
  const context = use(DocumentPageContextValue);
  if (context === null) throw new Error("The document page context is missing.");
  return context;
}

/** Code blocks up to this many lines are kept on one page; longer ones may split. */
export const SHORT_CODE_BLOCK_LINES = 18;

interface HastNode {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** GitHub-style safe HTML, plus the attributes Scient's own Markdown emits. */
const DOCUMENT_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), "dataAlert"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "scient-asset"],
    src: [...(defaultSchema.protocols?.src ?? []), "scient-asset", "data"],
  },
} satisfies Parameters<typeof rehypeSanitize>[0];

const ALLOWED_TAGS = new Set(DOCUMENT_SANITIZE_SCHEMA.tagNames ?? []);

/** Reports raw HTML elements the sanitizer is about to remove, before it removes them. */
function rehypeReportUnsupportedHtml(options: { readonly tracker: DocumentPageTracker }) {
  return (tree: HastNode) => {
    const visit = (node: HastNode) => {
      if (node.type === "element" && node.tagName && !ALLOWED_TAGS.has(node.tagName)) {
        options.tracker.warn(
          "raw-html-sanitized",
          `HTML <${node.tagName}> is not supported in exported documents and was left out.`,
        );
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

/** A document without its own level-one heading gets its title as one, for the outline. */
function rehypeEnsureTitle(options: { readonly title: string }) {
  return (tree: HastNode) => {
    const hasTitle = (node: HastNode): boolean =>
      (node.type === "element" && node.tagName === "h1") || (node.children ?? []).some(hasTitle);
    if (hasTitle(tree)) return;
    tree.children = [
      {
        type: "element",
        tagName: "h1",
        properties: { className: ["scient-document-title"] },
        children: [{ type: "text", value: options.title } as HastNode],
      },
      ...(tree.children ?? []),
    ];
  };
}

function urlTransform(url: string): string {
  if (url.startsWith(DOCUMENT_ASSET_URL_PREFIX) || /^data:image\//iu.test(url)) return url;
  return defaultUrlTransform(url);
}

function plainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(plainText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return plainText(node.props.children);
  return "";
}

function codeBlockOf(children: ReactNode): { language: string; code: string } | null {
  const nodes = Children.toArray(children);
  const only = nodes[0];
  if (nodes.length !== 1 || !isValidElement<{ className?: string; children?: ReactNode }>(only)) {
    return null;
  }
  const className = only.props.className ?? "";
  if (isScientMathCodeClassName(className)) return { language: "math", code: plainText(only) };
  const language = /(?:^|\s)language-([^\s]+)/u.exec(className)?.[1] ?? "";
  return { language, code: plainText(only.props.children).replace(/\n$/u, "") };
}

function PrintMath({ tex, display }: { readonly tex: string; readonly display: boolean }) {
  const { katex, tracker } = useDocumentPage();
  const html = renderCachedScientMath(katex, tex, display);
  const kind = display ? "display" : "inline";
  if (html === null) {
    tracker.warn(
      "math-unrendered",
      `Math "${tex.length > 80 ? `${tex.slice(0, 80)}…` : tex}" could not be typeset and is shown as TeX.`,
    );
    return (
      <code className="scient-document-math-source" dir="ltr" data-scient-math={kind}>
        {display ? `$$${tex}$$` : `$${tex}$`}
      </code>
    );
  }
  // KaTeX escapes its own input, so its output is the only markup injected here.
  return (
    <span
      className={display ? "scient-math-display" : "scient-math-inline"}
      dir="ltr"
      data-scient-math={kind}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

type DiagramState =
  | { readonly status: "pending" }
  | { readonly status: "rendered"; readonly svg: string }
  | { readonly status: "failed"; readonly message: string };

function PrintMermaid({ source }: { readonly source: string }) {
  const { tracker } = useDocumentPage();
  const [finish] = useState(() => tracker.track());
  const [state, setState] = useState<DiagramState>({ status: "pending" });
  useEffect(() => {
    let active = true;
    renderMermaidDiagram(source, "light").then(
      (rendered) => {
        if (active) setState({ status: "rendered", svg: rendered.svg });
      },
      (cause: unknown) => {
        const message = cause instanceof Error ? cause.message : "Mermaid could not render it.";
        tracker.warn("diagram-failed", `A Mermaid diagram could not be rendered: ${message}`);
        if (active) setState({ status: "failed", message });
      },
    );
    return () => {
      active = false;
    };
  }, [source, tracker]);
  useEffect(() => {
    if (state.status !== "pending") finish();
  }, [finish, state.status]);

  if (state.status === "rendered") {
    return (
      <figure
        className="scient-document-diagram"
        data-scient-diagram="rendered"
        // Mermaid renders with its strict security level; the SVG carries no script.
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    );
  }
  return (
    <figure className="scient-document-diagram" data-scient-diagram={state.status}>
      {state.status === "failed" ? (
        <figcaption className="scient-document-placeholder-label">
          Diagram could not be rendered; its Mermaid source follows.
        </figcaption>
      ) : null}
      <pre className="scient-document-code-body">
        <code>{source}</code>
      </pre>
    </figure>
  );
}

function PrintCodeBlock(props: { readonly language: string; readonly code: string }) {
  const lines = props.code.split("\n").length;
  return (
    <figure
      className="scient-document-code"
      data-scient-code-block=""
      data-short={lines <= SHORT_CODE_BLOCK_LINES ? "" : undefined}
    >
      {props.language ? (
        <figcaption className="scient-document-code-label">{props.language}</figcaption>
      ) : null}
      <pre className="scient-document-code-body" dir="ltr">
        <code>{props.code}</code>
      </pre>
    </figure>
  );
}

function Placeholder({ label }: { readonly label: string }) {
  return (
    <span className="scient-document-placeholder" role="img" aria-label={label}>
      {label}
    </span>
  );
}

const UNAVAILABLE_REASONS: Readonly<Record<string, string>> = {
  missing: "not found",
  unreadable: "could not be read",
  unsupported: "not a supported image",
  "too-large": "too large to include",
};

function PrintImage({
  src,
  alt,
  title,
}: {
  readonly src: string;
  readonly alt: string;
  readonly title: string | undefined;
}) {
  const { assets, assetBaseUrl, tracker } = useDocumentPage();
  const [finish] = useState(() => tracker.track());
  const asset = src.startsWith(DOCUMENT_ASSET_URL_PREFIX)
    ? assets.get(src.slice(DOCUMENT_ASSET_URL_PREFIX.length))
    : undefined;
  const resolved =
    asset?.content._tag === "captured"
      ? new URL(asset.content.path, assetBaseUrl).toString()
      : /^data:image\//iu.test(src)
        ? src
        : null;
  useEffect(() => {
    if (resolved === null) finish();
  }, [finish, resolved]);

  if (resolved === null) {
    const name = asset?.fileName ?? (alt || src);
    if (asset?.content._tag === "unavailable") {
      return (
        <Placeholder
          label={`Image unavailable: ${name} (${UNAVAILABLE_REASONS[asset.content.reason] ?? asset.content.reason})`}
        />
      );
    }
    if (/^(?:https?:)?\/\//iu.test(src)) {
      tracker.warn(
        "remote-image-omitted",
        `Remote image "${src}" was not downloaded into the PDF.`,
      );
      return <Placeholder label={`Remote image not included: ${src}`} />;
    }
    tracker.warn("missing-image", `Image "${src}" was not available to the export.`);
    return <Placeholder label={`Image unavailable: ${name}`} />;
  }
  return (
    <span className="scient-document-image">
      <img
        src={resolved}
        alt={alt}
        data-scient-asset={asset?.id}
        onLoad={finish}
        onError={finish}
      />
      {title ? <span className="scient-document-image-caption">{title}</span> : null}
    </span>
  );
}

function PrintLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  const { assets } = useDocumentPage();
  if (href.startsWith(DOCUMENT_ASSET_URL_PREFIX)) {
    const asset = assets.get(href.slice(DOCUMENT_ASSET_URL_PREFIX.length));
    return (
      <span className="scient-document-attachment">
        {children}
        {asset ? ` (attachment: ${asset.fileName})` : " (attachment)"}
      </span>
    );
  }
  // Web and in-document links survive as PDF link annotations. Links into the
  // workspace, citations, and chips are meaningful only inside Scient.
  if (/^(?:https?:|mailto:)/iu.test(href) || href.startsWith("#")) {
    return <a href={href}>{children}</a>;
  }
  return <span className="scient-document-inert-link">{children}</span>;
}

const COMPONENTS = {
  code: function DocumentCode({ node: _node, className, children }) {
    if (isScientMathCodeClassName(className)) {
      return <PrintMath tex={plainText(children)} display={false} />;
    }
    return (
      <code className={className} dir="ltr">
        {children}
      </code>
    );
  },
  pre: function DocumentPre({ node: _node, children }) {
    const { tracker } = useDocumentPage();
    const block = codeBlockOf(children);
    if (block === null) return <pre className="scient-document-code-body">{children}</pre>;
    if (block.language === "math") return <PrintMath tex={block.code} display />;
    const richKind = resolveScientRichFenceKind(block.language);
    if (richKind === "mermaid") return <PrintMermaid source={block.code} />;
    if (richKind !== null) {
      tracker.warn(
        "unsupported-diagram-language",
        `An interactive ${richKind === "plotly" ? "Plotly" : "Vega-Lite"} chart is printed as its source.`,
      );
    }
    return <PrintCodeBlock language={block.language} code={block.code} />;
  },
  img: function DocumentImage({ node: _node, src, alt, title }) {
    return <PrintImage src={typeof src === "string" ? src : ""} alt={alt ?? ""} title={title} />;
  },
  a: function DocumentLink({ node: _node, href, children }) {
    return <PrintLink href={href ?? ""}>{children}</PrintLink>;
  },
  details: function DocumentDetails({ node: _node, children }) {
    // Paper cannot collapse; details print expanded.
    return <details open>{children}</details>;
  },
  table: function DocumentTable({ node: _node, children, dir }) {
    return (
      <div className="scient-document-table">
        <table dir={dir}>{children}</table>
      </div>
    );
  },
} satisfies Components;

export interface ScientDocumentPageProps {
  readonly input: ScientDocumentPageInput;
  readonly inputUrl: URL;
  readonly katex: KatexRuntime;
  readonly tracker: DocumentPageTracker;
  /** Limitations found while rendering; printed with the bundle's own warnings. */
  readonly renderWarnings: ReadonlyArray<string>;
}

export function ScientDocumentPage(props: ScientDocumentPageProps) {
  const { input, tracker } = props;
  const markdown = useScientMathMarkdownText(input.markdown);
  const remarkPlugins = useScientMathRemarkPlugins(
    // A chat bundle writes its hard breaks explicitly, so both parse as documents.
    useMemo(() => scientMarkdownRemarkPlugins("document"), []),
    input.markdown,
  );
  const direction = useMemo(
    () => resolveMarkdownDirection(input.markdown, input.direction),
    [input.direction, input.markdown],
  );
  const context = useMemo<DocumentPageContext>(
    () => ({
      assets: new Map(input.assets.map((asset) => [asset.id, asset])),
      assetBaseUrl: props.inputUrl,
      katex: props.katex,
      tracker,
    }),
    [input.assets, props.inputUrl, props.katex, tracker],
  );
  const rehypePlugins = useMemo(
    (): NonNullable<ReactMarkdownOptions["rehypePlugins"]> => [
      rehypeRaw,
      [rehypeReportUnsupportedHtml, { tracker }],
      [rehypeSanitize, DOCUMENT_SANITIZE_SCHEMA],
      [rehypeEnsureTitle, { title: input.title }],
      [rehypeScientBidi, { direction, requestedDirection: input.direction }],
    ],
    [direction, input.direction, input.title, tracker],
  );
  const notes = [...input.warnings.map((warning) => warning.message), ...props.renderWarnings];

  return (
    <DocumentPageContextValue value={context}>
      <article
        className={
          input.profile === "chat"
            ? "scient-document scient-document--conversation"
            : "scient-document"
        }
        dir={direction}
        lang={input.language ?? undefined}
        data-scient-document={input.documentKind}
      >
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          skipHtml={false}
          components={COMPONENTS}
          urlTransform={urlTransform}
        >
          {markdown}
        </ReactMarkdown>
        {notes.length > 0 ? (
          <section className="scient-document-notes" aria-label="Export notes">
            <h2>Export notes</h2>
            <ul>
              {[...new Set(notes)].map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </section>
        ) : null}
      </article>
    </DocumentPageContextValue>
  );
}
