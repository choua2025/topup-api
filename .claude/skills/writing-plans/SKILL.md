---
name: writing-plans
description: Third stage of the feature workflow (brainstorming → grill-me → writing-plans → subagent-driven-development) for topup-project. Turns an approved design doc into a step-by-step implementation plan with exact files, complete code and verification commands, small enough for a subagent with no context to execute each task. Use after grill-me (or brainstorming) when a design is approved, when the user says "write the plan", "plan this", /writing-plans, or has a spec/requirements they want broken into tasks before coding.
---

# Writing plans

Write an implementation plan that a developer — or a subagent — with zero context about this
conversation could follow task by task and get it right. Each task is executed by a fresh subagent
in the next stage, so anything not written in the plan doesn't exist for it.

Reply to the user in the language they are writing in; write the plan itself in English (code,
names and comments in this project are English).

## Input

The approved design doc, usually `docs/specs/YYYY-MM-DD-<topic>-design.md`. If it has open
questions, resolve them with the user first (or run grill-me). Read
`references/project-conventions.md` (in this skill's folder) and the current versions of every file
the plan will touch — the user edits files between sessions (e.g. they renamed `/daily` to
`/historyByPhone`), so plan against what is on disk now.

## Plan file

Save to `docs/plans/YYYY-MM-DD-<topic>.md`:

```markdown
# <Feature> implementation plan

**Design:** docs/specs/YYYY-MM-DD-<topic>-design.md
**Goal:** <one sentence>
**Approach:** <2-3 sentences: tables, query strategy, files>
**Measured query time:** <from design, e.g. "~1.2 s for 30 days">

## Tasks

### Task 1: <short name>

**Files:**
- Modify: `src/services/topup.service.js` (add `getXyz` after `getTopupLogsByDay`)

**Steps:**
1. <exact change, with the complete code block to add or the exact old → new text>
2. ...

**Verify:**
```bash
<exact command(s)>
```
Expected: <exact output or what to look for, with real values>

**Done when:** <one line>
```

## How to size and write tasks

- **One layer or one concern per task**, 2-10 minutes of work: e.g. service function → controller
  function → route + mount → regression check. A task that touches all three layers is too big.
- **Complete code, not descriptions.** Write the actual function, SQL and `.input(...)` calls. "Add
  validation" is not a step; the `if (...) throw new BadRequestError("...")` line is.
- **Exact locations.** File path, and which function to add after or which lines to replace.
- **Reuse helpers by name** (`parsePagination`, `normalizePhone`, `parseDateRange`,
  `sendErrorResponse`, `buildPageResult`) and say which file they come from.
- **Verification in every task.** This project has no test framework, so verification means:
  - service tasks: a `node -e` script that imports the service and calls it with real values,
    printing row count and elapsed ms;
  - controller/route tasks: start the throwaway server on port 5099, `curl` happy path, paging,
    each filter and each bad input, then stop the server (commands in project-conventions.md);
  - always state the expected result using real data (a phone number and date known to have rows).
- **Last task: regression + summary.** Re-call the existing endpoints that share changed helpers, and
  list what changed for the user.
- Follow the conventions file: descriptive names, read-only SQL, parameterized inputs, date-bounded
  queries on log tables, no renaming of existing routes/fields.

## Self-review before handing over

Read the plan once as the executing subagent would:

- Does every requirement in the design map to a task? (List any that don't.)
- Could each task be done with only the plan, the named files and the conventions doc?
- Are names consistent across tasks (the service function name used in the controller task matches)?
- Are there placeholders like "TODO", "similar to above", "handle errors appropriately"? Replace them.

## Hand off

Tell the user where the plan is, how many tasks it has, and summarize them in a short list. Ask
whether to execute it with **subagent-driven-development**. If yes, invoke that skill with the plan
path.
