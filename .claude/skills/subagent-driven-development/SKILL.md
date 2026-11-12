---
name: subagent-driven-development
description: Fourth and final stage of the feature workflow (brainstorming → grill-me → writing-plans → subagent-driven-development) for topup-project. Executes an implementation plan by dispatching a fresh subagent per task, then reviewing each task (spec compliance, then code quality) and fixing issues before moving on, followed by a final end-to-end check. Use when a plan in docs/plans/ is ready and the user says "execute the plan", "build it", "start implementing", /subagent-driven-development, or approves execution at the end of writing-plans.
---

# Subagent-driven development

Execute a written plan task by task. Each task gets a fresh implementer subagent (so it works only
from the plan, not from a long, drifting conversation), then a reviewer checks it before the next
task starts. You stay the coordinator: you hand out tasks, read reports, and decide what happens next.

Invoking this skill is the user's request to use subagents for this plan.

Reply to the user in the language they are writing in.

## Setup

1. Read the plan (`docs/plans/YYYY-MM-DD-<topic>.md`, or the newest one in `docs/plans/`) and its
   design doc. Read `.claude/skills/writing-plans/references/project-conventions.md`.
2. If anything in the plan is unclear or contradicts the current code, stop and ask the user before
   dispatching anything — a subagent will guess, and guesses here end up in production code.
3. Track the tasks in a todo list, one item per plan task plus "Final review".

## Per task

Tasks run one at a time, in order. They touch the same few files, so parallel implementers would
overwrite each other.

### 1. Implement

Dispatch a `general-purpose` subagent with:

```
You are implementing Task <N> of the plan at <plan path>, in the project at <project root>.

Read first:
- The plan, Task <N> only (other tasks are for context; don't do them)
- .claude/skills/writing-plans/references/project-conventions.md
- The files listed in the task, as they are on disk now

Do exactly what Task <N> says. Then run its Verify commands and compare with Expected.

Rules:
- The databases are production: SELECT only. No INSERT/UPDATE/DELETE/DDL.
- Never print or copy .env values.
- If the plan doesn't match the code, or verification fails and the fix isn't obvious, stop and
  report instead of improvising.
- Stop any test server you start (port 5099).

Report: files changed (with a one-line summary each), verification commands run and their actual
output, anything that differed from the plan, and any concerns.
```

### 2. Review

When the implementer reports success, dispatch a second `general-purpose` subagent as reviewer:

```
Review Task <N> of the plan at <plan path> in <project root>. The implementer says it is done.

Check, in this order:
1. Spec compliance: does the code do exactly what Task <N> (and the design doc section it serves)
   asks — nothing missing, nothing extra? Do the verification commands still pass when you run them?
2. Code quality against .claude/skills/writing-plans/references/project-conventions.md:
   descriptive names, helper reuse, parameterized SQL, date-bounded queries on log tables,
   WITH (NOLOCK), error handling via BadRequestError/sendErrorResponse, no secrets exposed,
   no existing route/param/field renamed.

Don't edit files. Report issues as: severity (blocking / should-fix / nit), file:line, problem,
suggested fix. Say "No issues" if there are none.
```

### 3. Fix loop

- Blocking or should-fix issues: send them to a fresh implementer subagent (same template, plus the
  reviewer's list), then review again. Repeat until the reviewer reports no blocking/should-fix issues.
- Nits: fix if trivial, otherwise list them for the user at the end.
- If the same task fails review three times, stop and bring it to the user with what was tried.

Mark the task done, give the user a one-line progress update, and move to the next task.

## Final review

After the last task:

1. Run the full verification yourself (not a subagent): start the server on 5099, call every new
   endpoint with real data (happy path, paging, each filter, bad inputs, timing), re-check the
   existing endpoints that share changed helpers, stop the server.
2. Read the full diff of changed files once, looking for things a per-task review can miss:
   duplicated helpers, inconsistent names between files, leftover debug code.
3. Report to the user:
   - what was built (endpoints with example URLs),
   - measured response times,
   - files changed,
   - deviations from the plan and why,
   - leftover nits or follow-ups (e.g. indexes to ask the DBA for).

Don't commit or push unless the user asks.
