/** Synthetic regression input based on the user's theorem/proof/remark example. */
export const scientificStatementsFixture = String.raw`\documentclass{article}
\usepackage{amsmath,amsthm}
\newtheorem{theorem}{Theorem}
\newtheorem{remark}{Remark}
\begin{document}
\begin{theorem}

we now add a new theorem    \end{theorem}

\begin{theorem}[Energy estimate and decay]
  Assume the Dirichlet branch of \eqref{eq:bc} and let $u_0 \in L^2(\Omega)$.
  Then \eqref{eq:pde}--\eqref{eq:init} has a unique weak solution
  $u \in C([0,T]; L^2(\Omega)) \cap L^2(0,T; H^1_0(\Omega))$ satisfying
  \[
    \sup_{0 \le t \le T} \|u(t)\|_{L^2}^2
      + 2 \int_0^T \|\nabla u(t)\|_{L^2}^2 \,\mathrm{d}t
      \;\le\; \|u_0\|_{L^2}^2 .
  \]
  Moreover, writing $\lambda_1$ for the first Dirichlet eigenvalue of $-\Delta$,
  \[
    \|u(t)\|*{L^2} \;\le\; e^{-\lambda_1 t} \|u_0\|*{L^2}
    \qquad \text{for all } t \ge 0 .
  \]
\end{theorem}

\begin{proof}
  Differentiating $\|u(t)\|_{L^2}^2$ and integrating by parts gives
  \[
    \frac{1}{2}\frac{\mathrm{d}}{\mathrm{d}t}\|u(t)\|_{L^2}^2
      + \|\nabla u(t)\|_{L^2}^2
      = \int_{\partial\Omega} \partial_\nu u \; u \,\mathrm{d}S
      = 0,
  \]
  where the boundary term vanishes because $u$ has zero trace on $\partial\Omega$.
  Integrating in time yields the first inequality, and existence follows by
  Galerkin approximation.

  For the second, the Poincar\'e inequality
  $\|u\|*{L^2}^2 \le \lambda_1^{-1}\|\nabla u\|*{L^2}^2$ turns the identity above
  into $\tfrac{1}{2}\frac{\mathrm{d}}{\mathrm{d}t}\|u\|*{L^2}^2 \le -\lambda_1 \|u\|*{L^2}^2$,
  and Gr\"onwall's inequality closes the argument.
\end{proof}

\begin{remark}[Why Neumann is different]
  Constants lie in $\ker(-\Delta)$, so the Neumann problem has $\lambda_1 = 0$ and
  the decay estimate is vacuous: heat is conserved. In fact the solution converges
  to its spatial mean,
  \[
    u(\cdot,t) \longrightarrow \bar u := \frac{1}{|\Omega|}\int_\Omega u_0
    \qquad \text{strongly in } L^2(\Omega) \text{ as } t \to \infty,
  \]
  so the conserved quantity is the projection of $u_0$ onto constants, not $u_0$ itself.
\end{remark}

\section{Spectral representation}
Following prose stays unchanged.
\end{document}
`;
