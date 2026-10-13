/**
 * Deterministic synthetic manuscript for Visual performance and stability
 * checks. Its density follows a math-heavy paper: per page roughly six prose
 * paragraphs with inline math, five displayed equations (most labelled), eight
 * equation references, and a lemma with proof every few pages.
 */
export function latexBenchmarkDocument(options: {
  readonly pages: number;
  readonly seed?: number;
}) {
  let state = options.seed ?? 20261013;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)]!;
  const words = [
    "the",
    "channel",
    "feedback",
    "capacity",
    "estimate",
    "controller",
    "observer",
    "innovation",
    "covariance",
    "stationary",
    "policy",
    "decoder",
    "encoder",
    "message",
    "variance",
    "bounded",
    "recursion",
    "spectrum",
    "measurement",
    "noise",
    "optimal",
    "linear",
    "gain",
    "state",
    "process",
    "therefore",
    "remains",
    "determines",
    "satisfies",
    "follows",
    "under",
    "every",
    "time",
    "step",
  ];
  const inline = [
    String.raw`$x_i$`,
    String.raw`$\mathbf{u}_i = 0$`,
    String.raw`\(A_* \xi_i\)`,
    String.raw`$\sigma_*^2$`,
    String.raw`$i \ge 2$`,
    String.raw`$c\zeta_{i+1}/(H_d G)$`,
    String.raw`$\log|\det A_u|$`,
    String.raw`\(\vartheta_i = \sigma_*^2\)`,
  ];
  const labels: string[] = [];
  const sentence = () => {
    const parts: string[] = [];
    const length = 9 + Math.floor(next() * 8);
    for (let index = 0; index < length; index++) {
      if (index > 1 && next() < 0.12) parts.push(pick(inline));
      else parts.push(pick(words));
    }
    if (labels.length && next() < 0.35) parts.push(`by~\\eqref{${pick(labels)}}`);
    const text = parts.join(" ");
    return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
  };
  const paragraph = () => Array.from({ length: 4 + Math.floor(next() * 3) }, sentence).join(" ");
  const equation = (index: number) => {
    const label = `eq:bench-${index}`;
    if (index % 4 === 3) {
      const second = `eq:bench-${index}b`;
      labels.push(label, second);
      return String.raw`\begin{align}
  \mathbf{y}_i^{d} - H_*\check{\xi}_i &= H_* T_u A_u^{i-4}\mathbf{a}_n + c\zeta_i, \label{${label}}\\
  S_n(\omega) &= \sigma_*^2 \frac{|\det(I_2 - A_* e^{-i\omega})|^2}{|1 - F_e e^{-i\omega}|^2}. \label{${second}}
\end{align}`;
    }
    if (index % 5 === 4)
      return String.raw`\[ \check{\xi}_{${index}} = \sum_{j=1}^{3} A_*^{3-j} \frac{N_*}{c} \mathbf{y}_j^{d}. \]`;
    labels.push(label);
    return String.raw`\begin{equation}
  \vartheta_{${index}} = \sigma_*^2 := \frac{c^2}{H_d^2 G^2} + \int_0^{\pi} \log\left|1 - F_e e^{-i\omega}\right| \, d\omega \label{${label}}
\end{equation}`;
  };
  const body: string[] = [];
  let equations = 0;
  for (let page = 0; page < options.pages; page++) {
    if (page % 3 === 0) body.push(`\\section{Section ${page / 3 + 1}}`);
    else body.push(`\\subsection{Part ${page + 1}}`);
    for (let index = 0; index < 6; index++) {
      body.push(paragraph());
      if (index < 5) body.push(equation(equations++));
    }
    if (page % 4 === 2) {
      body.push(String.raw`\begin{lemma}\label{lem:bench-${page}}
${sentence()} ${sentence()}
\end{lemma}
\begin{proof}
${paragraph()}
\end{proof}`);
    }
    if (page % 5 === 1) {
      body.push(String.raw`\begin{itemize}
  \item ${sentence()}
  \item ${sentence()}
\end{itemize}`);
    }
  }
  return String.raw`\documentclass{article}
\usepackage{amsmath,amssymb,amsthm}
\newtheorem{lemma}{Lemma}
\title{Synthetic Visual benchmark manuscript}
\author{Scient}
\begin{document}
\maketitle
\begin{abstract}
${paragraph()}
\end{abstract}
${body.join("\n\n")}
\end{document}
`;
}
