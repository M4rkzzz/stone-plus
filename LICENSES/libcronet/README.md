# libcronet License Corpus

The Windows and Linux sing-box v1.13.14 runtime archives selected by Stone+
contain an official `libcronet` sidecar. The sidecar was selected by sing-box
commit `25a600db24f7680ad9806ce5427bd0ab8afe1114` from cronet-go commit
`98d539ce67568fb911654e66a14cf4247ed833ec`; that commit pins the NaiveProxy
source tree at `888e114241c89b05fac4e4ee01482d7bd89ca15a`.

`cronet-go/LICENSE` preserves cronet-go's GPL-3.0-or-later notice. The
`naiveproxy/` subtree conservatively mirrors every `LICENSE*`, `COPYING*`,
`NOTICE*`, `CREDITS*`, and `README.chromium` file in that exact NaiveProxy
tree. It includes metadata for source paths that may not be selected in every
target build so a release never under-reports the upstream license corpus.

The complete corresponding source and build material must be published next
to every Stone+ binary release that contains sing-box. See
`SOURCE_OFFER-sing-box.md` and `docs/distribution-compliance.md`.
