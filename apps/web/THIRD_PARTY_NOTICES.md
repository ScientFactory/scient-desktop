# Third-Party Notices

## Vega, Vega-Lite, Vega-Embed, and Vega Tooltip

Scient renders interactive charts with unmodified, locally bundled
[`vega`](https://vega.github.io/vega/),
[`vega-lite`](https://vega.github.io/vega-lite/), and
[`vega-embed`](https://github.com/vega/vega-embed), and
[`vega-tooltip`](https://github.com/vega/vega-tooltip) packages. Each project is
licensed under the BSD 3-Clause License.

- <https://github.com/vega/vega/blob/main/LICENSE>
- <https://github.com/vega/vega-lite/blob/main/LICENSE>
- <https://github.com/vega/vega-embed/blob/main/LICENSE>
- <https://github.com/vega/vega-tooltip/blob/main/LICENSE>

## Mermaid

Scient renders diagrams with an unmodified, locally bundled
[`mermaid`](https://mermaid.js.org/) package. Mermaid is Copyright (c)
2014-2022 Knut Sveidqvist and is licensed under the MIT License.

- <https://github.com/mermaid-js/mermaid/blob/develop/LICENSE>

## KaTeX and remark-math

Scient renders mathematical notation with an unmodified, locally bundled
[KaTeX](https://katex.org/), including its distributed fonts (WOFF2, WOFF, and
TTF), and parses math syntax with
[`remark-math`](https://github.com/remarkjs/remark-math). KaTeX is
Copyright (c) 2013-2020 Khan Academy and other contributors, licensed under the
MIT License; its bundled fonts derive from the Computer Modern typefaces.
remark-math is Copyright (c) Titus Wormer, licensed under the MIT License.

- <https://github.com/KaTeX/KaTeX/blob/main/LICENSE>
- <https://github.com/remarkjs/remark-math/blob/main/license>

## vscode-icons

The custom file icon symbols in `src/pierre-icons.ts` are adapted from the
[`vscode-icons`](https://github.com/vscode-icons/vscode-icons) project.

Copyright (c) 2016 Roberto Huertas

Licensed under the MIT License. The full license text is available in the
upstream repository: <https://github.com/vscode-icons/vscode-icons/blob/master/LICENSE>.

## Citation.js, citeproc-js, and Citation Style Language

Scient formats source references with unmodified Citation.js packages and the
citeproc-js processor. Citation.js is Copyright (c) 2015-2026 Lars Willighagen
and is licensed under the MIT License. citeproc-js is Copyright (c) 2009-2019
Frank Bennett and is available under the Common Public Attribution License 1.0
or the GNU Affero General Public License 3.0; Scient uses the CPAL-1.0 option.

The bundled Vancouver and APA style definitions come from the Citation Style
Language project and are distributed under the Creative Commons
Attribution-ShareAlike 3.0 Unported license. Style author and contributor
metadata remains embedded in the distributed definitions.

- <https://citation.js.org/>
- <https://github.com/Juris-M/citeproc-js>
- <https://citationstyles.org/>
- <https://github.com/citation-style-language/styles>

## OpenAI Codex managed runtime

On a release-proven target, Scient can download an unmodified official OpenAI
Codex executable directly from OpenAI's GitHub release. The managed executable
is not committed to or bundled with this repository.

OpenAI Codex
Copyright 2025 OpenAI

OpenAI Codex is licensed under the Apache License, Version 2.0. The full
license and upstream notice are available at:

- <https://github.com/openai/codex/blob/main/LICENSE>
- <https://github.com/openai/codex/blob/main/NOTICE>

The upstream notice states that Codex includes code derived from Ratatui,
licensed under the MIT License, with copyright held by Florian Dehau and the
Ratatui Developers.

## TinyTeX

On a computer with no LaTeX installation, Scient can download an unmodified
official TinyTeX release directly from its GitHub release, at the user's
request. The managed distribution is not committed to or bundled with this
repository or its installer; it is fetched only when a user asks Scient to
install it, and it lives entirely under a directory Scient owns.

TinyTeX's own installation and distribution scripts are Copyright Yihui Xie
and are licensed under the GNU General Public License, version 2.0 (GPL-2.0).
TinyTeX itself is a repackaged, minimal subset of TeX Live: the packages it
installs are each licensed individually by their own authors, predominantly
under the LaTeX Project Public License (LPPL) and other free software
licenses TeX Live's package collection carries, not under TinyTeX's own
GPL-2.0 terms.

- <https://github.com/rstudio/tinytex-releases>
- <https://tug.org/texlive/copying.html>
