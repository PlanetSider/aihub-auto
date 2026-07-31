# TODO

## Desktop v0.4.0 execution

- [ ] Review PR #1 for security/regressions and merge it only if the implementation is sound.
- [ ] Activate the real `xytime` Sentry DSN, keep upstream failures excluded, and verify one intentional router error plus one official Feedback event.
- [ ] Add a Tauri 2 desktop shell that owns the existing Bun router as a bundled sidecar without changing proxy semantics.
- [ ] Keep the app running in the system tray when the window closes; add show/hide, open logs, check updates, and explicit quit actions.
- [ ] Add a bounded authenticated live-log view backed by the existing redacted rolling `app.log`.
- [ ] Redesign the operations UI for desktop and browser use, including a clear first-run setup guide, copyable base URL/API Key examples, GitHub link, and responsive states.
- [ ] Add signed Tauri updater support with GitHub Releases metadata, user confirmation, install progress, restart, and failure recovery.
- [ ] Package and smoke-test the desktop app on supported platforms while preserving the standalone router artifacts and browser console fallback.
- [ ] Update usage/security/release documentation, complete independent review, and publish only after Sentry and updater end-to-end verification.
