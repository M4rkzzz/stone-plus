# StonePlus Open Source Access

StonePlus is open source under the standard [Apache License 2.0](LICENSE).
You may inspect, modify, fork, build, redistribute, and use it commercially
under that license. StonePlus-owned documentation, build scripts, and original
visual assets are included in the same grant. See `LICENSE_BOUNDARY.md` for
the effective date and historical artifacts.

## Obtain the exact source

- Repository: <https://github.com/M4rkzzz/stone-plus>
- Releases: <https://github.com/M4rkzzz/stone-plus/releases>
- Use a revision after the 2026-10-21 Apache-2.0 migration or a later release
  explicitly marked Apache-2.0. Older release assets keep their shipped terms.
- Official releases include `StonePlus-X.Y.Z-source.tar.gz` generated from the
  exact release commit with `SHA256SUMS` and GitHub build provenance.

The source archive contains application source, the dependency lockfile,
build/packaging scripts, workflows, and license/notice material. Private keys,
tokens, and real account data are not included or needed for unsigned builds.

## Build and contribute

Use the Node/npm versions in `.nvmrc` and `package.json`, install dependencies
with `npm ci`, and run the documented checks. See `AGENTS.md` and
`AI_USAGE_POLICY.md` for contribution guidance. Forks and local development do
not require an official maintainer account or `npm run identity:verify`.
`npm run license:verify` checks license metadata offline in any clone.

## Third-party components and origin

Upstream and bundled components keep their original licenses in `NOTICE`,
`THIRD_PARTY_NOTICES.md`, and `LICENSES/`. The separately bundled sing-box
runtime has its own corresponding-source archive and delivery details in
`SOURCE_OFFER-sing-box.md`; Apache-2.0 does not replace its GPL obligations.

`TRADEMARKS.md` explains truthful identification of official and third-party
builds without restricting the open-source permissions. Official release
signatures verify origin; they do not determine the software license.
