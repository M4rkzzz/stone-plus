# StonePlus Modifications

StonePlus is an unofficial community fork of
[Stone](https://github.com/EasyCode-Obsidian/Stone), distributed under the
Apache License, Version 2.0. It is not affiliated with or endorsed by the
upstream Stone maintainers.

The first StonePlus release, `v0.8.3`, is based on upstream Stone `v0.8.2`
(`4077f2f`) and includes the following material changes:

- embedded FRP client management for exposing a configured local gateway;
- optional pool-level Fast On routing through the canonical priority service tier;
- request time-to-first-token, conversation title, adjustable columns, and compact log UI;
- client-disconnect handling as HTTP 499 without account cooldown or failover;
- lower-latency connection reuse, HTTP/2 negotiation, immediate SSE header/chunk forwarding,
  multi-lane connection warming, reduced stream-redaction buffering, targeted/batched
  state persistence, semantic phase timing, first-body failover, opt-in request hedging,
  OAuth refresh singleflight, adaptive concurrency, and optional speed-aware
  `autobalanced` account scheduling;
- full-history Token usage and cache-aware OpenAI standard API cost estimates, with
  strict per-request GPT-5.4 through GPT-5.6 model pricing and long-context rules;
- account scheduling-fitness and quota-thaw visibility in the management UI;
- Codex historical-session visibility repair with provider metadata synchronization,
  preview validation, recoverable backups, transactional SQLite index updates, and
  one-click repair followed by a Windows ChatGPT desktop restart;
- native CPA/Sub2API JSON batch account import, JWT account-ID recovery, and
  post-import concurrent account health checks, including per-batch outbound proxy selection;
- direct OpenAI Codex OAuth PKCE authorization with main-process-only callback/token handling,
  integrated account tags, optional pool assignment, and outbound proxy selection;
- additional tests and desktop integration supporting these features.

Original copyright and license notices are retained in `LICENSE`, `NOTICE`,
and `THIRD_PARTY_NOTICES.md`. FRP attribution and its Apache-2.0 license text
are included with source and binary distributions.
