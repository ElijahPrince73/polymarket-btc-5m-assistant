# Coding Standards

Stack:

- Node.js
- Express
- JavaScript (.js)

General Principles:

- Keep routes thin and move logic into services/helpers.
- Prefer clear readable code over clever abstractions.
- Avoid unnecessary dependencies.

Structure:

- Routes define endpoints only.
- Business logic lives in services or utilities.
- API integrations should be isolated in their own modules.

Error Handling:

- Always handle async errors.
- Return consistent response shapes from endpoints.

Quality:

- No unused variables or dead code.
- Keep functions small and single-purpose.
- Log meaningful errors, not noisy logs.

## Definition of Done (DoD)

- Endpoint returns consistent JSON (success + error).
- External API calls are isolated to a module/service (not inside route handlers).
- Logs include enough detail to debug failures but avoid dumping secrets.
- If a change affects behavior, update/add a test when feasible.
- Provide a "How to test" section after changes.
