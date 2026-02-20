# Architecture Notes

Project Type:
Node.js + Express backend for trading-related workflows.

Key Areas:

- live_trading: real trading logic
- paper_trading: simulated trading logic
- src: core server code and API endpoints
- scripts: automation or helper scripts
- test: testing utilities

Design Goals:

- Keep trading logic isolated from route handlers.
- External API communication should be centralized.
- Shared utilities should live under src/utils (if created).
