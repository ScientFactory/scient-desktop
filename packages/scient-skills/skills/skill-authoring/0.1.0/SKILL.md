---
name: scient-skill-authoring
description: Create, revise, adapt, and review reusable Scient skill candidates from real scientific work. Use when turning a recurring procedure into a skill, improving an existing skill after use, creating a project-specific derivative, or deciding whether an idea belongs as a skill rather than a Scient operation, tool, agent behavior, one-time task, or pack.
---

# Scient Skill Authoring

## Purpose

Create excellent Scient skills: reusable, inspectable procedures that help researchers and agents perform scientific work with greater consistency, judgment, and trust.

Skill Authoring is a constructive meta-capability. It produces a proposed skill definition or a clear judgment that the idea belongs elsewhere. It does not activate, publish, install, approve, or independently validate the resulting skill.

A good authored skill should make valuable work easier to repeat while preserving the researcher’s ability to understand, review, correct, and continue that work manually.

## Core Judgment

Write for an intelligent agent with limited context.

Give it the procedural knowledge, scientific judgment, local conventions, resources, and boundaries it would not reliably infer on its own. Do not micromanage obvious reasoning, restate generic advice, or add ceremony that does not change behavior.

Every instruction should earn its place by preventing a meaningful failure or enabling better judgment.

Scient skills are craft objects, not prompts with branding. They should be bounded enough to trust, flexible enough to adapt, and honest enough to stop.

The governing doctrine is:

> A skill orchestrates power; it does not own power.
>
> A skill guides work; it does not anoint truth.
>
> A skill extends judgment; it does not replace the researcher.

Prefer a small skill that performs one important job exceptionally well over a large skill that imitates an entire research workflow.

## Start From Real Work

Begin with the recurring work, not with a desired skill name, template, or catalog category.

Understand who is doing the work, what project material they begin with, what currently requires repeated explanation or judgment, and what useful result should exist afterward.

Be able to complete this sentence clearly:

> After using this skill, the researcher has…

If the result cannot be named in plain language, the candidate is probably too vague, too broad, or not yet understood.

Use concrete examples. An ordinary case and a difficult or failed case usually reveal more than a large abstract requirements list.

Clarify only uncertainties that would materially change scope, safety, output, or required resources. Make reasonable assumptions about minor details and label them.

Shape the skill around work the researcher can inspect and continue. Do not leave its only meaningful result hidden in an agent conversation.

## Decide Whether It Is a Skill

Do not force every useful idea into skill form.

A Scient skill is a bounded, reusable procedure that applies judgment over real project work by orchestrating Scient operations and permitted tools.

If Scient must guarantee the behavior when every optional skill is disabled, it belongs to product operations, permissions, review, provenance, recovery, or dependable agent behavior.

If the central need is to parse, search, fetch, execute, transform, or write, it is primarily a tool or capability. A skill may use that capability, but should not impersonate its implementation.

If the request is a one-time job, perform the task. If it combines several independently useful procedures, decompose it or treat it as a pack. If it asks one skill to conduct an entire research lifecycle, narrow it until its job and result can be clearly understood.

Continue authoring only when the idea represents reusable procedural judgment.

A clear “this is not a skill” judgment is a successful authoring result.

## Find the Essential Shape

Give the candidate one primary role.

A **Constructive** skill proposes useful project material. A **Review** skill evaluates existing work and returns inspectable findings or proposed corrections. An **Orientation** skill helps a researcher understand project state without becoming the canonical record of that state.

Choose one primary result the researcher can recognize and review. Secondary behavior may support that result, but should not turn the skill into several workflows joined together.

Define the minimum sufficient context. Identify what must be selected or already present, what should be excluded, and what must remain unknown rather than guessed.

Identify the Scient objects, operations, tools, and permissions the skill depends on. Distinguish foundations that exist from those that are missing, proposed, or undefined. Never hide a missing product capability inside persuasive instructions.

Design for manual continuation from the beginning. The researcher should be able to inspect the same material, understand what the skill did, revise its result, and continue without depending on hidden agent state.

## Write the Trigger Contract

Treat the name and description as part of the skill’s behavior.

Name the job rather than the machinery or ambition. Prefer names such as `Evidence to Note` over names such as `Intelligent Research Assistant`.

Write a description that begins with the capability and names the concrete requests, contexts, objects, or workflows that should trigger the skill.

When an important nearby job is likely to be confused with the skill, name the exclusion in the description. Do not fill the description with procedure; its purpose is to help the agent recognize when the skill should be loaded.

Follow the metadata and identity contract supported by the current environment. Preserve required identity, origin, maintainer, version, and content identity where Scient’s product contract requires them.

If Scient’s final package, registry, or storage format remains unresolved, expose that uncertainty rather than inventing a canonical format.

## Choose the Right Degree of Freedom

Match the amount of instruction to the fragility of the work.

Use broad principles and judgment for scientific interpretation, synthesis, writing, orientation, and review when several approaches may be sound.

Use a preferred workflow with room for adaptation when order matters but projects differ.

Use strict steps or deterministic scripts only when an operation is fragile, repetitive, dangerous, or objectively verifiable.

Stable requirements may be unconditional. Situational guidance should identify the condition that makes it relevant. Avoid rules that are merely sometimes true but are written as universal law.

Do not constrain intelligence merely to make the skill look rigorous. Do not leave dangerous ambiguity merely to make it look elegant.

## Write the Skill Body

Write for another capable agent encountering the skill without access to the authoring conversation.

Make the skill’s purpose, role, boundaries, required context, intended result, way of working, quality standard, capability envelope, uncertainty behavior, limitations, stopping conditions, attribution needs, and manual continuation clear.

Express these in the structure most natural to the skill. Do not force every skill through the same large questionnaire or reproduce the complete Scient product model inside every skill.

Use imperative, direct language. Explain why an important boundary exists when that reason helps the agent generalize correctly.

Keep the body concise enough to inspect and remember. Remove any paragraph that would not change the agent’s behavior.

## Use Resources Deliberately

Keep the essential philosophy, workflow, and boundaries in the main skill body.

Move long references, domain material, schemas, examples, templates, or deterministic code into supporting resources only when doing so makes the main skill clearer and more efficient.

Every supporting resource should have a clear condition for when it should be read or used. Do not create files merely to satisfy a package pattern.

Use examples when triggering, output shape, or edge cases are easy to misunderstand. Use references for detailed knowledge needed only in certain contexts. Use templates or assets when the skill repeatedly produces a recognizable artifact. Use scripts when deterministic execution is more reliable than regenerated instructions.

Treat scripts and external resources as inspectable software. Test representative behavior, expose network or mutation effects, avoid embedded secrets, and identify actions requiring explicit permission.

Package formats and provider loaders deliver the skill. They do not make it Scient project authority.

## Protect Scientific Trust

Instructions never widen runtime or project authority.

An authored skill may analyze, orient, review, or propose. Scientific conclusions, accepted changes, and canonical project state remain governed by Scient operations and researcher decisions.

Begin with the least capability sufficient for the job. For ordinary scientific skills, assume no network access, no code execution, and proposal-only project changes unless the real workflow requires more and the skill states that need explicitly.

Preserve distinctions that matter: source material versus interpretation, evidence versus claim, project-grounded content versus general knowledge, and uncertainty versus established support.

A derived skill should preserve visible lineage. It may specialize or strengthen its parent, but must not silently weaken required attribution, review, permission, uncertainty, or recovery behavior.

Design the skill for the day it is wrong. Its mistakes should remain visible, challengeable, and recoverable.

## Design Proof Alongside the Skill

Do not trust a skill because its instructions sound thoughtful.

Create realistic cases that test its ordinary use, ambiguous or incomplete inputs, appropriate refusal, and pressure to exceed its evidence or authority.

Test the trigger contract as well as the body. Confirm that a realistic request loads the skill and that a nearby non-matching request does not.

Judge observable outcomes: usefulness, faithfulness to project material, preserved relationships, visible uncertainty, appropriate restraint, inspectability, and researcher control. Avoid requiring exact wording when several scientifically sound results are possible.

When scripts or deterministic resources exist, run them on representative inputs.

Forward-test important skills with a fresh agent and minimal task-local context. Give it the skill and a realistic request without leaking the desired answer, prior critique, or intended correction. A skill that works only when the agent sees the authoring conversation has not generalized.

Authoring review and forward-testing improve the candidate. They do not replace independent Skill Validation or real end-to-end product validation.

Using Skill Authoring to create another skill tests the authoring experience. It does not prove that either skill improves scientific work.

## Review and Hand Off the Candidate

Read the draft as a skeptical researcher, a future agent, and the product responsible for preserving the project record.

A strong candidate has an immediately understandable purpose, a reliable trigger, one coherent role and result, meaningful non-obvious guidance, honest dependencies, proportionate capabilities, visible uncertainty, and realistic proof.

Remove generic instructions that consume context without improving behavior. Remove ambitions that do not serve the primary job. Strengthen only the boundaries whose failure would matter.

If the draft still depends on vague objects, hidden authority, invented infrastructure, or perfect model behavior, revise, narrow, or reject it.

End with one honest authoring judgment:

- **Ready for human review** — coherent enough for product and domain review.
- **Needs revision** — the candidate itself remains unclear, excessive, or internally inconsistent.
- **Foundation gap** — the procedure is coherent, but required Scient foundations are missing or undefined.
- **Not a skill** — the idea belongs to another product responsibility or should remain a task.

These are authoring judgments, not activation states or claims of validation.

Return the complete candidate together with a concise explanation of why it is a skill, what foundations it depends on, how it was or should be tested, and what remains unresolved.

Do not activate, publish, install, promote, or declare the candidate validated unless a separate authorized process does so.

## Learn Through Use

Use this skill to author real Scient skills, improve existing ones, create careful derivatives, and refuse ideas that do not belong as skills.

Notice where human reviewers repeatedly rewrite the result, where the guidance constrains useful intelligence, where it fails to protect scientific trust, where triggers misfire, and where supporting resources create more weight than value.

Revise Skill Authoring from those observations.

Preserve principles that continue to improve materially different skills. Remove scaffolding that does not earn its complexity. Long-term stability should come from repeated use, not from trying to predict every future skill in version 0.1.

## Calibration

| Idea                                                                  | Authoring judgment                                                      |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Turn selected evidence into a faithful, evidence-linked note proposal | Plausible Constructive skill                                            |
| Capture an exact source region and preserve its locator               | Scient operation                                                        |
| Parse a PDF or search a scholarly database                            | Tool or capability                                                      |
| Always ground answers and expose uncertainty                          | Dependable agent behavior                                               |
| Complete a systematic review from search through manuscript           | Decompose into operations, bounded skills, and possibly a pack          |
| Adapt a maintained review skill to a laboratory checklist             | Possible derivative with visible lineage and preserved trust boundaries |

These examples calibrate the boundary. They are not a catalog or roadmap.

## Standard

Write every skill as if a researcher will inherit its work under pressure, with incomplete evidence, consequential decisions, and a persuasive model that may still be wrong.

The best skill is not the one that does the most.

It is the one that performs a valuable job, gives an intelligent agent the guidance it genuinely needs, preserves the researcher’s ability to understand and continue the work, and knows when to stop.
