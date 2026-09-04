# Print geometry

Verified against Printful on **2026-09-03**, for all 12 storefront variants.
`src/products.js` contains the full artwork size and per-surface safe rectangles.
All coordinates below are pixels in the uploaded artwork, not screen pixels.

## Sources and dimensions

The Catalog API's `/mockup-generator/printfiles/{product_id}` supplies the full
artwork dimensions, DPI, rotation permission and variant/placement mapping. It
does **not** supply the safe rectangle for binding, seams or trim. Those come
from the product's official downloadable print guidelines. The selected API
records are pinned in `test/fixtures/printful-geometry.json`; tests never need a
Printful credential or network request.

| Product / variant | Full artwork | DPI | Safe rectangle x, y, width, height |
| --- | --- | --- | --- |
| Mug 11 oz / 1320 | 2700 × 1050 | 300 | 24, 24, 2652, 1002 |
| Mug 15 oz / 4830 | 2700 × 1140 | 300 | 24, 24, 2652, 1092 |
| Mug 20 oz / 16586 | 3071 × 1205 | 300 | 24, 24, 3023, 1157 |
| Coaster / 15662 | 1181 × 1181 | 300 | 90, 90, 1001, 1001 |
| Matte poster 30 × 40 / 8948 | 3544 × 4724 | 300 | 154, 154, 3236, 4416 |
| Matte poster 50 × 70 / 8952 | 5906 × 8268 | 300 | 154, 154, 5598, 7960 |
| Framed poster 30 × 40 / 9357 | 3600 × 4800 | 300 | 154, 154, 3292, 4492 |
| Framed poster 50 × 70 / 9358 | 5906 × 8268 | 300 | 154, 154, 5598, 7960 |
| Tote / 4533 | 2550 × 2475 | 150 | 305, 490, 1935, 1640 |
| Blanket 50 × 60 / 10986 | 9450 × 7950 | 150 | 600, 600, 8250, 6750 |
| Pillow 18 × 18 / 4532 | 2850 × 2850 | 150 | 150, 150, 2550, 2550, on both sides |
| Notebook / 12141 | 1725 × 2625 | 300 | Front: 201, 170, 1416, 2273; back: 128, 170, 1416, 2273 |

Poster files are the API dimensions rotated to portrait with `can_rotate`;
landscape transposes both the file and safe rectangle. The framed 30 × 40 variant
uses Printful's 12 × 16-inch artwork file, not the unframed variant's dimensions.

Official downloadable guides:

- [Mugs](https://printful.s3-accelerate.amazonaws.com/upload/guideline/Mug_all_sizes.zip): no separate inset safe area; retain the existing 24-pixel editing allowance.
- [Coaster](https://printful.s3-accelerate.amazonaws.com/upload/guideline/Coasters_template.zip): rounded safe area; use an inscribed rectangle so text and square images also clear its corners. The guide raster is 1193 pixels across while the API upload is 1181; boundaries are normalized to the API file.
- [Matte posters](https://printful.s3-accelerate.amazonaws.com/upload/guideline/Posters_regular_cm.zip) and [framed posters](https://printful.s3-accelerate.amazonaws.com/upload/guideline/Posters_guideline.zip): subtract 2.5 cm from each dimension, or 1.25 cm per edge. Round inward beyond the guide stroke.
- [Tote](https://printful.s3-accelerate.amazonaws.com/upload/guideline/Tote%20bag_guideline.zip): 13 × 11-inch safe area per face. The downloadable 17 × 33-inch guide is the **advanced two-face file**; our API placement uses **simple file 6, 17 × 16.5 inches**. Its safe rectangle was checked against the API's matching simple template, including the top seam and bottom fold, rather than scaling the entire advanced sheet into one face.
- [Blanket](https://printful.s3-accelerate.amazonaws.com/upload/guideline/Throw_blanket_templates.zip): 55 × 45-inch safe area in the horizontal 63 × 53-inch artwork.
- [Pillow](https://printful.s3-accelerate.amazonaws.com/upload/guideline/AOP_pillow_guideline.zip): 17 × 17-inch safe area in the 19 × 19-inch artwork.
- [Notebook](https://printful.s3-accelerate.amazonaws.com/upload/guideline/Spiral_Notebook.zip): nominal 4.75 × 7.6-inch safe area. The front/back PNG guide lines have different horizontal offsets. Rectangles sit inside those lines and share one size; copying front to back translates the design 73 pixels left, without mirroring its text.

## Preview placement

`/v2/catalog-products/{product_id}/mockup-templates` provides the full-artwork
rectangle for supported overlay images. Divide its coordinates by its declared
template size, which can be 3000 pixels even when the delivered image is 1000.
The six local overlays for coaster, matte posters, blanket and notebook front/back
were byte-identical to the current API images. Their mappings and image hashes
are covered by the snapshot test. Notebook front/back each have their own mapping.
Do not fit the full artwork to the visible finished-product edge: that incorrectly
compresses bleed and binding allowances into the visible face.

The current API does not expose photograph-specific placement data for our framed
poster, pillow and tote photos; its returned `template` images are flat cutting
and safe-area diagrams, not those product photos. Those photographic previews
remain illustrative fitted compositions. Their print-file dimensions and safe
areas are verified independently above. The procedural mug preview derives print
width/height in centimetres from file pixels and DPI and maps them onto the mug's
physical dimensions.

## Enforcement and existing designs

Automatic layouts, editor constraints, visible guides, side switching, copying,
and server save validation use the same per-surface safe rectangles. No dimensions
or safe areas from a submitted browser payload are trusted.

`designSafeMargin` remains the historical validation floor for already approved
SVG snapshots. New saves use `designSafeAreas`. Reopening an older design can fit
its draft proportionally into the current safe rectangle, with a review message
and unsaved state. This does not change its existing approved file or paid artifact.
