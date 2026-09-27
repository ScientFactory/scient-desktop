/**
 * The Word export fixture set: synthetic documents in Scient's document and
 * chat profiles, adapted from the Pandoc qualification fixtures. The local
 * integration test converts each with the real Pandoc, checks the `.docx`
 * structure, and can write the files out for review in Word.
 */
import {
  MessageId,
  ThreadId,
  TurnId,
  type ConversationSnapshotV1,
  type DocumentBundle,
  type DocumentCitation,
} from "@t3tools/contracts";
import { buildConversationDocument } from "@scientfactory/conversation";

import { mermaidDiagramAssetId } from "./pandocPreparation.ts";
import {
  PNG_BYTES,
  PNG_BYTES_ALT,
  SVG_BYTES,
  bytesAsset,
  makeBundle,
} from "./pandocTestSupport.ts";

export const MATH_MARKDOWN = String.raw`# Math-heavy fixture

Inline math: the energy $E = mc^2$, a fraction $\frac{a+b}{c-d}$, a sum $\sum_{i=1}^{n} x_i^2$,
an integral $\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}$, and sets $\mathbb{R}^n \subset \mathbb{C}^n$.

Accents: $\hat{x}$, $\bar{y}$, $\tilde{z}$, $\vec{v}$, $\dot{q}$, $\overline{AB}$.

Indexed roots: $\sqrt{2}$, $\sqrt[3]{x+1}$, $\sqrt[n]{\frac{a}{b}}$.

Text in math: $f(x) = x \text{ if } x > 0$, $\mathcal{L}$, $\mathbf{A}$, $\boldsymbol{\alpha}$, $\operatorname{tr}(A)$.

$$
\begin{aligned}
\nabla \cdot \mathbf{E} &= \frac{\rho}{\varepsilon_0} \\
\nabla \times \mathbf{B} - \frac{1}{c^2}\frac{\partial \mathbf{E}}{\partial t} &= \mu_0 \mathbf{J}
\end{aligned}
$$

$$
A = \begin{pmatrix} 1 & 2 & 3 \\ 4 & 5 & 6 \\ 7 & 8 & 9 \end{pmatrix}, \quad
B = \begin{bmatrix} a & b \\ c & d \end{bmatrix}, \quad
\det\begin{vmatrix} a & b \\ c & d \end{vmatrix} = ad - bc
$$

$$
|x| = \begin{cases} x & \text{if } x \ge 0 \\ -x & \text{otherwise} \end{cases}
$$

$$
\lim_{n \to \infty} \left( 1 + \frac{1}{n} \right)^n = e, \qquad \prod_{k=1}^{n} k = n!, \qquad \binom{n}{k}
$$
`;

const WIDE_HEADER = Array.from({ length: 12 }, (_, index) => `Measurement ${index + 1}`);
const wideRow = (row: number) =>
  `| ${Array.from({ length: 12 }, (_, column) => `${(row * 12 + column) * 1.5}`).join(" | ")} |`;

export const TABLES_MARKDOWN = [
  "# Tables",
  "",
  "A formatted table:",
  "",
  "| Quantity | Symbol | Value | Unit |",
  "|---|:---:|---:|---|",
  "| Speed of light | $c$ | 299 792 458 | m/s |",
  "| **Planck constant** | $h$ | 6.626e-34 | J·s |",
  "| *Elementary charge* | $e$ | 1.602e-19 | C |",
  "",
  "A wide table:",
  "",
  `| ${WIDE_HEADER.join(" | ")} |`,
  `|${WIDE_HEADER.map(() => "---").join("|")}|`,
  ...Array.from({ length: 4 }, (_, row) => wideRow(row)),
  "",
  "A long table:",
  "",
  "| Sample | Mean | Std |",
  "|---|---:|---:|",
  ...Array.from({ length: 60 }, (_, row) => `| S-${row} | ${(row * 0.37).toFixed(3)} | 0.1 |`),
  "",
].join("\n");

export const HEBREW_MARKDOWN = `# Mixed Hebrew and English

This paragraph is English with an embedded Hebrew phrase: שלום עולם, and continues in English.

זוהי פסקה בעברית עם מילים באנגלית כמו Pandoc ו-Word, וגם מספרים 123 ונוסחה $x^2$.

## כותרת בעברית

- פריט ראשון ברשימה
- Second item in English
- פריט שלישי with mixed text

| עמודה | Column |
|---|---|
| ערך | value |
`;

export const HEBREW_DOCUMENT_MARKDOWN = `# מסמך בעברית

זוהי פסקה ראשונה במסמך שכולו מימין לשמאל.

פסקה שנייה, עם מילה באנגלית: Scient.

This English paragraph sits inside a right-to-left document.

| עמודה | ערך |
|---|---|
| א | 1 |
`;

export const CODE_MARKDOWN = `# Code

\`\`\`python
import math

def integrate(f, a, b, n=10_000):
    h = (b - a) / n
    return h * sum(f(a + (k + 0.5) * h) for k in range(n))
\`\`\`

\`\`\`typescript
export const square = (value: number): number => value * value;
\`\`\`

Inline \`code\` and a plain block:

\`\`\`
plain text block
\`\`\`

> [!NOTE]
> Alerts keep their title.

- [ ] open task
- [x] finished task

\`\`\`mermaid
graph TD; A-->B
\`\`\`

\`\`\`mermaid
graph LR; X-->Y
\`\`\`
`;

export const MERMAID_RENDERED_SOURCE = "graph TD; A-->B";

export const IMAGES_MARKDOWN = `# Images

A PNG: ![Photo](scient-asset:photo)

An SVG with a PNG rendering: ![Diagram](scient-asset:diagram-svg)

An SVG without one: ![Only SVG](scient-asset:only-svg)

A missing asset: ![Missing](scient-asset:missing)

A remote image: ![Remote](http://127.0.0.1:9/remote.png)
`;

export const FOOTNOTES_MARKDOWN = `# Footnotes

First claim.[^a] Second claim.[^b] Third claim.[^c]

[^a]: A plain note.
[^b]: A note with math $x^2$.
[^c]: A note with **bold** text.
`;

export const CITATIONS_MARKDOWN = `# Citations

Diffusion was modelled before [@einstein1905]. Later work [see @smoluchowski1906, p. 3; -@perrin1909]
confirmed it. An unknown key stays as written [@nobody2000], and mail@example.com is not a citation.
`;

export const CITATIONS: ReadonlyArray<DocumentCitation> = [
  {
    _tag: "bibliographic",
    id: "c1",
    key: "einstein1905",
    reference: {
      id: "einstein1905",
      type: "article-journal",
      title: "Über die von der molekularkinetischen Theorie der Wärme geforderte Bewegung",
      author: [{ family: "Einstein", given: "Albert" }],
      issued: { "date-parts": [[1905]] },
      "container-title": "Annalen der Physik",
      volume: "322",
      page: "549-560",
      DOI: "10.1002/andp.19053220806",
    },
  },
  {
    _tag: "bibliographic",
    id: "c2",
    key: "smoluchowski1906",
    reference: {
      id: "smoluchowski1906",
      type: "article-journal",
      title: "Zur kinetischen Theorie der Brownschen Molekularbewegung",
      author: [{ family: "Smoluchowski", given: "Marian", "non-dropping-particle": "von" }],
      issued: { "date-parts": [[1906]] },
      "container-title": "Annalen der Physik",
    },
  },
  {
    _tag: "bibliographic",
    id: "c3",
    key: "perrin1909",
    reference: {
      id: "perrin1909",
      type: "book",
      title: "Mouvement brownien et réalité moléculaire",
      author: [{ family: "Perrin", given: "Jean" }],
      issued: { "date-parts": [[1909]] },
      publisher: "Masson",
    },
  },
];

const at = (minute: number) => `2026-09-27T14:${String(minute).padStart(2, "0")}:00.000Z`;

/** A conversation built with the real conversation → bundle adapter, work log and reasoning on. */
export function conversationBundle(): DocumentBundle {
  const turn = TurnId.make("turn-1");
  const snapshot: ConversationSnapshotV1 = {
    format: "scient.conversation-snapshot",
    version: 1,
    thread: {
      title: "Synthetic qualification conversation",
      createdAt: at(0),
      updatedAt: at(9),
      provider: "codex",
      model: "gpt-synthetic",
    },
    provenance: { _tag: "original" },
    captured: {
      threadId: ThreadId.make("thread-synthetic"),
      snapshotSequence: 10,
      threadSequence: 10,
      capturedAt: at(10),
    },
    selection: { workLog: true, reasoning: true, throughMessageId: null },
    messages: [
      {
        n: 1,
        id: MessageId.make("m1"),
        role: "user",
        turnId: turn,
        createdAt: at(1),
        updatedAt: at(1),
        text: "Can you derive the closed form for $\\sum_{k=1}^{n} k^2$ and check it numerically?",
        attachments: [],
        references: [],
      },
      {
        n: 2,
        id: MessageId.make("m2"),
        role: "assistant",
        turnId: turn,
        createdAt: at(3),
        updatedAt: at(3),
        text: [
          "The closed form is",
          "",
          "$$\\sum_{k=1}^{n} k^2 = \\frac{n(n+1)(2n+1)}{6}$$",
          "",
          "| n | sum |",
          "|---:|---:|",
          "| 3 | 14 |",
          "| 10 | 385 |",
          "",
          "המשמעות: יש לוודא שהיחידות נכונות לפני ההגשה.[^1]",
          "",
          "[^1]: Checked numerically for n ≤ 1000.",
        ].join("\n"),
        attachments: [],
        references: [],
      },
      {
        n: 3,
        id: MessageId.make("m3"),
        role: "user",
        turnId: null,
        createdAt: at(5),
        updatedAt: at(5),
        text: "מה אומרת ההערה בעברית?",
        attachments: [],
        references: [],
      },
    ],
    reasoning: [
      {
        id: MessageId.make("r1"),
        turnId: turn,
        createdAt: at(2),
        updatedAt: at(2),
        text: "The sum of squares has a known closed form; verify with a quick script.",
      },
    ],
    workLog: [
      {
        _tag: "tool",
        id: "w1",
        turnId: turn,
        createdAt: at(2),
        title: "Ran pytest",
        itemType: "command_execution",
        toolName: "shell",
        status: "completed",
        command: { text: "pytest -q tests/test_sums.py", omittedLines: 0, omittedChars: 0 },
        detail: null,
        output: { text: "3 passed in 0.02s", omittedLines: 0, omittedChars: 0 },
        changedFiles: [],
        omittedChangedFiles: 0,
      },
      {
        _tag: "tool",
        id: "w2",
        turnId: turn,
        createdAt: at(2),
        title: "Edited sums.py",
        itemType: "file_change",
        toolName: null,
        status: "completed",
        command: null,
        detail: null,
        output: null,
        changedFiles: ["src/sums.py"],
        omittedChangedFiles: 0,
      },
    ],
    proposedPlans: [],
    questionAnswers: [],
    omittedRunningTurn: null,
    warnings: [],
    contentDigest: `sha256:${"b".repeat(64)}`,
  };
  return buildConversationDocument({
    snapshot,
    exportValue: "7f3c9a2e41b8",
    timeZone: "UTC",
    resolveAttachment: () => ({ _tag: "unavailable", reason: "missing" }),
  }).bundle;
}

export interface WordFixture {
  readonly name: string;
  readonly bundle: DocumentBundle;
}

export function wordFixtures(): ReadonlyArray<WordFixture> {
  return [
    { name: "01-math", bundle: makeBundle({ markdown: MATH_MARKDOWN }) },
    { name: "02-tables", bundle: makeBundle({ markdown: TABLES_MARKDOWN }) },
    {
      name: "03-hebrew-mixed",
      bundle: makeBundle({ markdown: HEBREW_MARKDOWN, direction: "ltr" }),
    },
    {
      name: "03b-hebrew-document",
      bundle: makeBundle({ markdown: HEBREW_DOCUMENT_MARKDOWN, direction: "rtl", language: "he" }),
    },
    {
      name: "04-code-alerts-tasks-mermaid",
      bundle: makeBundle({
        markdown: CODE_MARKDOWN,
        assets: [
          bytesAsset({
            id: mermaidDiagramAssetId(MERMAID_RENDERED_SOURCE),
            bytes: PNG_BYTES,
            role: "rendered-diagram",
          }),
        ],
      }),
    },
    {
      name: "05-images",
      bundle: makeBundle({
        markdown: IMAGES_MARKDOWN,
        assets: [
          bytesAsset({ id: "photo", bytes: PNG_BYTES }),
          bytesAsset({
            id: "diagram-svg",
            bytes: SVG_BYTES,
            fileName: "diagram.svg",
            mediaType: "image/svg+xml",
            packagePath: "images/diagram.svg",
          }),
          bytesAsset({
            id: "diagram-png",
            bytes: PNG_BYTES_ALT,
            packagePath: "images/diagram.png",
          }),
          bytesAsset({
            id: "only-svg",
            bytes: SVG_BYTES,
            fileName: "only.svg",
            mediaType: "image/svg+xml",
            packagePath: "images/only.svg",
          }),
        ],
      }),
    },
    { name: "06-footnotes", bundle: makeBundle({ markdown: FOOTNOTES_MARKDOWN }) },
    {
      name: "07-citations",
      bundle: makeBundle({ markdown: CITATIONS_MARKDOWN, citations: CITATIONS }),
    },
    { name: "08-conversation", bundle: conversationBundle() },
  ];
}
