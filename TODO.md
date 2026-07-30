# TODO

## Product priorities

- [x] Redesign all routing modes around one scale-independent log utility: economy keeps the lowest healthy price tier, balanced trades price against TTFT evenly, and speed favors TTFT.
- [x] Decouple request P2C scheduling from display TopN; include pending load without serializing multiple requests that share a group.
- [x] Fuse website real-user average TTFT, standardized cloud probe TTFT, and local Peak/P90 evidence without double-counting legacy usage-stats.
- [x] Exclude `public/providers.available=false` groups even when usage-stats still contains recent samples, preventing invisible groups such as #48 from appearing in Koishi recommendations.
- [x] Add a persisted, revision-checked manual group lock with affinity-first routing and request-local failover escape.
- [x] Add a model-proxy-only upstream User-Agent override while preserving the caller value when unset.
- [x] Serialize the full shared-Key response lifetime and control-plane switches with a FIFO lease in `single` mode; keep `pool` mode same-group concurrency unrestricted.
- [x] Optimize the operations console: expose three-source TTFT provenance, effective rates, candidate exclusions, sessions, Responses branches, active requests, pool retention, authenticated controls, and manual lock actions.
- [x] Hide the manual-lock banner when no lock exists and limit the usage table to current, pooled, locked, or in-flight groups instead of listing historical unpooled affinity.
- [x] Reclaim managed pool keys periodically while preserving active/session-bound keys and restart reuse.
- [x] Prevent same-account router instances from deleting each other's unknown managed Keys; on upstream 401, CAS-invalidate the rejected `sk`, rebuild the group Key, and retry before response commit.
- [ ] Publish `koishi-plugin-aihub-auto@0.3.0` with `最优分组`, a single highest-rate/slowest-TTFT `最烂分组`, and three-source public TTFT fusion (blocked until npm authentication is restored).

## Current routing and pool work

- [x] Never exclude a group because of upstream sample time, sample age, or sample count; remove `stale_sample`, `future_sample`, `no_samples`, and upstream `low_confidence` paths.
- [x] Prefer website `user_avg_ttft_ms`, fall back to usage-stats `avg_ttft_ms`, geometrically fuse it with `probe_e2e_ttft_ms`/`probe_ttft_ms`, then blend local Peak/P90 by local confidence.
- [x] Track and score the last 3 hours of request outcomes, bounded to 500 samples per group.
- [x] Show 3-hour success rate and sample count in the operations console.
- [x] Force-reclaim idle managed keys for hard-invalid groups (outside price band, blacklisted, unavailable, invalid data, or persistently unstable), even when the pool is below its size cap.
- [x] Keep current/creating/reserved/in-flight groups hard-protected during every remote key deletion.
- [x] Remove session and Responses affinity records when their managed group key is force-reclaimed.
- [x] Enforce `poolMaxGroups` immediately for unprotected idle keys; only current/creating/reserved/in-flight/cache-hot affinity may cause explicit soft overcapacity.
- [x] Eliminate the compiled-Bun `Controller is already closed` failure: terminal retry errors are local readable responses, real TCP cancellation reaches a single serialized stream pump, and deployed PID 35532 remains clean after live disconnect/failover probes.
- [x] Re-run all tests plus compiled Windows terminal-error, `/v1/models` compression, and raw TCP stream-cancel stress before release.
- [x] Publish the routing/console release to GitHub `v0.2.2` with six platform archives (`v0.2.1` remains immutable).
- [x] Publish the router/core `v0.3.0` release to GitHub with six platform archives.

## Stability follow-up

- [x] Handle browser `GET /v1` locally instead of proxying an ambiguous API root.
- [x] Replace manual response stream controllers with cancellation-aware async-iterable forwarding.
- [x] Persist process lifecycle, unhandled rejection, and uncaught exception evidence to `crash.log`.
- [ ] Add a compiled-Windows stress soak covering repeated `/v1` browsing, SSE client cancellation, concurrent Responses branches, and TTFB failover.
- [x] Add bounded rotation for `app.log` and `crash.log`; keep `audit.jsonl` opt-in for full decision history.
- [ ] Add optional rotation/retention controls for `audit.jsonl` when long-term decision auditing is enabled.
- [ ] Document running the router as a supervised Windows service so unexpected native exits restart automatically.
