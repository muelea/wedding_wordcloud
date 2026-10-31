# Product orientation verification — 2026-10-31

Four completed live Printful proofs verify both offered blanket sizes in both
orientations. The original provider images are unchanged. Each input contains
readable red TOP LEFT, blue TOP RIGHT, green BOTTOM LEFT and purple BOTTOM RIGHT
markers inside the trusted print-safe rectangle. All four images were visually
reviewed: every marker is upright, in its named corner and fully visible.

| Product variant | Orientation | Full print file | Mockup style | Proof |
| --- | --- | --- | --- | --- |
| 10986, 127 × 153 cm nominal | Portrait | 7950 × 9450 px | 3052 | [Image](throw-blanket-50x60in--portrait.png) |
| 10986, 127 × 153 cm nominal | Landscape | 9450 × 7950 px | 3051 | [Image](throw-blanket-50x60in--landscape.png) |
| 22609, 76 × 102 cm nominal | Portrait | 4950 × 6450 px | 27021 | [Image](throw-blanket-30x40in--portrait.png) |
| 22609, 76 × 102 cm nominal | Landscape | 6450 × 4950 px | 27022 | [Image](throw-blanket-30x40in--landscape.png) |

All files use 150 DPI and the existing `default` sublimation placement.
[`proofs.json`](proofs.json) records provider task IDs and SHA-256 hashes of
the full-resolution source PNG and downloaded proof. Adjacent JSON files retain
the exact input designs. Source files were rendered by `src/printRaster.js`,
the same renderer used by prepared files and paid artifacts. Temporary private
operator sources were removed after completion; no credentials, signed URLs or
storage capability URLs are included here.

[`gallery-blanket-landscape.png`](gallery-blanket-landscape.png) shows the
gallery selector retaining Landscape after a portrait blanket was added to the
cart, reopened in the editor, changed to landscape and returned to the gallery.
The old accepted portrait cart item remained unchanged until explicit update.
The isolated browser fixture makes no database or provider requests.
[`mobile-blanket-portrait.png`](mobile-blanket-portrait.png) verifies the same
selector in a 390-pixel mobile viewport, with both choices and the confirmation
action visible without horizontal overflow.
Both blanket sizes now start in portrait for new designs, as shown in
[`blanket-portrait-default.png`](blanket-portrait-default.png). Saved landscape
designs and historical defaults retain their geometry. Released cloth motion
has an eight-second settling bound so portrait previews always return to idle.

Automated coverage includes all 448 catalog orientation states, exact legacy
blanket hashes, orientation-specific gallery caching, rapid manual transfers,
saved-library encoding, configuration save/reopen/export, localized cart and
Checkout summaries, and same-variant opposite-orientation approval through
payment, immutable artifact reuse and paid reorder. Database tests use
disposable local Postgres. Provider generation creates mockups only; no Printful
orders, production charges or physical samples were created. Nothing was
deployed or pushed.
