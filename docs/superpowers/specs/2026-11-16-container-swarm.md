# Containerized milestone-one swarm

The user clarified that the swarm, including its recorder, must run in Docker. They must still watch and interact with the rendered agents in their own browser. Existing requirements remain: ten private contexts, a 30-minute experiment, a $5 ledger cap, collected names, and shared `admin` passwords.

Implementation choice: one local container contains the game server, gateway, Pi harness, ten rendered Chromium tabs, and FFmpeg. Xvfb/openbox provide the desktop; x11vnc/noVNC expose that same desktop through host-loopback port 6080. This keeps existing game URLs and session ownership unchanged. Splitting the processes across containers would require changing the established loopback transport and browser controller; host Chromium would leave part of the swarm outside Docker.

Build the pinned upstream world into an image template, using the existing preparation path and compatibility patches. Seed a separate persistent container world atomically on first launch. Keep host worlds untouched. Bind collected names and run artifacts into the container; mount agent code and experiment settings for local research edits. Use the reviewed existing npm lock for reproducible application dependency installation.

The default container command starts the recorded experiment and keeps the desktop available after it finishes. A durable active-run pointer resumes the original run/deadline/budget on restart. This wrapper operates one durable experiment and does not offer a new-run shortcut that would silently reuse unequal progressed characters. A `--view-only` launch allows checking world/client startup without inference. Shutdown first drains the harness/recorder, then closes Chromium and stops the world and desktop.

Validation: state seeding/preservation, run-pointer recovery, container-only browser flags, aborted world startup, full existing tests, Compose validation, and an independent code review. Docker image build and live desktop validation require Docker daemon access, currently denied by the coding sandbox. No paid test is launched from the coding environment.
