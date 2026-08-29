---
name: scient-skill-authoring
description: Create or improve skills for Scient. Use when the user asks to design, write, review, simplify, or test a skill, or decide whether recurring work should become one.
---

# Scient Skill Authoring

The goal is to create or improve a skill that gives a capable agent the minimum missing guidance needed to perform repeatable work well, while preserving the agent's judgment, the user's intent, and Scient's authority boundaries.

## Understand the Work

Begin with the work, not the skill. Understand what the user is actually trying to accomplish, inspect relevant context or examples when available, and discuss uncertainty only when it would materially change the skill's purpose, scope, safety, or expected result.

Identify what a capable agent would otherwise be missing and what a good result would look like. Then decide whether reusable guidance would materially improve the work. If it would not, explain that clearly to the user and recommend against creating a skill, offering a better-fitting alternative when one is apparent.

A skill adds reusable domain context, judgment, workflow, resources, or verification to capabilities the agent already has. It does not provide tools or authority. New integrations, persistent runtimes, or privileged capabilities belong in an add-on or another capability layer. One-off work should remain an ordinary task; always-relevant workspace context or broad personal behavior may belong in instructions or preferences.

## Write Only What Is Missing

Give the skill a focused purpose. Its description is a routing contract: say what it helps accomplish and when it should be used, adding exclusions only where they prevent likely confusion.

In the body, include the goal, useful first principles or non-obvious context, meaningful constraints, and how success can be verified. Leave room for the agent to adapt to the request and available evidence. Use fixed procedures or scripts only when the work is genuinely fragile, deterministic, repetitive, or risky.

Do not impose a universal structure, restate generic model behavior, or encode speculative edge cases. Add supporting resources only when they materially help, and make their use clear. Apply domain standards—such as evidence, uncertainty, and provenance in research—only when relevant.

## Choose Its Home and Invocation

A personal skill follows the user across projects. A project skill captures guidance or resources that belong to one initialized Scient workspace. Infer the intended home when the context is clear; otherwise discuss it with the user when the choice would materially affect the skill.

Create a project skill at `.scient/skills/<name>/SKILL.md`, with the frontmatter name matching the directory. Do not add `scient.skill.json`; that filename is reserved for reviewed packaged releases. A newly valid project skill is available automatically from the next message. The user can later choose Agent access, `$name` only, or Deactivated in Settings. Do not edit Scient's app-private preference store.

Scient does not yet expose agent-driven personal-skill installation, so present a personal candidate without claiming it was installed.

After checking relevant existing skills when available, give the skill a short, distinct name; this is also its explicit `$name` invocation. Choose invocation separately from its home. Allow automatic selection when the description can reliably identify work that normally benefits from the skill. Use explicit invocation when applying it depends on intent the request may not reveal or the user should deliberately choose that mode.

Invocation controls how a skill is selected, not what it may do. Scient owns identity, storage, origin, versioning, installation, activation, and authorization. Use only capabilities available in the session, and do not claim a lifecycle action or validation occurred unless it was verified.

## Test and Hand Off

Validate the skill and its resources. Test in proportion to its importance with a representative request, a plausible near-miss, and a variation requiring adaptation. When its value is uncertain, compare the same work without the skill. Use a fresh context when practical so the test does not inherit the intended answer or critique.

Revise from observed failures rather than imagined completeness. Remove instructions that do not improve decisions or outcomes.

Present the candidate or exact changes, its intended home and invocation, non-obvious rationale, testing performed, and remaining uncertainty. Keep drafted, installed, activated, and tested states distinct.
