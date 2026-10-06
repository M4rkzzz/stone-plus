# StonePlus Windows signing certificate

Windows release artifacts are Authenticode-signed with the persistent
StonePlus project certificate in `StonePlus-CodeSigning.cer`.

- Subject: `CN=StonePlus Open Source Release, O=StonePlus Contributors`
- SHA-1 thumbprint: `FAA66B5891F1ACD270F2BD7232663EB7D0D9EC3D`
- DER SHA-256: `f4ccc82f3ade7eb06f76e55afce698179b37f299fb75ad70e5cec32e0740ca05`
- Validity: 2026-07-23 through 2029-07-23

The words `Open Source Release` are part of the certificate's immutable legacy
subject, created before the source-available license migration. They identify
this existing certificate only and do not describe or grant a software
license. The current license is the StonePlus Source Available License 1.0 in
the repository root.

This certificate is self-signed. It provides a stable cryptographic identity
for comparing StonePlus releases, but it is not a Microsoft-trusted or
commercial-CA identity certificate and does not by itself suppress SmartScreen
or unknown-publisher warnings. Do not install it as a trusted root merely to
silence a warning.

For every release, also verify `SHA256SUMS` and the GitHub build-provenance
attestation. The signing private key is stored only in GitHub Actions encrypted
secrets and the release maintainer's local certificate store. It is never
committed or distributed.

The bundled upstream `sing-box.exe` is intentionally not re-signed by
StonePlus, because changing it would invalidate the pinned upstream SHA-256
manifest checked before startup.
