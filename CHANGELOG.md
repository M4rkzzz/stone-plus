# Changelog

## 0.8.7

- Added a warmed primary outbound lane with load-triggered secondary lanes, safer
  dispatcher rotation, longer gateway keepalive, and manual/resume/online rebuilds.
- Added per-account OAuth refresh singleflight and proactive background renewal so
  concurrent requests no longer serialize behind redundant token refreshes.
- Added semantic TTFT and detailed phase timing (`body read`, `account scheduling`,
  `credential resolution`, `outbound start`, `upstream headers`, `first byte`,
  `first token`, and `client first write`) plus cached-input and reasoning-token metrics.
- Added first-body timeout failover and an opt-in low-latency hedged request mode;
  hedging remains disabled by default because a duplicate request can consume quota.
- Improved `autobalanced` with conservative priors, controlled exploration,
  decaying failure penalties, and adaptive per-account concurrency.
- Batched SQLite request-log writes and throttled/coalesced telemetry and renderer
  snapshots to reduce main-process work on the streaming hot path.
- Fixed stale OAuth refreshes overwriting edited credentials, stale transport
  rotations replacing newer proxy generations, and shutdown-time connection leaks.
- Fixed delayed success telemetry re-enabling disabled accounts, hidden-window
  snapshot staleness, zero-length first stream chunks, and Responses usage shape.
- Gateway setting saves now update live unless the listening address changes;
  address changes drain active streams before restarting instead of creating 499s.
- Added an account-table filter for hiding quota-exhausted accounts and a
  concurrency-limited one-click health check for every configured account.
- Fixed inflated output-token rates after semantic visible-TTFT tracking by
  measuring generation duration from the first upstream body byte instead.
- Restored the request table's original first-byte-based "首字" display while
  retaining semantic visible-TTFT as a separate request-detail diagnostic.
- Added secure CPA/Sub2API account export with selectable OAuth accounts,
  one-click all/non-cooldown selection, merged or per-account files, and native
  file/directory save dialogs.
- Added account-list multi-selection by all/non-cooldown/cooldown/quota-exhausted
  conditions plus atomic, reference-safe bulk deletion.

## 0.8.6

- Fixed session repair exhausting memory and terminating Stone+ when Codex history
  contains multiple gigabytes of rollout files; previews now scan bounded metadata.
- Added Codex historical-session repair with provider discovery, dry-run counts,
  stale-preview protection, automatic rollout/SQLite backups, transactional index
  updates, rollback, encrypted-content guidance, and a dedicated Stone+ UI.
- Added native multi-file CPA and Sub2API JSON account imports, automatic recovery
  of missing CPA `account_id` values from JWT claims, and immediate concurrent
  account health checks after import.

## 0.8.5

- Added an overview chart for average output-token speed over 30 minutes, 4 hours,
  24 hours, and one week.
- Reduced gateway main-thread work with targeted SQLite writes, cached observability
  summaries, and coalesced renderer snapshot updates.
- Extended direct and proxied HTTP/2 connection keepalive and added connection warming.
- Added an optional `autobalanced` strategy that prefers accounts with better EWMA
  TTFT/output speed without changing the existing `balanced` behavior.
- Kept update checks working when GitHub's anonymous REST API is rate limited by
  falling back to the trusted latest-release redirect, and completed Stone+ branding
  across the application-update UI.

## 0.8.4

- Fixed completed streams being recorded as HTTP 499 when a client closed the
  connection immediately after receiving the protocol terminal event.
- A close before the terminal event remains a real 499 and still does not cool
  down the account or trigger failover.

## 0.8.3 — Stone+ initial release

- Added embedded FRP tunnel management and copyable remote endpoint/token.
- Added pool-level Fast On priority routing for OpenAI Responses-compatible pools.
- Added TTFT and conversation titles to request logs, persisted adjustable columns,
  compact layout, and a header privacy toggle.
- Treat client disconnects as HTTP 499 without penalizing accounts or failing over.
- Reused outbound connections, enabled HTTP/2 negotiation, forwarded SSE data sooner,
  reduced redaction buffering, and removed large state clones from the request path.

See [MODIFICATIONS.md](MODIFICATIONS.md) for upstream and licensing details.
