# Milestone 1 verification status

**Not accepted. No local game or paid ten-agent run has been performed.**

Implemented: strict ten-agent experiment configuration; private revisioned SQLite memory; action and usage journals; trace export/recovery; scoped game actions; merchant/gatherer code hooks; policy-filtered tools; shared Pi task loop and inference gate; local world/browser lifecycle; operator CLI; evidence-based acceptance checks.

Current checks (before final review fixes):

- Native Node test suite: 30 passing, 1 skipped, 1 failed.
- The failure is the mandatory Node 24 / pinned SDK compatibility test. Installed Node is 25.2.1.
- The skipped ownership test needs a loopback listener, blocked here with EPERM.
- Two live tests are explicitly skipped without their live flags/evidence.
- TypeScript 5.9.3 check with cached Node 24 types passed.
- Preliminary Pi loop tests use the installed Pi 0.83.0; target 0.84.2 compatibility is unverified.

Environment blockers:

- Shell DNS cannot resolve npm/GitHub, preventing dependency installation and submodule initialization.
- Local listening sockets are denied, preventing a local engine and browser smoke test.
- An explicit live model endpoint, credential variable, tariffs, and budget have not been supplied.

Remaining work before acceptance:

1. Install Node 24 and exact dependencies; generate/review package-lock.json; initialize the pinned upstream submodule; pass the full check.
2. Run and debug local preparation/migrations/build/start against the real upstream checkout.
3. Pass social smoke and calibrate an ordinary gathering/banking/shop route.
4. Run ten rendered agents for 30 minutes with explicit inference configuration and record the operator interventions.
5. Inspect context/state/action/screenshot evidence and evaluate acceptance. Report actual behavior and economic outcomes.

No screenshots, success metrics, or profitable behavior have been fabricated. Saves and reference repositories are preserved.
