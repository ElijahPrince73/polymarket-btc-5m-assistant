# OpenClaw Instructions (Project Rules)

You are helping build and maintain this repository.

Always work in this order:

1. Clarify the goal (what should the user be able to do?).
2. Propose a short plan (3–7 steps) before coding.
3. Implement the smallest working slice first.
4. Run checks after changes when possible (tests, lint, typecheck).
5. Summarize what changed and list the next step.

Hard rules:

- Prefer simple solutions over clever ones.
- Follow existing patterns in the repo. If none exist, propose one and record it in .claw/decisions.md.
- Do not add new libraries unless necessary. If you want one, explain why and list alternatives.
- Keep changes tight: avoid unrelated refactors.

## Required Workflow (Planner → Builder → Reviewer)

For any non-trivial change (new endpoint, API integration, refactor, bugfix):

1. Planner: Write a short plan (1–7 steps). Include which files will change.
2. Builder: Implement the smallest working slice first. Avoid broad refactors.
3. Reviewer: Verify behavior:
   - Confirm request/response shapes for endpoints
   - Confirm error handling paths
   - Note any follow-ups or risks

Output format:

- Plan:
- Changes made:
- How to test:
- Next step:
