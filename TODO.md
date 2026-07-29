# TODO

## Product priorities

- [x] Optimize economy routing: new sessions use the lowest healthy price tier under explicit success-rate, sample-count, and conservative-latency gates; higher healthy tiers remain available for failover.
- [x] Optimize high-concurrency routing: pending reservations feed load scoring and stale requests cannot overwrite newer bindings.
- [x] Optimize the operations console: expose effective rates, candidate exclusions, sessions, Responses branches, active requests, pool retention, and authenticated controls.
- [x] Reclaim managed pool keys periodically while preserving active/session-bound keys and restart reuse.
- [x] Publish the Koishi recommendation plugin with `最优分组` and a single `最烂分组` result (highest effective rate, then slowest conservative TTFT).

## Current routing and pool work

- [x] Never exclude a group because of upstream sample time, sample age, or sample count; remove `stale_sample`, `future_sample`, `no_samples`, and upstream `low_confidence` paths.
- [x] Use valid cloud `avg_ttft_ms` as the prior; ignore local TTFT at zero local samples, otherwise fuse cloud and local latency in both directions by local confidence.
- [x] Track and score the last 3 hours of request outcomes, bounded to 500 samples per group.
- [x] Show 3-hour success rate and sample count in the operations console.
- [x] Force-reclaim idle managed keys for hard-invalid groups (outside price band, blacklisted, unavailable, invalid data, or persistently unstable), even when the pool is below its size cap.
- [x] Keep current/creating/reserved/in-flight groups hard-protected during every remote key deletion.
- [x] Remove session and Responses affinity records when their managed group key is force-reclaimed.
- [x] Enforce `poolMaxGroups` immediately for unprotected idle keys; only current/creating/reserved/in-flight/cache-hot affinity may cause explicit soft overcapacity.
- [x] Eliminate the compiled-Bun `Controller is already closed` failure: terminal retry errors are local readable responses, real TCP cancellation reaches a single serialized stream pump, and deployed PID 35532 remains clean after live disconnect/failover probes.
- [x] Re-run all tests plus compiled Windows terminal-error, `/v1/models` compression, and raw TCP stream-cancel stress before release.
- [ ] Publish the routing/console release to GitHub `v0.2.2` (`v0.2.1` is already public).

## Stability follow-up

- [x] Handle browser `GET /v1` locally instead of proxying an ambiguous API root.
- [x] Replace manual response stream controllers with cancellation-aware async-iterable forwarding.
- [x] Persist process lifecycle, unhandled rejection, and uncaught exception evidence to `crash.log`.
- [ ] Add a compiled-Windows stress soak covering repeated `/v1` browsing, SSE client cancellation, concurrent Responses branches, and TTFB failover.
- [x] Add bounded rotation for `app.log` and `crash.log`; keep `audit.jsonl` opt-in for full decision history.
- [ ] Add optional rotation/retention controls for `audit.jsonl` when long-term decision auditing is enabled.
- [ ] Document running the router as a supervised Windows service so unexpected native exits restart automatically.
