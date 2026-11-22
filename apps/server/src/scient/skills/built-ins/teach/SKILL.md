---
name: teach
description: >-
  Teach me a method, tool or topic over several sessions, in a learning folder in this
  project. Use when the user wants to learn to do something themselves, not to have it done.
---

# Teach

The user wants to learn something over several sessions: a statistical method, a tool, a field. Teach it in a **learning folder** in the project (`learning/<topic>/`, unless the user names another place), whose files carry the state from one session to the next. Read them at the start of every session.

## The learning folder

- `MISSION.md`: why the user wants this, what they will use it for, and what "able to do it" looks like for them. All teaching is grounded in it.
- `RESOURCES.md`: the trustworthy sources you found (textbooks, papers, official documentation, courses), each with a link and one line on what it is good for.
- `lessons/0001-<name>.html`: the lessons, numbered.
- `reference/<name>.html`: compressed cheat sheets the user will come back to: syntax, decision guides, formulas, a glossary of terms. Once a glossary exists, every lesson uses its terms.
- `learning-records/0001-<name>.md`: what the user has shown they can do, misconceptions you found, and anything that should change later sessions.
- `NOTES.md`: how the user likes to be taught.

## First session: the mission

If `MISSION.md` is empty or missing, start by asking why they want to learn this and what they will apply it to. Look at the project first: their data, analysis and draft usually show what the method is for, so ask only what the files don't answer. Write the mission, and update it (with a learning record) when their goal changes. The mission is done when it names the goal, the use, and a concrete "able to do it"; then teach the first lesson in the same session.

## Sources

Ground every lesson in sources you found in this task, not in memory: the project's Library first, then the official documentation, standard textbooks and methods papers. Cite them in the lessons with links, and give each lesson one primary source to read next, the best you found.

## Lessons

A lesson teaches one tightly scoped thing in the user's **zone of proximal development**: the next step their learning records show they are ready for, tied to the mission. Keep it short enough to finish in one sitting, ending with a tangible win. Wherever possible use the user's own data or a small realistic example from their field.

Teach the knowledge needed for the skill, then practise it with a **feedback loop**: a quiz or a small task with immediate feedback, such as code they run in Scient Compute with the expected output to compare. Build lasting memory, not just in-the-moment fluency: ask the user to recall rather than reread, return to earlier material in later lessons, and mix related problems. In quizzes, make every option similar in length and vary where the right answer sits.

Make each lesson a clean, readable HTML page that prints well, linking to related lessons and reference sheets, with a shared stylesheet in the folder so the course looks consistent. End each lesson by inviting questions. A lesson is done when it covers one topic, uses the user's data or field, has a feedback loop with the expected answers, cites its sources and names the primary source to read next.

A session is done when the learning record is written and the reference sheets are updated. Reply with a link to the new lesson and what comes next.
