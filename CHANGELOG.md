# Changelog

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
