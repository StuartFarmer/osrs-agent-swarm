# Milestone 1 verification status

**Social smoke passed; paid ten-agent milestone acceptance is still pending.**

Implemented: strict ten-agent experiment configuration; private revisioned SQLite memory; action and usage journals; trace export/recovery; scoped game actions; merchant/gatherer code hooks; policy-filtered tools; shared Pi task loop and inference gate; local world/browser lifecycle; operator CLI; evidence-based acceptance checks.

Current checks (after review fixes):

- Target Node 24.22.3 suite through tsx: 63 passing, 1 skipped, 0 failed.
- Python collector suite: 4 passing. Covers category/pagination discovery, normalization, checkpoint resume, deduplication, malformed/blocked pages, valid names containing “Captcha,” and repeated-page detection.
- Short recordings encoded with real FFmpeg and inspected with ffprobe: playable H.264 MP4s, expected dimensions, agent rotation, wall-clock/video timing alignment, and playable output after interruption. Browser canvas extraction is tested with a DOM fixture; no live Chrome recording has been verified.
- SQLite tests verify unique naming across worlds, stable allocation on restart, exhaustion handling, and preservation of saved account credentials when the pool changes.
- Adapter regression verifies appearance randomization is requested. The pinned upstream helper only applies it while the initial character-design modal is open; no live newly randomized character has been verified.
- Pi 0.84.2 and pinned upstream SDK imports now pass after operator installation.
- The compatibility test now calls the live runtime preflight too. It caught and verifies the fix for Pi AI's unexported package manifest; preflight reads metadata relative to the resolved public entry point and still checks package identity/version.
- The skipped ownership test needs a loopback listener, blocked here with EPERM.
- Chrome cold-start evidence showed its control endpoint appeared after 16.6 seconds, past our old 10-second timeout. Startup now waits up to 60 seconds with progress output. Regressions cover delayed readiness and early smoke-test failure releasing its lock; the old smoke implementation demonstrably kept a child process alive until killed.
- Two live tests are explicitly skipped without their live flags/evidence.
- TypeScript 5.9.3 check with installed dependencies passed.
- Preparation now checks mainland arrival instead of calling the tutorial helper unconditionally or treating one closed dialog as completion. SDK failure details are retained. World startup now requires the gateway login connection; a guarded, idempotent patch adds that field only to disposable world copies. Both behaviors have regression coverage, including the actual pinned gateway source.
- Readiness hang reproduced with a real SDK `sdk_state` message: Pi-independent RS-SDK skill lookup uses a Proxy that structuredClone rejects. The adapter now unwraps that array before observation copying, and readiness no longer swallows arbitrary snapshot errors. Both regressions failed before the fix and pass afterward. Operator manually skipped the tutorial during diagnosis; the full automatic new-character flow remains unverified.
- Authentication setup fixed: local startup enables upstream auto-registration and generated passwords meet the game client’s 20-character limit. Regressions exercise the actual upstream environment mapping, durable credential validation, and tab reload after credential changes. Three unregistered smoke accounts were repaired after confirming no matching database rows; original credentials preserved privately. The subsequent operator social smoke passed.
- Reproduced the engine `.loc checksum mismatch` and confirmed `BUILD_VERIFY=false` completes packing. The launcher now applies this upstream Dockerfile setting during preparation and runtime repacking.

The final code review reported five important findings and no critical or minor findings. Fixes cover exact-slot dispatch (whole-stack drops only), live revalidation before primitive effects, ambiguous failure preservation, cross-process trace export serialization, and bounded inspectable pending actions. Added regressions also cover stalled context cancellation, admission held through stream settlement, credential redaction in SQLite, cumulative resumed reports, custom memory/freshness limits, and OpenRouter's serialized request controls. The review was against the pre-fix commit; no second review was performed.

The independent review of the recording/identity changes found one important bug: a broad CAPTCHA detector rejected a valid player named “Captcha.” The parser and regression fixture now cover that case. The reviewer found no additional important defect; live markup and Chrome capture remain unverified.

The operator's `.local/worlds/m1smoke/social-smoke.json`, timestamped 2026-11-16T12:14:07.599Z, reports all five checks passing against the pinned revision: public chat, private-message isolation, follow/stop, drop/pickup, and trade inventory deltas. Its evidence directory contains the associated smoke artifacts. This does not establish ordinary gathering behavior, provider billing, or profitable play.

Environment blockers:

- The first live hiscores request failed DNS resolution. The default SQLite checkpoint exists but contains **zero collected names**. The parser has fixture coverage; actual live markup and complete category coverage remain unverified. Unexpected markup stops collection instead of claiming completion.
- Operator installation populated the dependencies and pinned submodule. A fresh world recreation from the coding sandbox still fails on Bun install temp-directory permissions; preserved incomplete setups have no completed world manifest.
- Local listening sockets are denied, preventing a local engine and browser smoke test.
- OpenRouter, DeepSeek Flash, and the $5 maximum are configured in experiments/openrouter-m1.json. OPENROUTER_API_KEY is absent. No inference spending has occurred.

Remaining work before acceptance:

1. Review/check in the operator-generated package-lock.json and run the socket ownership test outside the sandbox.
2. Validate fresh automatic character preparation and randomized appearances; collect a seed name pool and check live pagination. The complete crawl is separately resumable.
3. Calibrate an ordinary gathering/banking/shop route; social smoke has passed.
4. Run ten rendered agents for 30 minutes with recording and explicit inference configuration, and perform the operator interventions.
5. Inspect context/state/action/screenshot evidence and evaluate acceptance. Report actual behavior and economic outcomes.

No screenshots, success metrics, or profitable behavior have been fabricated. Saves and reference repositories are preserved.
