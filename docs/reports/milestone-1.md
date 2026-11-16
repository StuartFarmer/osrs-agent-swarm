# Milestone 1 verification status

**Not accepted. No local game or paid ten-agent run has been performed.**

Implemented: strict ten-agent experiment configuration; private revisioned SQLite memory; action and usage journals; trace export/recovery; scoped game actions; merchant/gatherer code hooks; policy-filtered tools; shared Pi task loop and inference gate; local world/browser lifecycle; operator CLI; evidence-based acceptance checks.

Current checks (after review fixes):

- Target Node 24.22.3 suite through tsx: 47 passing, 1 skipped, 0 failed.
- Pi 0.84.2 and pinned upstream SDK imports now pass after operator installation.
- The compatibility test now calls the live runtime preflight too. It caught and verifies the fix for Pi AI's unexported package manifest; preflight reads metadata relative to the resolved public entry point and still checks package identity/version.
- The skipped ownership test needs a loopback listener, blocked here with EPERM.
- Chrome cold-start evidence showed its control endpoint appeared after 16.6 seconds, past our old 10-second timeout. Startup now waits up to 60 seconds with progress output. Regressions cover delayed readiness and early smoke-test failure releasing its lock; the old smoke implementation demonstrably kept a child process alive until killed.
- Two live tests are explicitly skipped without their live flags/evidence.
- TypeScript 5.9.3 check with installed dependencies passed.
- Reproduced the engine `.loc checksum mismatch` and confirmed `BUILD_VERIFY=false` completes packing. The launcher now applies this upstream Dockerfile setting during preparation and runtime repacking.

The final code review reported five important findings and no critical or minor findings. Fixes cover exact-slot dispatch (whole-stack drops only), live revalidation before primitive effects, ambiguous failure preservation, cross-process trace export serialization, and bounded inspectable pending actions. Added regressions also cover stalled context cancellation, admission held through stream settlement, credential redaction in SQLite, cumulative resumed reports, custom memory/freshness limits, and OpenRouter's serialized request controls. The review was against the pre-fix commit; no second review was performed.

Tests now use the target runtime and installed pinned dependencies. The live endpoint, actual game integration, and provider billing controls remain unverified.

Environment blockers:

- Operator installation populated the dependencies and pinned submodule. A fresh world recreation from the coding sandbox still fails on Bun install temp-directory permissions; preserved incomplete setups have no completed world manifest.
- Local listening sockets are denied, preventing a local engine and browser smoke test.
- OpenRouter, DeepSeek Flash, and the $5 maximum are configured in experiments/openrouter-m1.json. OPENROUTER_API_KEY is absent. No inference spending has occurred.

Remaining work before acceptance:

1. Review/check in the operator-generated package-lock.json and run the socket ownership test outside the sandbox.
2. Run and debug local preparation/migrations/build/start against the real upstream checkout.
3. Pass social smoke and calibrate an ordinary gathering/banking/shop route.
4. Run ten rendered agents for 30 minutes with explicit inference configuration and record the operator interventions.
5. Inspect context/state/action/screenshot evidence and evaluate acceptance. Report actual behavior and economic outcomes.

No screenshots, success metrics, or profitable behavior have been fabricated. Saves and reference repositories are preserved.
