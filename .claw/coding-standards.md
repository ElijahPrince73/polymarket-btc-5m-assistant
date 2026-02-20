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
