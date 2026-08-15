# Scient chat diagram visual fixtures

Open this file in Scient's Markdown preview. Every valid fence should become a
diagram card after entering the viewport; the final malformed and empty cases
should stay readable and show recovery UI. Repeat the review in light and dark
appearance, then copy the whole document and confirm the clipboard still
contains Mermaid fences rather than generated SVG.

## Flowchart with accessible metadata

```mermaid title="research-lifecycle.mmd"
---
title: Research lifecycle
---
flowchart LR
  accTitle: Research lifecycle
  accDescr: Samples move through collection, quality control, analysis, review, and publication.
  A[Collect samples] --> B{Quality control}
  B -->|Pass| C[Analyze]
  B -->|Repeat| A
  C --> D[Peer review]
  D --> E[Publish]
```

## Sequence

```mermaid
sequenceDiagram
  autonumber
  actor Researcher
  participant Scient
  participant Runtime
  Researcher->>Scient: Run analysis
  Scient->>Runtime: Execute versioned source
  Runtime-->>Scient: Results and figures
  Scient-->>Researcher: Reviewable artifact
```

## State lifecycle

```mermaid
stateDiagram-v2
  [*] --> Draft
  Draft --> Validating
  Validating --> Draft: Problems found
  Validating --> Reviewed: Checks pass
  Reviewed --> Published
  Published --> [*]
```

## Entity relationship

```mermaid
erDiagram
  PROJECT ||--o{ DATASET : contains
  PROJECT ||--o{ ARTIFACT : produces
  DATASET ||--o{ ANALYSIS_RUN : informs
  ANALYSIS_RUN ||--|{ ARTIFACT : creates
  ARTIFACT ||--o{ REPRESENTATION : exposes
```

## Mindmap

```mermaid
mindmap
  root((Study design))
    Question
      Hypothesis
      Outcomes
    Methods
      Cohort
      Measurements
    Analysis
      Statistics
      Sensitivity checks
```

## Architecture

```mermaid
architecture-beta
  group lab(cloud)[Research Lab]
  service notebook(server)[Notebook] in lab
  service dataset(database)[Dataset] in lab
  service figures(disk)[Figures] in lab
  notebook:R -- L:dataset
  notebook:B -- T:figures
```

## Gantt

```mermaid
gantt
  title Study schedule
  dateFormat YYYY-MM-DD
  axisFormat %b %d
  section Collection
  Recruitment :done, recruit, 2026-08-01, 7d
  Measurements :active, measure, after recruit, 10d
  section Analysis
  Primary model :analysis, after measure, 5d
  Review :review, after analysis, 3d
```

## Timeline

```mermaid
timeline
  title Discovery milestones
  2026-08-01 : Samples collected
  2026-08-10 : Quality checks passed
  2026-08-18 : Analysis completed
  2026-08-22 : Manuscript revised
```

## Math labels

```mermaid
flowchart LR
  A["Observed data $$y$$"] --> B["Model $$y = X\beta + \epsilon$$"]
  B --> C["Estimate $$\hat{\beta}$$"]
```

## Unicode and RTL labels

```mermaid title="תהליך-ניסוי.mmd"
flowchart RL
  A["איסוף נתונים"] --> B{"בקרת איכות"}
  B -->|"עבר"| C["ניתוח"]
  B -->|"חזרה"| A
  C --> D["תוצאה"]
```

## Tall, narrow RTL flowchart

This diagram should keep its intrinsic width and remain centered when the chat
is wider. It should shrink, without horizontal clipping, when the chat becomes
narrower than the diagram.

```mermaid
flowchart TD
  accTitle: הוכחת נוסחת מספר הזהב
  accDescr: תרשים המציג את שלבי הגזירה של מספר הזהב, מהגדרת היחס ועד לקשר עם סדרת פיבונאצ'י
  A["הגדרת היחס:<br/>a+b חלקי a שווה a חלקי b"] --> B["הצבה: x = a/b"]
  B --> C["משוואה ריבועית:<br/>x בריבוע - x - 1 = 0"]
  C --> D["פתרון בנוסחה הריבועית"]
  D --> E["מספר הזהב:<br/>φ = (1 + שורש 5) / 2 ≈ 1.618"]
  E --> F["קשר לסדרת פיבונאצ'י"]
  F --> G["Fn+1 חלקי Fn שואף ל-φ"]
```

## Two adjacent diagrams

```mermaid
flowchart LR
  A[First] --> B[Diagram]
```

```mermaid
flowchart TB
  C[Second] --> D[Diagram]
```

## Deliberately malformed source

```mermaid
flowchart LR
  A[Unclosed label --> B
```

## Deliberately empty source

```mermaid

```
