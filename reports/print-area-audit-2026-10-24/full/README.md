# Complete print-area comparison — 2026-10-24

All **67 variants across 21 catalog products** have a completed Printful proof
and a reviewed local calibration render. Coverage includes **78 orientation
states and 84 print surfaces**: every supported size/color, both orientations
of rotatable products, and independent pillow/notebook front and back artwork.
The archive contains **106 original provider images**. Nine earlier proofs are
reused with their identical saved input designs; the remaining states have
new provider-generated proofs. Nothing was ordered, deployed or pushed.

Open [the offline comparison](index.html) to filter products and inspect full
images. [coverage.json](coverage.json) records product/variant identities,
full print-file dimensions/DPI, placements, design-safe rectangles, selected
styles, input/proof hashes, local views and each review result.
[local-renders.json](local-renders.json) also pins renderer source hashes and
product/design hashes. The [20 review sheets](review-pages/all-index.json)
show every state; source images stay unmodified.

## Findings and corrections

- **Samsung verification finished:** all four Samsung model/finish variants
  generated successfully and were compared. All twelve iPhone/MagSafe/Samsung
  cases keep the pattern below their device-specific camera contour. The S25
  Ultra retry uses the current explicit variant style 25021, rather than the
  legacy generic style 8112 or the stalled older retry 25018. The shared mockup
  selector now prefers styles explicitly assigned to the selected device.
- **Landscape mockup selection:** Printful rejected a portrait frame style
  paired with horizontal orientation and a horizontal A2 style paired with
  vertical orientation. Both the audit and application selectors now match
  the exact oriented print dimensions before choosing a style. All eleven
  landscape states subsequently completed.
- **Black-handle all-over tote:** the older fitted photo rectangle made the
  pattern approximately 12% too small. Matching the same photo coordinates
  gives a full-file scale of 0.28128 photo pixels per input pixel, instead of
  0.24706. The blue calibration frame now agrees with Printful within 1.5 px
  on the original 700 × 1000 composition (the provider centers that photo in
  its 1000 × 1000 output). The bag silhouette clip is preserved in photo
  coordinates. Before-image/product metadata are in [before/](before/).
- **Laptop sleeves, 13″ and 15″:** nominal finished-size bleed crops enlarged
  the artwork. Their visible UV faces now use the provider's actual flat
  template projections. The 13″ primary template is 3000² with file rectangle
  `(354, 618, 2298, 1762)` and visible body bounds `(408, 666, 2193, 1680)`.
  The 15″ rectangle is `(171, 480, 2642, 2046)` with visible bounds
  `(180, 498, 2625, 2013)`. These bounds exclude the protruding zipper pull.
  Independent corner measurements now match to 0.3% of the visible face;
  raycasting also verifies the geometry's actual UV attributes. These are
  calibrated preview crops, not manufacturing CAD measurements.
- **Mousepad, variant 13097, follow-up:** the right/left placement already
  matched. A closer corner measurement found a small vertical source-mesh crop
  difference, about 7 px in the 1000 px flat proof. The preview-only
  `frontProjection` now aligns all four calibration borders within 2 proof
  pixels in the atlas/raycast check (within 3 in the 600 px WebGL capture).
  The original atlas cell, full print file and safe rectangle are
  unchanged. The local capture and comparison were refreshed; measured margins
  are in [the follow-up evidence](../../product-ux-2026-10-24/mouse-pad-verification.json).
- Other custom profiles, mapped photos and native meshes retain their print
  mapping. Every product state was checked for pattern order, position,
  proportion and cropping, with blue front/purple back identities where
  applicable. Perspective, folds and shadows were evaluated relative to the
  product face rather than treated as pixel-identical images.

Only preview projection, blank-color composition and mockup-style selection changed. Print-file sizes,
DPI, design-safe areas, variant IDs, fulfillment placements and saved/paid
artifacts did not change. Printful received the exact full-resolution PNGs
rendered by `src/printRaster.js`, through temporary private source URLs. No
preview UV crop, camera transform, lighting or physical display offset is
applied to those uploads. All **41** owned temporary source objects were
removed after every task completed; signed URLs remain outside the repository.

## Verification and limits

All 78 local captures completed in the real browser WebGL renderer, with no
loading or capture errors. The offline comparison uses technical front/side
views without the UI's camera tilt or automatic rotation. Flat compositions
retain their full-file crop/clip/photo mapping before uniform UI framing scale.

Focused tests cover the provider catalog snapshot for every variant and
orientation, full-resolution raster output on every surface, native mesh UVs,
front/back assignment, viewer lifecycle, gallery handoff, sleeve/tote landmark
regressions and exact variant/orientation mockup-style selection. The complete
test suite was not repeated for these localized preview/operator changes.

This is a **digital print-area comparison**, not a physical sample approval.
The remaining custom shapes approximate folds, seams, bevels and depth.
Provider mockups also approximate manufacturing. Physical placement variation,
trim and print color still require sample approval.

The organic-cotton tote blank-color issue is now **corrected and rechecked**.
Printful's semi-transparent fabric layers need their natural `#edcea5` / black
`#101010` color behind the entire composition. Previously only the artwork
rectangle was colored. The shared gallery/editor composition now colors the
body and handles, while the provider layer masks the outside and handle opening
white. Body, handle and hem samples match the original mockups within 3 RGB
levels. Both complete 1110 × 1110 artwork rectangles remain pixel-identical to
the preceding audit. See [verification data](organic-tote-color-verification.json),
[natural gallery preview](organic-tote-natural-gallery.png), and
[black gallery preview](organic-tote-black-gallery.png).
The [side-by-side color comparison](organic-tote-colors-comparison.png) shows
Wolkenworte on the left and the original Printful proof on the right.
Two new calibration captures and 38 focused tests pass. No new provider tasks,
artwork uploads, file geometry changes or physical sample orders were needed.

To reproduce locally, `node scripts/check-print-area-browser.js` starts an
isolated loopback fixture without .env, database or configuration writes.
Its button renders the coverage plan through the production viewer. The
operator script `scripts/verify-product-print-areas.js` prepares synthetic
input files, generates/polls Printful proofs, and removes only its own sources.
It uses the locally configured provider/private-storage credentials for
generation; credentials and signed URLs never enter this report.

## Per-state coverage

| Product / size / color | Orientation | Variant | File (px) | Surfaces | Result | Evidence |
| --- | --- | ---: | --- | --- | --- | --- |
| Weiße Tasse · 325 ml | default | 1320 | 2700 × 1050 | default | matched | [comparison](review-pages/all-1.png) |
| Weiße Tasse · 444 ml | default | 4830 | 2700 × 1140 | default | matched | [comparison](review-pages/all-1.png) |
| Weiße Tasse · 591 ml | default | 16586 | 3071 × 1205 | default | matched | [comparison](review-pages/all-1.png) |
| Kork-Untersetzer · 95 × 95 mm | default | 15662 | 1181 × 1181 | default | matched | [comparison](review-pages/all-1.png) |
| Mattes Poster · 30 × 40 cm | portrait | 8948 | 3544 × 4724 | default | matched | [comparison](review-pages/all-2.png) |
| Mattes Poster · 40 × 30 cm | landscape | 8948 | 4724 × 3544 | default | matched | [comparison](review-pages/all-2.png) |
| Mattes Poster · 50 × 70 cm | portrait | 8952 | 5906 × 8268 | default | matched | [comparison](review-pages/all-2.png) |
| Mattes Poster · 70 × 50 cm | landscape | 8952 | 8268 × 5906 | default | matched | [comparison](review-pages/all-2.png) |
| Gerahmtes Poster · 30 × 40 cm · Schwarz | portrait | 9357 | 3600 × 4800 | default | matched | [comparison](review-pages/all-3.png) |
| Gerahmtes Poster · 30 × 40 cm · Schwarz | landscape | 9357 | 4800 × 3600 | default | matched | [comparison](review-pages/all-3.png) |
| Gerahmtes Poster · 50 × 70 cm · Schwarz | portrait | 9358 | 5906 × 8268 | default | matched | [comparison](review-pages/all-3.png) |
| Gerahmtes Poster · 50 × 70 cm · Schwarz | landscape | 9358 | 8268 × 5906 | default | matched | [comparison](review-pages/all-3.png) |
| Tragetasche · 39 × 39 cm · Schwarz | default | 4533 | 2550 × 2475 | default | corrected-and-rechecked | [comparison](review-pages/all-4.png) |
| Kuscheldecke · 127 × 153 cm | default | 10986 | 9450 × 7950 | default | matched | [comparison](review-pages/all-4.png) |
| Dekokissen · 46 × 46 cm | default | 4532 | 2850 × 2850 | front, back | matched | [comparison](review-pages/all-4.png) |
| Spiral-Notizbuch · 14,5 × 21 cm | default | 12141 | 1725 × 2625 | front, back | matched | [comparison](review-pages/all-4.png) |
| Mattes Poster · 21 × 30 cm | portrait | 8947 | 2480 × 3544 | default | matched | [comparison](review-pages/all-5.png) |
| Mattes Poster · 21 × 30 cm | landscape | 8947 | 3544 × 2480 | default | matched | [comparison](review-pages/all-5.png) |
| Mattes Poster · A2 · 42 × 59,4 cm | portrait | 19516 | 4961 × 7016 | default | matched | [comparison](review-pages/all-5.png) |
| Mattes Poster · A2 · 42 × 59,4 cm | landscape | 19516 | 7016 × 4961 | default | matched | [comparison](review-pages/all-5.png) |
| Poster im Eichenrahmen · 30 × 40 cm · Eiche | portrait | 11791 | 3600 × 4800 | default | matched | [comparison](review-pages/all-6.png) |
| Poster im Eichenrahmen · 30 × 40 cm · Eiche | landscape | 11791 | 4800 × 3600 | default | matched | [comparison](review-pages/all-6.png) |
| Poster im weißen Rahmen · 30 × 40 cm · Weiß | portrait | 10297 | 3600 × 4800 | default | matched | [comparison](review-pages/all-6.png) |
| Poster im weißen Rahmen · 30 × 40 cm · Weiß | landscape | 10297 | 4800 × 3600 | default | matched | [comparison](review-pages/all-6.png) |
| Poster im Eichenrahmen · 50 × 70 cm · Eiche | portrait | 11792 | 5906 × 8268 | default | matched | [comparison](review-pages/all-7.png) |
| Poster im Eichenrahmen · 50 × 70 cm · Eiche | landscape | 11792 | 8268 × 5906 | default | matched | [comparison](review-pages/all-7.png) |
| Poster im weißen Rahmen · 50 × 70 cm · Weiß | portrait | 10298 | 5906 × 8268 | default | matched | [comparison](review-pages/all-7.png) |
| Poster im weißen Rahmen · 50 × 70 cm · Weiß | landscape | 10298 | 8268 × 5906 | default | matched | [comparison](review-pages/all-7.png) |
| Tragetasche · 39 × 39 cm · Rot | default | 8904 | 2550 × 2475 | default | matched | [comparison](review-pages/all-8.png) |
| Tragetasche · 39 × 39 cm · Gelb | default | 8905 | 2550 × 2475 | default | matched | [comparison](review-pages/all-8.png) |
| Dekokissen · 36 × 36 cm | default | 49853 | 2250 × 2250 | front, back | matched | [comparison](review-pages/all-8.png) |
| Dekokissen · 41 × 41 cm | default | 49854 | 2550 × 2550 | front, back | matched | [comparison](review-pages/all-8.png) |
| Dekokissen · 51 × 30 cm | default | 9513 | 3150 × 1950 | front, back | matched | [comparison](review-pages/all-9.png) |
| Dekokissen · 56 × 56 cm | default | 11075 | 3450 × 3450 | front, back | matched | [comparison](review-pages/all-9.png) |
| Kuscheldecke · 76 × 102 cm | default | 22609 | 6450 × 4950 | default | matched | [comparison](review-pages/all-9.png) |
| Tasse mit farbiger Innenseite · 325 ml · Schwarz | default | 11051 | 2700 × 1050 | default | matched | [comparison](review-pages/all-9.png) |
| Tasse mit farbiger Innenseite · 444 ml · Schwarz | default | 17196 | 2700 × 1140 | default | matched | [comparison](review-pages/all-10.png) |
| Tasse mit farbiger Innenseite · 325 ml · Blau | default | 11050 | 2700 × 1050 | default | matched | [comparison](review-pages/all-10.png) |
| Tasse mit farbiger Innenseite · 444 ml · Blau | default | 17197 | 2700 × 1140 | default | matched | [comparison](review-pages/all-10.png) |
| Tasse mit farbiger Innenseite · 444 ml · Dunkelblau | default | 22373 | 2700 × 1140 | default | matched | [comparison](review-pages/all-10.png) |
| Tasse mit farbiger Innenseite · 325 ml · Orange | default | 12579 | 2700 × 1050 | default | matched | [comparison](review-pages/all-11.png) |
| Tasse mit farbiger Innenseite · 325 ml · Rosa | default | 12578 | 2700 × 1050 | default | matched | [comparison](review-pages/all-11.png) |
| Tasse mit farbiger Innenseite · 325 ml · Rot | default | 11049 | 2700 × 1050 | default | matched | [comparison](review-pages/all-11.png) |
| Tasse mit farbiger Innenseite · 444 ml · Rot | default | 17200 | 2700 × 1140 | default | matched | [comparison](review-pages/all-11.png) |
| Tasse mit farbiger Innenseite · 325 ml · Gelb | default | 11048 | 2700 × 1050 | default | matched | [comparison](review-pages/all-12.png) |
| Tasse mit farbiger Innenseite · 444 ml · Rosa | default | 17199 | 2700 × 1140 | default | matched | [comparison](review-pages/all-12.png) |
| Tasse mit farbiger Innenseite · 325 ml · Dunkelblau | default | 17362 | 2700 × 1050 | default | matched | [comparison](review-pages/all-12.png) |
| Tasse mit farbiger Innenseite · 325 ml · Dunkelgrün | default | 17359 | 2700 × 1050 | default | matched | [comparison](review-pages/all-12.png) |
| Tasse mit farbiger Innenseite · 444 ml · Dunkelgrün | default | 17360 | 2700 × 1140 | default | matched | [comparison](review-pages/all-13.png) |
| Tasse mit farbiger Innenseite · 325 ml · Goldgelb | default | 17358 | 2700 × 1050 | default | matched | [comparison](review-pages/all-13.png) |
| Tasse mit farbiger Innenseite · 325 ml · Grün | default | 17361 | 2700 × 1050 | default | matched | [comparison](review-pages/all-13.png) |
| Mauspad · 22 × 18 cm | default | 13097 | 2700 × 2250 | default | corrected-and-rechecked | [comparison](review-pages/all-13.png) |
| Laptophülle · 13″ · 34,3 × 26,7 cm | default | 10984 | 2250 × 1725 | default | corrected-and-rechecked | [comparison](review-pages/all-14.png) |
| Laptophülle · 15″ · 37,3 × 28,5 cm | default | 10985 | 2325 × 1800 | default | corrected-and-rechecked | [comparison](review-pages/all-14.png) |
| Leinwand · 30,5 × 40,6 cm | portrait | 5 | 5400 × 6600 | default | matched | [comparison](review-pages/all-14.png) |
| Leinwand · 30,5 × 40,6 cm | landscape | 5 | 6600 × 5400 | default | matched | [comparison](review-pages/all-14.png) |
| Edelstahl-Trinkflasche · 500 ml · Weiß | default | 10798 | 2557 × 1582 | default | matched | [comparison](review-pages/all-15.png) |
| Edelstahl-Trinkflasche · 500 ml · Schwarz | default | 16030 | 2557 × 1582 | default | matched | [comparison](review-pages/all-15.png) |
| Edelstahlbecher mit Strohhalm · 600 ml · Weiß | default | 15005 | 2776 × 2374 | default | matched | [comparison](review-pages/all-15.png) |
| Edelstahlbecher mit Strohhalm · 600 ml · Schwarz | default | 15004 | 2776 × 2374 | default | matched | [comparison](review-pages/all-15.png) |
| Emaille-Tasse · 355 ml | default | 11189 | 2400 × 720 | default | matched | [comparison](review-pages/all-16.png) |
| Reisebecher mit Henkel · 739 ml | default | 16440 | 2700 × 1140 | default | matched | [comparison](review-pages/all-16.png) |
| Reisebecher mit Henkel · 1183 ml | default | 19514 | 3213 × 1571 | default | matched | [comparison](review-pages/all-16.png) |
| Weinbecher · 355 ml | default | 16046 | 3175 × 950 | default | matched | [comparison](review-pages/all-16.png) |
| Bio-Baumwolltasche · Natur | default | 10458 | 1500 × 1500 | front | matched | [comparison](review-pages/all-17.png) |
| Bio-Baumwolltasche · Schwarz | default | 10457 | 1500 × 1500 | front | matched | [comparison](review-pages/all-17.png) |
| iPhone-Schutzhülle · iPhone 16 Pro · Matt | default | 20308 | 1392 × 2220 | default | matched | [comparison](review-pages/all-17.png) |
| iPhone-Schutzhülle · iPhone 16 Pro · Glänzend | default | 20304 | 1392 × 2220 | default | matched | [comparison](review-pages/all-17.png) |
| iPhone-Schutzhülle · iPhone 17 Pro · Matt | default | 33991 | 1392 × 2220 | default | matched | [comparison](review-pages/all-18.png) |
| iPhone-Schutzhülle · iPhone 17 Pro · Glänzend | default | 33987 | 1392 × 2220 | default | matched | [comparison](review-pages/all-18.png) |
| MagSafe-Schutzhülle · iPhone 16 Pro · Matt | default | 20328 | 1392 × 2220 | default | matched | [comparison](review-pages/all-18.png) |
| MagSafe-Schutzhülle · iPhone 16 Pro · Glänzend | default | 20329 | 1392 × 2220 | default | matched | [comparison](review-pages/all-18.png) |
| MagSafe-Schutzhülle · iPhone 17 Pro · Matt | default | 34006 | 1392 × 2220 | default | matched | [comparison](review-pages/all-19.png) |
| MagSafe-Schutzhülle · iPhone 17 Pro · Glänzend | default | 34005 | 1392 × 2220 | default | matched | [comparison](review-pages/all-19.png) |
| Samsung-Schutzhülle · Samsung Galaxy S25 Ultra · Matt | default | 21474 | 1396 × 2304 | default | matched | [comparison](review-pages/all-19.png) |
| Samsung-Schutzhülle · Samsung Galaxy S25 Ultra · Glänzend | default | 21473 | 1396 × 2304 | default | matched | [comparison](review-pages/all-19.png) |
| Samsung-Schutzhülle · Samsung Galaxy S26 Ultra · Matt | default | 49331 | 1396 × 2304 | default | matched | [comparison](review-pages/all-20.png) |
| Samsung-Schutzhülle · Samsung Galaxy S26 Ultra · Glänzend | default | 49329 | 1396 × 2304 | default | matched | [comparison](review-pages/all-20.png) |
