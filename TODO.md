# TODO

## Product priorities

- [x] Optimize economy routing: new sessions stay in the lowest effective price tier; continuity and failover preserve upstream state safely.
- [x] Optimize high-concurrency routing: pending reservations feed load scoring and stale requests cannot overwrite newer bindings.
- [x] Optimize the operations console: expose effective rates, candidate exclusions, sessions, Responses branches, active requests, pool retention, and authenticated controls.
- [x] Reclaim managed pool keys periodically while preserving active/session-bound keys and restart reuse.
- [x] Publish the Koishi recommendation plugin with `最优分组` and a single `最烂分组` result (highest effective rate, then slowest conservative TTFT).

## Current routing and pool work

- [x] Never exclude a group because of upstream sample time, sample age, or sample count; remove `stale_sample`, `future_sample`, `no_samples`, and upstream `low_confidence` paths.
- [x] Use valid upstream `avg_ttft_ms` by default; use local TTFT only when it is sufficiently confident and numerically faster, or when upstream latency is invalid.
- [x] Track and score the last 3 hours of request outcomes, bounded to 500 samples per group.
- [x] Show 3-hour success rate and sample count in the operations console.
- [x] Force-reclaim idle managed keys for hard-invalid groups (outside price band, blacklisted, unavailable, invalid data, or persistently unstable), even when the pool is below its size cap.
- [x] Keep current/creating/reserved/in-flight groups hard-protected during every remote key deletion.
- [x] Remove session and Responses affinity records when their managed group key is force-reclaimed.
- [ ] Eliminate the remaining compiled-Bun `Controller is already closed` rejection on `D:\\aihub-auto-fixed`; safe-wrap stream controllers done, always create `app.log`+`crash.log`, still need redeploy fixed EXE.
- [ ] Verify all tests, compiled Windows `/v1` and stream-cancel stress, then publish GitHub `v0.2.1`.

## Stability follow-up

- [x] Handle browser `GET /v1` locally instead of proxying an ambiguous API root.
- [x] Guard response stream wrappers against close/error/enqueue after client cancellation.
- [x] Persist process lifecycle, unhandled rejection, and uncaught exception evidence to `crash.log`.
- [ ] Add a compiled-Windows stress soak covering repeated `/v1` browsing, SSE client cancellation, concurrent Responses branches, and TTFB failover.
- [x] Add bounded rotation for `app.log` and `crash.log`; keep `audit.jsonl` opt-in for full decision history.
- [ ] Add optional rotation/retention controls for `audit.jsonl` when long-term decision auditing is enabled.
- [ ] Document running the router as a supervised Windows service so unexpected native exits restart automatically.
