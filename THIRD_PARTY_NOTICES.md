# Third-Party Notices

The StonePlus project, whose desktop application currently retains the Stone+ product name, is licensed under the Apache License, Version 2.0. Third-party
components remain under their respective licenses; the Stone license does not
replace or modify those terms.

## Runtime Packages

| Component | Version | License |
| --- | --- | --- |
| `@fontsource-variable/inter` | 5.2.8 | SIL Open Font License 1.1 |
| `@fontsource-variable/jetbrains-mono` | 5.2.8 | SIL Open Font License 1.1 |
| `argparse` | 2.0.1 | Python Software Foundation License 2.0 |
| `builder-util-runtime` | 9.7.0 | MIT |
| `debug` | 4.4.3 | MIT |
| `electron-updater` | 6.8.9 | MIT |
| `fetch-socks` | 1.3.3 | MIT |
| `fs-extra` | 10.1.0 | MIT |
| `graceful-fs` | 4.2.11 | ISC |
| `ip-address` | 10.2.0 | MIT |
| `js-yaml` | 4.3.0 | MIT |
| `jsonfile` | 6.2.1 | MIT |
| `lazy-val` | 1.0.5 | MIT |
| `libsodium-sumo` | 0.7.16 | ISC |
| `libsodium-wrappers-sumo` | 0.7.16 | ISC |
| `lucide-react` | 0.468.0 | ISC |
| `lodash.escaperegexp` | 4.1.2 | MIT |
| `lodash.isequal` | 4.5.0 | MIT |
| `ms` | 2.1.3 | MIT |
| `react` | 19.2.7 | MIT |
| `react-dom` | 19.2.7 | MIT |
| `sax` | 1.6.0 | BlueOak Model License 1.0.0 |
| `scheduler` | 0.27.0 | MIT |
| `semver` | 7.7.3 | ISC |
| `smart-buffer` | 4.2.0 | MIT |
| `smol-toml` | 1.7.0 | BSD 3-Clause |
| `socks` | 2.8.9 | MIT |
| `tiny-typed-emitter` | 2.1.0 | MIT |
| `undici` | 7.28.0 | MIT |
| `universalify` | 2.0.1 | MIT |
| `ws` | 8.21.1 | MIT |
| `zustand` | 5.0.14 | MIT |

The complete license text for each npm package is retained with that package
inside the application archive and in the installed dependency tree.

## Fonts

Inter is Copyright 2016 The Inter Project Authors
(https://github.com/rsms/inter) and is licensed under the SIL Open Font
License, Version 1.1.

JetBrains Mono is Copyright 2020 The JetBrains Mono Project Authors
(https://github.com/JetBrains/JetBrainsMono) and is licensed under the SIL Open
Font License, Version 1.1.

The complete OFL text is retained in each Fontsource package.

## FRP

Stone+'s Windows package includes the `frpc` v0.69.0 executable from the FRP project,
Copyright 2015 fatedier, licensed under the Apache License, Version 2.0.
The corresponding license text is distributed as `frp/LICENSE.frp.txt`.
Project: https://github.com/fatedier/frp

The bundled executable is obtained from the official `frp_0.69.0_windows_amd64.zip`
release archive. The source archive is verified before extraction against SHA-256
`0e38f6dbe7761d648ca5c6ee323b7309544f48c01e9476f553902f3bc0949089`.

## Electron And Chromium

Stone+ is distributed with Electron, which includes Chromium, Node.js,
and other third-party components. Electron's MIT license is distributed as
`LICENSE.electron.txt`; Chromium and embedded component notices are distributed
as `LICENSES.chromium.html`. These files are generated and included by the
Electron packaging toolchain and must remain with binary distributions.

## sing-box And libcronet

Stone+ packages unmodified official sing-box v1.13.14 runtime files from the
SagerNet project, Copyright (C) 2022 nekohasekai. sing-box is licensed under
the GNU General Public License, version 3 or (at your option) any later
version. Project: https://github.com/SagerNet/sing-box

The Windows x64 runtime includes `libcronet.dll`; the Linux x64 and arm64
pure-Go runtimes include `libcronet.so`. The official macOS x64 and arm64
archives contain no external Cronet library. libcronet is selected through
cronet-go commit `98d539ce67568fb911654e66a14cf4247ed833ec`, which pins
NaiveProxy commit `888e114241c89b05fac4e4ee01482d7bd89ca15a` and its Chromium
network-stack sources.

The complete GPL text is distributed as
`licenses/GPL-3.0-or-later.txt`; the upstream sing-box notice is distributed
as `licenses/sing-box-v1.13.14.txt`. cronet-go, NaiveProxy, Chromium, and
their retained third-party notices are distributed under
`licenses/libcronet/`. Corresponding-source access and the release artifact
requirements are described in `SOURCE_OFFER-sing-box.md`.

Every sing-box archive and every extracted runtime file is authenticated by
the pinned size and SHA-256 values in the installed sing-box manifests before
packaging and before startup.
