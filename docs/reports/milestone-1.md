# Milestone 1 verification status

**Not accepted. No local game or paid ten-agent run has been performed.**

Implemented: strict ten-agent experiment configuration; private revisioned SQLite memory; action and usage journals; trace export/recovery; scoped game actions; merchant/gatherer code hooks; policy-filtered tools; shared Pi task loop and inference gate; local world/browser lifecycle; operator CLI; evidence-based acceptance checks.

Current checks (after review fixes):

- Native Node test suite: 43 passing, 1 skipped, 1 failed.
- The failure is the mandatory Node 24 / pinned SDK compatibility test. Installed Node is 25.2.1.
- The skipped ownership test needs a loopback listener, blocked here with EPERM.
- Two live tests are explicitly skipped without their live flags/evidence.
- TypeScript 5.9.3 check with cached Node 24 types passed.
- Preliminary Pi loop tests use the installed Pi 0.83.0; target 0.84.2 compatibility is unverified.

The final code review reported five important findings and no critical or minor findings. Fixes cover exact-slot dispatch (whole-stack drops only), live revalidation before primitive effects, ambiguous failure preservation, cross-process trace export serialization, and bounded inspectable pending actions. Added regressions also cover stalled context cancellation, admission held through stream settlement, credential redaction in SQLite, cumulative resumed reports, custom memory/freshness limits, and OpenRouter's serialized request controls. The review was against the pre-fix commit; no second review was performed.

These are preliminary tests using Node's native TypeScript execution and local cached dependencies, not the required npm check on the target installation. The live endpoint, pinned SDK integration, and provider billing controls are unverified.

Environment blockers:

- Shell DNS cannot resolve npm/GitHub, preventing dependency installation and submodule initialization.
- Local listening sockets are denied, preventing a local engine and browser smoke test.
- OpenRouter, DeepSeek Flash, and the $5 maximum are configured in experiments/openrouter-m1.json. OPENROUTER_API_KEY is absent. No inference spending has occurred.

Remaining work before acceptance:

1. Install Node 24 and exact dependencies; generate/review package-lock.json; initialize the pinned upstream submodule; pass the full check.
2. Run and debug local preparation/migrations/build/start against the real upstream checkout.
3. Pass social smoke and calibrate an ordinary gathering/banking/shop route.
4. Run ten rendered agents for 30 minutes with explicit inference configuration and record the operator interventions.
5. Inspect context/state/action/screenshot evidence and evaluate acceptance. Report actual behavior and economic outcomes.

No screenshots, success metrics, or profitable behavior have been fabricated. Saves and reference repositories are preserved.
