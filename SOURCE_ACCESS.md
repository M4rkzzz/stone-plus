# StonePlus Source Access

StonePlus publishes source so users can inspect how the local gateway handles
accounts, routing, diagnostics, updates, and local data. Source visibility is
not permission to create or distribute a modified product.

New StonePlus-owned material is provided under the
[StonePlus Source Available License 1.0](LICENSE), subject to upstream and
third-party licenses identified in `NOTICE` and `THIRD_PARTY_NOTICES.md`.
The canonical owner, repository, license digest, signing fingerprints, and
provenance policy are recorded in `PROJECT_IDENTITY.json`.

## Obtain the exact source

- Repository: <https://github.com/M4rkzzz/stone-plus>
- Release page: <https://github.com/M4rkzzz/stone-plus/releases>
- Exact version: select the Git tag matching the application version.
- Each applicable official Release includes `StonePlus-X.Y.Z-source.tar.gz`,
  generated from the exact release commit and covered by `SHA256SUMS` and
  GitHub build provenance.

The archive contains application source, the dependency lockfile, build and
packaging scripts, workflow definitions, and license/notice material. Secrets
and private signing keys are not included or needed for an unsigned build.
The separately bundled sing-box runtime has its own corresponding-source
archive and details in `SOURCE_OFFER-sing-box.md`.

## Permitted use

The current license permits viewing, auditing, learning, local use of an
unmodified build, good-faith security research, and submitting issues or
proposed patches through official project channels. It prohibits modification
and derivative products outside that narrow submission permission,
redistribution, public forks, rebranding, competitive products, commercial
distribution or third-party hosted services, and use for AI training or
automated code generation. Read `LICENSE` before downloading or using the
source.

Automated coding tools should also read `AI_USAGE_POLICY.md` and the applicable
repository instruction file. Those summaries do not replace `LICENSE`.

## Historical versions

StonePlus v0.9.5 and earlier remain under the Apache-2.0 terms shipped with
those versions. Repository revisions first published under
AGPL-3.0-or-later before this source-available license took effect remain
available under their accompanying AGPL terms. No earlier grant is revoked.

## Brand separation

The current source license grants no brand permission. Truthful references and
all Stone+/StonePlus names, logos, official updates, signatures, and visual
identity are governed separately by `TRADEMARKS.md`.
