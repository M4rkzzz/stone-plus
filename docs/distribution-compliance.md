# sing-box Distribution Compliance

Stone+ pins the built-in proxy core to sing-box v1.13.14. Runtime archives are
downloaded only from the upstream GitHub release and are authenticated by the
official release-asset SHA-256 digest recorded in
`build/sing-box/distribution-manifest.json`. Every extracted file is then
matched by path, byte size, and SHA-256 against
`build/sing-box/runtime-manifest.json` before it can enter a package or start.

## Target matrix and package count

| Runtime target | Upstream archive variant | External Cronet file | Stone+ package formats |
| --- | --- | --- | --- |
| Windows x64 | `windows-amd64` | `libcronet.dll` | NSIS setup, portable |
| Linux x64 | `linux-amd64` pure Go | `libcronet.so` | AppImage, deb |
| Linux arm64 | `linux-arm64` pure Go | `libcronet.so` | AppImage, deb |
| macOS x64 | `darwin-amd64` CGO | none in the official archive | dmg, zip |
| macOS arm64 | `darwin-arm64` CGO | none in the official archive | dmg, zip |

There are five distinct OS/architecture runtime directories. The plan's six
minimum package bodies count the Windows setup and portable packages
separately, plus one package for each Linux and macOS architecture. The
existing multi-format electron-builder configuration produces additional
artifacts; every artifact must pass the same checks. No synthetic macOS
`libcronet` is added because neither official Darwin archive contains one.

The Linux archives without a libc suffix are intentional: they are the
upstream pure-Go distributions that include the required `libcronet.so`
sidecar. The similarly named `-glibc` archives do not contain that sidecar and
must not be substituted without a reviewed manifest and runtime design change.

## Reproducible release procedure

1. Start from the reviewed Stone+ source revision and run `npm ci`.
2. Run `npm run sing-box:fetch`. This downloads all five official archives,
   verifies archive size and SHA-256 before extraction, rejects unsafe archive
   paths, verifies the complete extracted runtime, and replaces build inputs
   atomically.
3. Run `npm run sing-box:verify`. A missing, extra, linked, resized, or modified
   runtime file is a release blocker.
4. Build each supported platform/architecture with electron-builder. Its
   `beforePack` hook re-verifies only the selected runtime and rejects any
   unsupported architecture. Inspect the unpacked application and confirm
   `resources/sing-box/runtime-manifest.json`, the matching runtime directory,
   the GPL text, the upstream notices, and this source-access notice are
   present.
5. Run `npm run sing-box:source`. Publish the resulting corresponding-source
   archive next to all binary artifacts and record its SHA-256 in the release
   notes. Do not treat an upstream URL alone as corresponding-source delivery.
6. Record SHA-256 values for every final Stone+ artifact. Retain the exact
   manifests and build logs with the release record.

## Windows signing and provenance

Stone+ Windows release artifacts are Authenticode-signed with the persistent
project certificate published as `StonePlus-CodeSigning.cer`. Its SHA-1
thumbprint is `FAA66B5891F1ACD270F2BD7232663EB7D0D9EC3D`; the DER certificate
SHA-256 is
`f4ccc82f3ade7eb06f76e55afce698179b37f299fb75ad70e5cec32e0740ca05`.
The private key exists only in GitHub Actions encrypted secrets and the local
release certificate store. Release signatures receive an RFC 3161 timestamp.

This is a self-signed project continuity certificate, not a Microsoft-trusted
or commercial-CA identity certificate. A clean Windows installation can still
show an unknown-publisher or SmartScreen warning. Users should compare the
certificate fingerprint, `SHA256SUMS`, and GitHub build-provenance attestation;
they should not install this self-signed certificate as a trusted root merely
to suppress a warning. The upstream `sing-box.exe` is deliberately excluded
from Stone+ signing so its pinned upstream SHA-256 remains verifiable.

The six minimum package commands are `npm run dist:win:x64:setup`,
`npm run dist:win:x64:portable`, `npm run dist:linux:x64`,
`npm run dist:linux:arm64`, `npm run dist:mac:x64`, and
`npm run dist:mac:arm64`. Run each command on its supported build host; the
Linux and macOS commands retain the project's existing multiple output
formats.

## Functional distribution gates

For the Windows x64, Linux x64/arm64, and macOS x64/arm64 packages:

- launch the packaged core, run `sing-box version` and `sing-box check`, and
  confirm v1.13.14;
- exercise mixed inbound and controller health, then request graceful exit;
- verify application exit, normal disable, crash recovery, system-proxy/TUN
  cleanup, and absence of orphan sing-box processes;
- confirm a missing or tampered binary, libcronet sidecar, or manifest prevents
  startup instead of falling back to direct access; and
- confirm installed notices are readable and the corresponding-source download
  is public without authentication or payment.

## License record

- `LICENSES/GPL-3.0-or-later.txt` contains the complete GPL version 3 text.
- `LICENSES/sing-box-v1.13.14.txt` preserves the upstream sing-box notice.
- `LICENSES/libcronet/` preserves cronet-go's notice and the pinned
  NaiveProxy/Chromium license metadata corpus used by libcronet.
- `THIRD_PARTY_NOTICES.md` identifies the bundled versions and provenance.
- `SOURCE_OFFER-sing-box.md` states the project source-delivery policy.

This checklist supports, but does not replace, a release-specific legal and
export-control review. Missing license/source delivery, a missing or mismatched
required signature, or an undisclosed platform-policy limitation blocks
distribution. Self-signed Windows and ad-hoc macOS trust limitations must stay
prominent in every release until publicly trusted signing and notarization are
available.
