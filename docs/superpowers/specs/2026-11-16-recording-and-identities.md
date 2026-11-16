# Recording and identities

User-authorized scope: one continuous recording rotating through existing agent views every 30 seconds; random appearance on initial creation; a unique name pool collected from every category of the main Old School hiscores instance.

- Record the existing game canvas at 10 fps through Puppeteer and installed FFmpeg. Produce a fragmented MP4, agent label, elapsed video time, and a switch/capture timeline inside the run. Capture excludes browser chrome and credential controls. No additional game login is created.
- `run --record` starts recording after preparation and stops with the run. `record --run ID` can attach to an already-running experiment. Recording uses the run's remaining deadline and artifact quota; failures are surfaced. Existing recordings are never overwritten.
- Set the upstream tutorial helper's appearance randomization option on initial design. Its design-modal check leaves existing mainland characters unchanged. Random appearance is not guaranteed collision-free.
- Collect all visible pages in all discovered skill/activity categories of `hiscore_oldschool`, round-robin, using a Python standard-library scraper. Checkpoint pages and unique normalized names in SQLite. Respect throttling and stop on blocking or unrecognized pages. A changing leaderboard is not an atomic snapshot or a list of unranked accounts.
- Draw names without replacement across worlds from the pool; persist allocations and account credentials. Existing rosters retain their names. Preserve source display names alongside game-safe identifiers. If no pool exists, retain synthetic names with a visible notice.

Validation: real FFmpeg encoding with synthetic frames; fake-browser rotation/cancellation/quota failure; screenshot canvas boundary; appearance option regression; HTML parsing, pagination, deduplication/resume/blocking fixtures; SQLite name allocation and restart stability. Real Chrome recording and full network collection require execution outside the coding sandbox.

Implementation sequence: collector/name allocation; appearance selection; recording/browser boundary; CLI/run lifecycle; integration tests and runbook.
