---
name: to-questionnaire
description: >-
  Turn a question I can't answer alone into a questionnaire for someone else to fill in,
  such as a statistician, supervisor, collaborator, ethics committee, data owner or core
  facility. Use when the user asks for a questionnaire or a structured set of questions to
  send to someone or take into a meeting. Use grill-me when the user wants to be questioned
  themselves.
---

# To questionnaire

Turn what the user can't settle alone into a **questionnaire**: a Markdown document they send to one person to fill in, or go through together in a meeting. The recipient holds knowledge the user lacks; the questionnaire draws it out.

**Grill the send, not the subject.** Ask the user only about the send, which they can always answer: who it goes to, and what they need back. First read what the project already says (notes, protocol, analysis plan, data dictionary, earlier correspondence), so you ask only what the files don't answer and the questions carry the right context.

1. **Who is it going to?** Their role, expertise and relationship to the user. This sets the tone and how much context the document must carry. Done when you know who the recipient is and what they know that the user doesn't.
2. **What do you need back?** The specific decisions or facts the user needs from this person. Done when you have a concrete list of what the user must be able to do or decide afterwards.
3. **Write it.** Questions aimed at the gap between steps 1 and 2, in the structure below, saved as `questionnaire-<topic>.md` in the project. Done when the file exists and every item from step 2 has a question.

Ask steps 1 and 2 together in one message when the files don't already answer them.

## Structure

- **Title**, then **Purpose** (why it exists and the decision riding on it), **From / To**, and **How your answers will be used**.
- **Context:** one paragraph for someone who wasn't in the user's head, with the facts they need to answer well (design, sample, the data as it stands), taken from the project, not invented.
- **How to answer:** deadline and rough effort; "I don't know" and partial answers are welcome.
- **Questions** under `##` headings by theme once there are more than a handful, most important first, since the recipient may answer only once. Each question asks one thing, with space for the answer directly beneath (`>`), and a one-line _why this matters_ only where the question could be misread or invite a throwaway answer.
- **Anything else?** A closing question for what we didn't think to ask.

Reply with a link to the file and the questions you weren't sure belong in it.
