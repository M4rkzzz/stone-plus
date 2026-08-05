# sing-box Corresponding Source Access

Stone+ binary distributions include unmodified official sing-box v1.13.14
runtime files. sing-box and cronet-go are licensed under
GPL-3.0-or-later. This notice applies to every Stone+ installer, portable
archive, update package, and other binary distribution that contains those
files.

For every such binary release, StonePlus must provide a no-charge
`StonePlus-<version>-sing-box-1.13.14-corresponding-source.tar.gz` download
next to the binary artifacts. Source access must remain available for as long
as the binary release is offered and, as a project policy, for at least three
years after its last distribution. Do not publish a binary release if that
source artifact is absent or inaccessible.

The source artifact is prepared with `npm run sing-box:source` and contains:

- sing-box commit `25a600db24f7680ad9806ce5427bd0ab8afe1114`;
- vendored Go module source needed by the sing-box command build;
- cronet-go commit `98d539ce67568fb911654e66a14cf4247ed833ec`;
- its recursive NaiveProxy source at commit
  `888e114241c89b05fac4e4ee01482d7bd89ca15a`;
- the upstream build workflows, build tags, linker flags, and Cronet build
  scripts at those commits; and
- Stone+'s runtime manifests, fetch/verification scripts, package build
  configuration, license material, and distribution checklist.

The authoritative upstream repositories are:

- https://github.com/SagerNet/sing-box
- https://github.com/SagerNet/cronet-go
- https://github.com/SagerNet/naiveproxy

Those upstream links are provenance references, not a substitute for the
release-controlled corresponding-source download. If a release attachment is
unavailable, request restoration through
https://github.com/M4rkzzz/stone-plus/issues and identify the exact Stone+
version and platform artifact.
