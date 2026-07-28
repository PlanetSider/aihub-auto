# TODO

## Product priorities

- [x] Optimize economy routing: new sessions stay in the lowest effective price tier; continuity and failover preserve upstream state safely.
- [x] Optimize high-concurrency routing: pending reservations feed load scoring and stale requests cannot overwrite newer bindings.
- [x] Optimize the operations console: expose effective rates, candidate exclusions, sessions, Responses branches, active requests, pool retention, and authenticated controls.
- [x] Reclaim managed pool keys periodically while preserving active/session-bound keys and restart reuse.
- [x] Publish the Koishi recommendation plugin with `最优分组` and a single `最烂分组` result (highest effective rate, then slowest conservative TTFT).

## Stability follow-up

- [x] Handle browser `GET /v1` locally instead of proxying an ambiguous API root.
- [x] Guard response stream wrappers against close/error/enqueue after client cancellation.
- [x] Persist process lifecycle, unhandled rejection, and uncaught exception evidence to `crash.log`.
- [ ] Add a compiled-Windows stress soak covering repeated `/v1` browsing, SSE client cancellation, concurrent Responses branches, and TTFB failover.
- [x] Add bounded rotation for `app.log` and `crash.log`; keep `audit.jsonl` opt-in for full decision history.
- [ ] Add optional rotation/retention controls for `audit.jsonl` when long-term decision auditing is enabled.
- [ ] Document running the router as a supervised Windows service so unexpected native exits restart automatically.
