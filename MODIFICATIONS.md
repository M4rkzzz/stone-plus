# Stone+ Modifications

Stone+ is an unofficial community fork of
[Stone](https://github.com/EasyCode-Obsidian/Stone), distributed under the
Apache License, Version 2.0. It is not affiliated with or endorsed by the
upstream Stone maintainers.

The first Stone+ release, `v0.8.3`, is based on upstream Stone `v0.8.2`
(`4077f2f`) and includes the following material changes:

- embedded FRP client management for exposing a configured local gateway;
- optional pool-level Fast On routing through the canonical priority service tier;
- request time-to-first-token, conversation title, adjustable columns, and compact log UI;
- client-disconnect handling as HTTP 499 without account cooldown or failover;
- lower-latency connection reuse, HTTP/2 negotiation, immediate SSE header/chunk forwarding,
  connection warming, reduced stream-redaction buffering, targeted state persistence,
  and optional speed-aware `autobalanced` account scheduling;
- additional tests and desktop integration supporting these features.

Original copyright and license notices are retained in `LICENSE`, `NOTICE`,
and `THIRD_PARTY_NOTICES.md`. FRP attribution and its Apache-2.0 license text
are included with source and binary distributions.
