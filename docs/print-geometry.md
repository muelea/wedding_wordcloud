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

## Product reference photos — 2026-10-26

`src/productPhotoCatalog.json` records the public Printful gallery audit for all
26 offered product groups. Only visually reviewed blank products, garment models
and useful material/detail shots are included. Sample artwork is excluded; some
products therefore retain a single reference photo. The coaster includes the
blank front/cork-back pair and the blank product held in a hand.

Each added image pins its provider image ID, source URL/hash, local JPEG hash,
source size/color mappings and exact eligible catalog variant IDs. Garment model
layers are composited over the provider's matching white/black colour. Additional
manual colour restrictions prevent a white drinkware detail from appearing on
the black variant. Runtime browsing reads local assets only.

The 2026-10-27 duplicate review covers 243 co-occurring photo pairs across the
343 retained variants (465 local images). Sixty-nine pairs were the same supplier
photograph under different filenames/JPEG encodings. Visually reviewed `duplicates` entries
pin the original copy's hash; the gallery uses one matching reviewed copy in its
place. Replacement stays restricted to the exact variant. The photo tests also
compare the remaining galleries' normalized image pixels to catch repeated shots.

Conservative display frames remove excess white surroundings from existing
reference photos; added supplier compositions remain complete. The design tab
fits all visible artwork using its alpha bounds, including white ink, with a
bounded 1024-pixel scan. "Gesamte Druckfläche" shows the complete print area for
placement context. Both modes retain the original file and proportions; 3D
retains physical print coordinates and full rotation framing. These display
changes never alter accepted print files,
saved artwork, fulfillment identities or prices.

## Clothing — 2026-10-25

`src/apparelCatalog.json` pins the 38 black/white DTG variants for Stanley/Stella
STTU169 (XS–5XL), STSU178 and STSU177 (S–2XL). Each record preserves the exact
variant ID, front print file, provider front mockup template and supplier
measurements of the garment laid flat. Current German availability, standard
EU shipping departure countries and synthetic Berlin cost estimates were
checked through the existing read-only catalog/estimate APIs. The reference
photos are served locally; browsing does not call Printful.

The T-shirt and hoodie reference photos use the provider's plain ghost/front
templates. Each local JPEG composites the template over its `background_color`
(white or black); the template's opaque white surround keeps the photo background
white while its transparency retains fabric shading. `photoSources` records the
template URL, source hash, background colour and final JPEG hash. The sweatshirt
keeps its existing plain front photos. All three garment titles identify them as
unisex.

| Product | Front print file | Physical print area | Fabric |
| --- | --- | --- | --- |
| STTU169 T-shirt | 1800 × 2400 at 150 dpi | 30.48 × 40.64 cm | 180 g/m² organic cotton jersey |
| STSU178 sweatshirt | 1800 × 2400 at 150 dpi | 30.48 × 40.64 cm | 350 g/m² organic cotton |
| STSU177 hoodie | 2100 × 2100 at 150 dpi | 35.56 × 35.56 cm | 350 g/m² organic cotton |

These products offer the included front print only. The unprinted reverse,
sleeves, hood and pocket never repeat the artwork. The usual 60-pixel inset
keeps editable elements inside the rectangular print area; it is an application
margin, not a claim of an additional manufacturer restriction.

### Photographic clothing previews — 2026-10-27

Clothing uses the shared `public/js/product-photo-preview.js` canvas renderer
in the gallery, editor, cart thumbnails and product overview. The three original
PNG front layers are local, hash-pinned `previewLayer` assets. The sweatshirt
uses its mapped square ghost template for this composition; its separate
700 × 1000 catalog JPEG remains an unprinted reference photo.

The renderer fills the provider garment colour, paints the complete transparent
print file in the mapped rectangle, then applies the original alpha/shadow layer.
It never crops to the visible words, stretches to the garment silhouette, uses
3D lighting or multiplies the design against black fabric. These mappings were
rechecked with read-only Printful catalog APIs for all 38 offered variants:

| Product | Template width × height | Full print rectangle: left, top, width, height |
| --- | --- | --- |
| STTU169 | 3000 × 3000 | 930, 409, 1140, 1520 |
| STSU178 | 3000 × 3000 | 930, 415, 1140, 1520 |
| STSU177 | 3000 × 3000 | 1026, 687, 966, 966 |

The downloaded PNGs are 1000 × 1000; divide coordinates by the declared 3000 px
template dimensions. Every variant retains its original front print file,
safe inset and fulfillment identity. Frozen cart artwork uses its accepted SVG
for local compositions; shipping approval continues to use the prepared PNG
that is also retained for production. Supplier layers never enter either file.

Printful maps each colour's same photograph and rectangle to all offered sizes.
This is a provider-standard placement preview, not a measurement of the print's
proportion on every garment size or a prediction of fit. The retained supplier
measurements and legacy procedural garment geometry are independent of these
customer-facing photo previews. Browsing performs no provider requests.

The synthetic calibration in `reports/apparel-photo-2026-10-27/` includes
Printful-generated Ghost/front proofs for every offered variant, using the
matching style IDs 21409, 21074 and 21242. The 38 results contain six distinct
images. Local calibration edges agree within one pixel at 1000 px; pinned
offline proof hashes and measured landmarks are covered by
`test/apparel-photo-preview.test.js`. These checks establish agreement with
provider mockups, not physical manufacturing tolerances. The three temporary
private diagnostic sources were deleted after generation; no orders or
customer configurations were created.

## EU fulfillment selection — 2026-10-25

The current storefront offers **343 variants across 26 product groups**, with
**446 orientation states and 452 print surfaces**, including clothing, phone cases and the metric poster
and canvas expansions below. The initial read-only Printful checks for
all 67 previously offered variants identified six that do not have EU
fulfillment for German delivery. They have been removed from the shared
catalog, product picker, configuration lookup and price snapshot:

| Removed variant | Printful variant ID | Reason |
| --- | --- | --- |
| Black framed poster, 50 × 70 cm | 9358 | Ships only to Australia and New Zealand |
| Colored-interior mug, dark blue, 325 ml | 17362 | US fulfillment only |
| Colored-interior mug, dark green, 325 ml | 17359 | US fulfillment only |
| Colored-interior mug, dark green, 444 ml | 17360 | US fulfillment only |
| Colored-interior mug, golden yellow, 325 ml | 17358 | US fulfillment only |
| Colored-interior mug, green, 325 ml | 17361 | US fulfillment only |

All 61 initially retained variants were in stock in Printful's Germany selling region
and returned standard shipping estimates departing from EU countries for a
synthetic Berlin address. The white/oak 50 × 70 cm frames retain their exact
variant IDs, print files and geometry. Eleven colored-interior mug variants
remain. All offered prices now use Germany as their reference destination;
the Australian pricing exception has been removed.

The compact provider evidence is pinned in
`test/fixtures/catalog-eu-fulfillment.json`. Its sources are
`GET /v2/catalog-variants/{id}/availability?selling_region_name=germany` and
`POST /v2/shipping-rates`, with quantity one and the configured placements,
techniques and product options. The six exceptions were additionally checked
against `POST /orders/estimate-costs`: the frame was rejected, while the five
mugs could ship from the US with possible customs fees. A selling-region
status alone is not a destination shipping restriction.

This selection establishes EU fulfillment availability for German delivery;
it does not fix Printful's routing for every future order or destination.
Checkout continues to obtain current shipping and customs estimates. The
dated audits below retain their original coverage of the former 67-variant
range, including the removed variants' historical print geometry and proofs.

The 2026-10-27 live audit rechecked all 344 then-offered variants and found one
additional exception: the oak-framed 61 × 91 cm poster (11793) is now marked
not fulfillable for Germany, has only Australian stock and ships only to
Australia and New Zealand. It has been removed from the shared catalog,
price snapshot and active print-geometry/photo mappings. The availability
fixture now records that exclusion and the fresh evidence for the 343 retained
variants; older excluded variants retain their original check dates.
The complete read-only audit is in
[`reports/catalog-germany-eu-2026-10-27/`](../reports/catalog-germany-eu-2026-10-27/).

## Complete metric poster range — 2026-10-25

The offered range now includes all seven Germany-available variants of product
268 (Enhanced Matte Paper Poster, cm) and 21 Germany-available variants of
product 304 (Enhanced Matte Paper Framed Poster, cm, without a mat). The 19 retained
additions use the existing product families and centimetres throughout:

| Range | Added sizes / frame colors |
| --- | --- |
| Matte poster | A1 (59.4 × 84.1 cm), 61 × 91 cm, 70 × 100 cm |
| Black frame | 21 × 30, 30 × 45, 40 × 50, 45 × 61, A2 (42 × 59.4), A1 (59.4 × 84.1), 61 × 91 cm |
| Oak frame | 21 × 30, A2 (42 × 59.4), A1 (59.4 × 84.1) |
| White frame | 21 × 30, 30 × 45, 40 × 50, A2 (42 × 59.4), A1 (59.4 × 84.1), 61 × 91 cm |

Read-only catalog, Germany availability, print-file and template responses were
checked before adding these variants. Every addition returned a standard
shipping estimate from Latvia or Spain to a synthetic Berlin address with no
possible customs fees. Product 304's black 50 × 70 cm (9358) and white
45 × 61 cm (19651) are not fulfillable in Germany and remain excluded. The
2026-10-27 recheck also excludes oak 61 × 91 cm (11793), as described above. Oak
30 × 45, 40 × 50 and 45 × 61 cm combinations do not exist in this family.

Availability is intersected with the active catalog. Product 268's availability
feed still lists variant 21487 as in stock, but both variant APIs return 404
for it and the active product exposes only seven variants. It is not an
orderable size and is excluded; the public product-page size selector also
lists the same seven active sizes.

Each addition pins its exact provider variant, print-file dimensions, placement,
technique, source photo URL and SHA-256 in the manifest. The existing 154-pixel
inset from the official poster trim guides is retained. Portrait and landscape
use the same provider pixels with `can_rotate`; all additions use the existing
opaque paper/frame 3D renderer. The print-geometry fixture includes the exact
provider mappings, rather than inferring pixels from nominal centimetres.

Non-binding single-item German cost estimates populate only the 20 new price
entries; the previous 61 product costs are unchanged. `metricPostersCheckedAt`
records this additional check in the cost and fulfillment snapshots. Frame
size/color labels are localized in all five translation catalogs, including
black frames. Inch-catalog products and frames with mats are outside this
expansion.

## Complete canvas range — 2026-10-25

All active variants from Printful products 3 (46 standard canvases), 616
(13 thin canvases) and 614 (13 sizes in black, brown and white frames, 39
variants) are offered in three gallery groups. The existing 30.5 × 40.6 cm
canvas and its original provider mesh remain unchanged; the 97 additions have
their own provider IDs, unmodified reference photos, exact print files,
templates, safe areas and single-item German cost estimates. The previous
81 catalog products and costs are unchanged. Sizes are displayed in cm,
converted from the active inch variants and rounded to one decimal; physical
models retain the exact conversions. Square files expose no spurious rotation
option. Rectangles support portrait and landscape.

The active v1/v2 variant lists were intersected with Germany availability.
All 98 variants were in stock and returned individual non-binding standard
shipping quotes from Spain to a synthetic Berlin address without possible
customs fees. Fourteen orphan records in the thin-canvas availability feed
are not present in the active catalog and are excluded. The fulfillment and
cost snapshots record their respective `canvasesCheckedAt` timestamps.

Printful's exact files have different wrap allowances: the six original
standard sizes reserve 900 pixels per edge, the other 40 standard sizes and
all framed canvases reserve 450, and thin canvases reserve 300, all at 300 dpi.
The per-variant front crop matches the green front rectangle of the official
Catalog API cutting template. Important artwork is held a further 100 pixels
inside this fold. No print file is resized or derived from its display label.

The new previews use stretched cloth with a subtle weave, artwork continuing
onto the sides, an unprinted recessed rear, wooden stretcher bars, staples and
hanging hardware. Standard canvases are 3.18 cm deep, thin canvases 1.905 cm.
Framed canvases have a recessed canvas, a visible floating gap and a separate
3.18 cm outer wooden frame; the frame and gap remain unprinted. Both
orientations transpose the exact front UV crop with the physical dimensions.

Oversized canvas files reach 12,900 × 18,900 pixels. Above 40 million pixels,
`src/printRaster.js` renders canvases in 128-row strips with reused native
images and incremental lossless PNG compression in `src/stripPng.js`. This
keeps the complete provider resolution, transparent pixels, outlined text,
emoji, uploaded images and layer order without allocating two full-sized
RGBA surfaces on the 1 GB host. The 40 MiB artifact cap still applies;
partial or failed renders never produce an artifact. Smaller exports retain
the existing rendering path. Strip output is checked against whole-image
pixels across strip boundaries and rotated uploads.

The local maximum-size smoke exported a 12,900 × 18,900 PNG with two corner
motifs at a measured peak RSS of 185 MiB (192 MiB V8 heap limit). This is a
bounded-memory render check, not a maximum-content benchmark; decoded customer
images add their own bounded source-image memory. Rotated upload edges can
differ from a whole-surface Cairo render by up to three antialiasing levels;
outlined-vector pixels and the complete print dimensions are preserved.

## Catalog expansion — 2026-10-24

`src/productCatalogManifest.json` pins the Catalog API variants, print files,
techniques, template URLs and camera contours for the additions. At introduction,
the original 12 product keys and their approved print geometry were unchanged.
The catalog initially contained 67 variants in 21 gallery groups, before the EU
selection above:

- Existing ranges: 21 × 30 cm and A2 posters; white/oak frames for the two
  existing framed sizes; red/yellow tote handles; 14-, 16-, 20 × 12- and 22-inch
  pillows; 30 × 40-inch blanket.
- Colored-interior mugs: all 16 provider color/size combinations, using the
  same print files as the existing 11/15 oz white mugs.
- Mousepad, both laptop sleeve sizes, 12 × 16-inch canvas, white/black 500 ml
  bottle and 600 ml steel tumbler, enamel mug, both travel mug sizes, wine
  tumbler, and natural/black organic cotton tote.
- Tough iPhone 16 Pro/17 Pro cases, their MagSafe versions, and Galaxy S25 Ultra/
  S26 Ultra cases, each in matte and glossy finishes. Other device shapes are
  deliberately outside this first verified range. Android coverage is Samsung.

The large 60 × 80-inch blanket remains excluded. Additional metric poster/frame
sizes were added by the 2026-10-25 expansion above. The cotton tote exposes only its included front placement;
its paid back placement is not silently added to an estimate. Existing pillow
and notebook front/back artwork remains independently editable and fulfilled.

### Safe areas and preview mapping

The new poster/frame variants retain the 154-pixel trim allowance. Pillows
reserve 150 pixels per edge, including both faces; the small blanket reserves
600. Laptop sleeves use a conservative 300-pixel inset inside the rounded safe
line of the [official sleeve guide](https://printful.s3-accelerate.amazonaws.com/upload/guideline/Laptop_sleeve_guideline.zip).
Mousepad and cotton-tote insets are 120 and 75 pixels. Handled drinkware adds a
35–45 pixel editing inset inside the provider's rectangular print file, in
addition to the physical unprinted rim, base or handle band.

The handle-free wine tumbler, both water bottles and both straw tumblers use
**3 pixels on each horizontal edge** from 2026-10-25. Their provider meshes
map the print band around the complete circumference; the old 50/70-pixel
horizontal editing allowance created an unnecessary blank strip at the join.
Vertical margins remain 50 pixels for wine tumblers and bottles, and 70 for
straw tumblers. Explicit `safeArea` rectangles drive the editor, automatic
layouts and new-save validation; the legacy `margin` rendering floor is 3 so
those accepted edge designs also export. Words stay whole inside the file;
there is no wraparound splitting or UV stretching. Previously approved
artwork retains its coordinates. The editor's existing two-pixel numerical
rounding guard remains inside these bounds. Research evidence is in
`reports/product-ux-2026-10-25/wine-tumbler-seam-research/`.

The mousepad's independent variant-13097 flat proof was remeasured after the
gallery/editor update. Horizontal placement already agreed; the original 3D
UV crop placed the top calibration border about 7 proof pixels too low. Its
preview-only `frontProjection` now corrects that vertical scale/offset inside
the original atlas cell. The atlas/raycast regression matches all four borders
within two pixels in the 1000-pixel provider proof; the lower-resolution WebGL
capture agrees within three after antialiasing. The 2700 × 2250 file and 120-pixel safe inset remain
unchanged. Evidence and measured margins are in
`reports/product-ux-2026-10-24/mouse-pad-verification.json`.

Canvas artwork includes a 900-pixel allowance per edge beyond the front face;
text stays a further 100 pixels inside that fold. The model maps front and side
UVs from the complete provider file, rather than fitting the entire file onto
the visible front. Poster/canvas portrait and landscape views transpose both
the print geometry and model geometry.

Each case's official template supplies the camera contour, normalized using
its declared template dimensions. The contour is an actual hole in the 3D
mesh. The editor intentionally uses a conservative rectangle below the entire
camera opening, inset from the safe line and rounded corners. This sacrifices
space beside the camera to prevent words being clipped. The same rectangle is
used by layout, editing and server save validation. Changing finishes does not
change that device's print geometry.

`src/productPreviewModels.json` pins 14 original Printful preview meshes by
source URL and SHA-256. Exact product ID and printfile ID matches select these
meshes for 26 variants: all three white mugs, ten 325 ml colored mugs, canvas,
both water bottles, enamel mug, both straw tumblers, wine tumbler, three pillow
sizes, mouse pad, cork-backed coaster and spiral notebook. The coaster,
notebook and 46 cm pillow now use 3D previews. The 36 cm and 41 cm pillows use an
explicit, hash-pinned adaptation of the same square mesh, uniformly scaled to
35.56 cm and 40.64 cm. Their complete 2250 px and 2550 px print files map into
the original independent front/back atlas cells, including each size's bleed.
They retain their own variant IDs, safe areas and fulfillment files. Other
unmatched products use procedural 3D previews, including phone cases.

`public/js/printful-product-model.js` loads the locally served GLBs and maps
front/back print canvases into their original UV atlases. Preparation removes
embedded sample artwork without changing geometry, normals, indices or UVs;
cleaned cork/paper/binding atlases retain the non-print surfaces. Canvas artwork
and geometry rotate together for landscape. `public/js/mug-3d-viewer.js` shares
rotation, framing, context recovery and disposal across the imported models and
`public/js/product-3d-geometry.js` procedural models. All 61 catalog variants
use 3D previews with neutral studio lighting and linear tone mapping. Ceramic, matte and
textile print surfaces use restrained reflections; metal parts keep their
metallic finish and environment reflections. Procedural print textures already
draw directly at up to 2048 pixels on their longest edge.

Imported models draw current front/back designs directly into their independent
atlas cells, including after edits and Undo. Atlases use up to 4096 pixels,
subject to the GPU limit; wide wrap files use a shorter vertical dimension to
reduce memory. Normalized UVs stay unchanged. Artwork is clipped to its own cell,
preserving handle colours, cork, paper and other unprinted areas. Landscape
canvas artwork rotates within the print cell with its physical model. Only
visible gallery cards retain a WebGL viewer. Immutable fulfillment PNGs keep the
full provider resolution. No preview model changes print-file dimensions or safe
areas. Reference photos are unmodified provider images stored locally.

These are product previews, not production CAD models. Print-file dimensions,
safe rectangles, camera openings and UV correspondence have automated coverage;
materials, lighting and the remaining procedural profiles are illustrative.
A physical sample comparison is still necessary before claiming production
color or shape fidelity. No sample orders were placed during implementation.

### Print-area audit — 2026-10-24

All **67 variants / 21 catalog products**, including their **78 supported
orientation states**, were checked again against current read-only Printful
Catalog, printfile and selected mockup-template responses. Product/variant
identities, placement names, printfile IDs, width/height, DPI and permitted
transposition match the pinned records. Every configured safe rectangle stays
inside its complete upload file. This last check verifies coordinate bounds;
it does not turn an editing inset into a provider-certified manufacturing
tolerance.

The initial review found and corrected two preview problems. The complete
comparison below also corrects the tote and both sleeve sizes:

- Both water bottles applied the legacy `printCenterY: -3.5` displacement
  inside an already positioned provider UV cell. This moved artwork down by
  413.4 pixels in a 1582-pixel file and clipped the bottom. Imported meshes now
  always receive the complete file at `(0, 0)`, for front/back and both canvas
  orientations, including repaints after edits. Procedural full-body textures
  retain their separate physical positioning.
- Both custom travel mugs placed the print band too low. Provider-generated
  calibration mockups and the official
  [travel-mug guide](https://printful.s3-accelerate.amazonaws.com/upload/guideline/Travel%20Mug%20with%20a%20Handle.zip)
  show the band on the upper cylindrical section, just below the rim. Preview
  centres are now +4.5 cm / +6 cm for 739 ml / 1183 ml, and their taper begins
  below the text area. These are calibrated preview profiles, not production
  CAD measurements.

No uploaded artwork dimensions, safe areas, variant IDs, fulfillment placements
or already approved/paid files were changed. The bottle offset existed only
in the browser viewer. Fulfillment still renders the frozen surface design
into the exact full-size transparent PNG, and submits its immutable capability
URL under the catalog placement. No model lighting, UV atlas, crop or physical
preview offset is applied to that PNG.

The 14 original mesh mappings were compared with Printful's actual
`_resamplePngFile`, `_mergePlacementImages` and `_drawImageReturnBase64` code,
including the 591 ml mug's special placement, canvas rotation, and independent
pillow/notebook backs. Source:
[`62351.c6912764bc6932dba2b3.js`](https://static.cdn.printful.com/dist-pf/62351.c6912764bc6932dba2b3.js),
SHA-256 `3e4ad02d07406b63de92c3e6dd3e1e3d3861e34522f86ae62e30a8fb4f5016e9`.

| Range | Variants | Current preview / verification boundary |
| --- | ---: | --- |
| White mugs | 3 | Original provider UVs |
| Colored-interior mugs | 11 offered | Original 325 ml meshes; 444 ml uses the white 444 ml provider mesh with a reviewed coating mask (2026-10-25) |
| Cork-backed coaster | 1 | Original provider UVs |
| Matte posters | 7 | Custom thin 3D paper panels with light unprinted backs |
| Framed posters | 21 offered | Custom 3D panels for black, oak and white frames; no imported Printful mesh |
| All-over totes | 3 | Custom volumetric sewn bags with independently readable front/back UVs |
| Blankets | 2 | 1 mapped overlay; 1 custom panel with bleed crop |
| Pillows | 5 | 3 exact provider mappings; 2 scaled adaptations of the square mesh |
| Spiral notebook | 1 | Original provider UVs, separate front/back |
| Mouse pad | 1 | Original provider UVs |
| Laptop sleeves | 2 | Padded custom neoprene skins, black rear/binding and two zipper pulls; existing calibrated front UVs |
| Canvas | 46 | Original provider UVs for 30.5 × 40.6 cm; exact per-file front/side mapping on the other sizes |
| Thin canvas | 13 | 1.905 cm stretched canvas with exact per-file front/side UVs |
| Framed canvas | 39 | Floating black, brown and white frames, recessed cloth and exact front/side UVs |
| Water bottles | 2 | Original provider UVs; extra shift removed |
| Straw tumblers | 2 | Original provider UVs |
| Enamel mug | 1 | Original provider UVs |
| Travel mugs | 2 | Custom profiles calibrated against provider mockups |
| Wine tumbler | 1 | Original provider UVs |
| Organic cotton totes | 2 | Custom gusseted cotton bags; full front file on a 25.4 cm square, unprinted rear |
| iPhone / MagSafe / Samsung tough cases | 140 | Per-device hollow shells/liners, wrapped exterior UVs, provider-template camera openings and separate display handsets |

Framed posters have their own preview moulding, calibrated against the local
Printful photographs for all nine metric sizes. The former universal 0.9 cm
rail understated the visible frame, particularly on A1 and A2. The calibrated
profiles use a broad face, shallow inner lip, outer bevel and diagonal mitred
joins; oak grain follows each rail. These are photo-derived preview dimensions,
not supplier CAD measurements. The complete existing artwork panel and its UVs
remain unchanged, with the moulding extending outwards. This does not alter
print files, safe areas, fulfillment or the separate floating-canvas renderer.
Independent photo bounds are pinned in
`test/fixtures/framed-poster-landmarks.json`; geometry tests check every offered
size/colour in both orientations, front/back ownership and texture disposal.

The audit evidence in
[`reports/print-area-audit-2026-10-24/`](../reports/print-area-audit-2026-10-24/)
contains machine-readable catalog checks, synthetic calibration designs, exact
server-rendered input PNGs and original Printful-generated proof images with
hashes. These are test patterns, with no customer data. Calibration jobs create
no orders; temporary private-storage source objects are deleted afterward.

The 2026-10-25 `colored-interior-444` preview adaptation replaces the custom
444 ml mug profile with the existing white 444 ml provider mesh. Its connected
inside/rim, inner-base and handle islands receive the selected vertex color;
the exterior and all printable vertices remain white. The pinned geometry,
indices, normals, UVs and complete 2700 × 1140 print atlas are unchanged.
Fulfillment continues to use product 403 and the exact selected variant and
printfile 44. The white product 19 remains unchanged. Each offered color has
raycast checks for the seven colored/white regions, byte comparisons of the
original mesh buffers, and an identical fulfillment PNG with/without preview
metadata. See the [model provenance](../public/assets/product-models/README.md)
and [render comparisons](../reports/product-ux-2026-10-25/colored-mug-444/).
The original `audit.json` records the first representative review. It is
superseded for coverage/status by the
[complete per-state report](../reports/print-area-audit-2026-10-24/full/README.md)
and its [offline image comparison](../reports/print-area-audit-2026-10-24/full/index.html).

**All 67 variants / 78 orientation states / 84 print surfaces now have completed
provider proofs and reviewed local renders**, with 106 original Printful images
archived. Both sides of every pillow and the notebook use separate identifiable
patterns. Every supported size, color and portrait/landscape state is included.
The browser captured all 78 states with the real renderer without loading or
capture failures. Digital proof completion is not physical sample approval.

The expanded comparison resolved the Samsung exception: current S25 Ultra style
25021 explicitly includes variant 21474 and completes successfully. All four
Samsung model/finish variants and all twelve phone cases have completed proof
comparisons. The shared mockup selector now prefers exact device restrictions
and, for rotatable products, the exact oriented print dimensions. This also
fixes provider rejections caused by pairing portrait style IDs with horizontal
orientation or horizontal A2 style IDs with vertical orientation.

Two additional preview mappings were corrected:

- The black-handle all-over tote's fitted photo rectangle shrank the artwork
  by approximately 12%. Its full-file projection now matches independent
  provider calibration corners within 1.5 pixels in the original photo.
- Both laptop sleeves cropped too much bleed when deriving UVs from nominal
  finished dimensions. Their visible faces now follow the exact provider flat
  template projection and measured body bounds. Independent marker corners
  agree within 0.3% of the visible face, with geometry raycasts checking the
  actual UV attributes. The protruding zipper pull is excluded from the face.

The complete report preserves before/after evidence, exact synthetic input
PNGs, source/product/design hashes, selected styles and per-state results.
All 41 temporary source objects were removed after every new task completed;
signed URLs remain outside the repository. No orders were created.

Regression coverage checks all 26 provider-mesh variants, their front/back
callbacks and landscape drawing. A pixel test compares asymmetric corner and
centre landmarks from real fulfillment PNGs against direct preview drawing for
both bottles, both notebook sides and landscape canvas. Focused configurator,
immutable-artifact, gallery and geometry tests pass. Additional regressions
cover tote/sleeve provider landmarks and device/orientation-specific styles.
Full-resolution raster tests cover every catalog orientation and surface.
The complete suite was not repeated for these localized preview changes.

**Not a manufacturing sign-off:** the 33 procedural previews and three fitted
photo compositions still approximate shape, folds or photographic projection.
Matching upload coordinates and all catalog digital mockups cannot certify
physical print placement, trim/seam variation or colour. Sample approval is
still needed before promising exact finished-product correspondence. No
physical samples were ordered, and nothing was deployed or pushed.
The retained organic-tote photo compositions also correct the earlier blank-color mismatch. Printful's
natural `#edcea5` and black `#101010` colors now sit behind the complete
semi-transparent composition, including the handles. The provider image masks
the outside and handle opening white. Gallery/editor checks cover both colors;
body, handle and hem samples agree with the original mockups within 3 RGB
levels. The 1110 × 1110 photo print rectangles are pixel-identical before and
after this color correction. This verifies digital blank colors; physical
print colors still need sample approval.

### Tote geometry follow-up — 2026-10-25

All three all-over totes and both organic cotton totes now use custom 3D
geometry. The previous flat bag and organic-tote compositions remain as
calibration evidence; they no longer determine the active preview.
The silhouettes follow the supplied front/side photos and Printful's
[all-over tote](https://www.printful.com/custom/accessories/all/all-over-print-tote)
and [Econscious EC8000](https://www.printful.com/custom/bags/personalized/eco-tote-bag-econscious-ec8000)
specifications. The all-over body is nominally 39 × 39 cm with 2.5 cm cotton
webbing; its 7 cm relaxed depth is a visual approximation, not a supplier
dimension. The organic body uses the published 40.6 × 35.6 × 12.7 cm dimensions,
a boxed base and matching cotton straps. Both models have separate outer and
inner walls, an open mouth, shallow tension folds, top hems and stitching.
Local procedural weave textures are released with the viewer's materials.

The all-over face preserves the previous full-file crop (15/17 horizontally,
15/16.5 vertically with the original margins), with outward reading direction
on each side. The organic model maps the complete 1500 × 1500 file to a
25.4 cm front square, positioned 1.3 cm below the body centre; side walls,
back and handles contain no artwork. No fulfillment ID, file dimensions,
safe areas, editable layout or saved print data changed. All four matte
poster variants also use the existing thin-panel renderer in both orientations.

Focused geometry, print-area and gallery tests cover bag volume, open tops,
strap width, single-sided organic printing, reverse reading direction,
texture disposal and the Bags filter containing both product groups. Browser
checks compare front, side and back views against the supplied references.

### Reverse surfaces and accessory construction — 2026-10-25

The black-handle tote's complete existing photograph now uses `contain`, like
the red/yellow variants, in thumbnails and enlargement. Its previous `cover`
fit cropped the handles and base inside the square photo viewport.

Custom panels give the printed front, plain back and edges their own material
groups on a single closed extrusion. They no longer print both caps and mask
the rear with another plane 0.01 cm away. That gap was smaller than a 24-bit
depth step for a 50 × 70 cm poster at the former gallery camera distance.
The viewer also sets its near clipping plane from the measured rotation
envelope, preserving the complete turn/tilt while improving depth precision.

Both sleeve sizes retain their physical dimensions and calibrated provider
front UV rectangles. Separate opaque padded skins, a textured black back,
black perimeter binding, zipper tracks/teeth and two black pulls replace the
rigid extrusion and metal placeholder. References include Printful's
[sleeve specifications and close-ups](https://www.printful.com/custom/tech-accessories/personalized/laptop-sleeve).

The initial twelve cases retain their provider camera paths, full-file print mapping,
safe areas and fulfillment identities. A thin printed rear plate and separate
outer/inner walls form a hollow case, with an unprinted liner, raised camera
rim, buttons and lower charging/speaker openings. Exterior wall UVs continue
the file into its existing bleed instead of colouring every side black.
MagSafe variants have a shallow printed exterior relief. Its rounded annular
band matches the reference photo's width (about 9% of the outer diameter),
replacing the former thin tube while preserving the outside diameter, centre,
maximum height, alignment stem and artwork UVs. Independent photo bounds are
recorded in `test/fixtures/magsafe-ring-landmarks.json`, with geometry and UV
checks for all 36 MagSafe variants. Matte/gloss finish
continues to control artwork roughness. References are Printful's
[MagSafe side and exploded views](https://www.printful.com/custom/products/all/tough-iphone-case-magsafe),
[iPhone tough cases](https://www.printful.com/custom/phone-cases/personalized/tough-iphone-case)
and [Samsung tough cases](https://www.printful.com/custom/phone-cases/personalized/tough-case-for-samsung).

The display phone is a separate `previewAccessory` group, enabled by the
preview-only `displayPhone` descriptor. It supplies the screen, camera module
and lens details seen in installed-phone reference photos. Removing it leaves
the case's camera and charging openings genuinely open. It contributes no
print pixels, safe-area restrictions, pricing or fulfillment data. Procedural
neoprene/lens textures are local and released with the viewer materials.

Regression checks cover cap material ownership (including hidden surfaces),
opaque sleeve backs, unchanged sleeve landmarks, open case cavities and
ports, independent phone inserts, exterior wrap UVs, texture cleanup and
camera clipping through a complete turn. These remain photo-based product
previews rather than manufacturing CAD or physical sample approval.

### Complete tough-case range — 2026-10-25

All active variants of products 601 (29 iPhones × 2 finishes), 798 (18 MagSafe
iPhones × 2 finishes) and 686 (23 Samsung devices × 2 finishes) are offered:
140 variants, including 128 additions. Every variant was in stock for Germany;
140 individual standard-rate estimates to Berlin showed dispatch from Italy
without possible customs fees. Availability-only IDs absent from both active
catalogs and returning 404 for their direct variant lookup are excluded.
`test/fixtures/phone-case-catalog.json` pins the active IDs, device labels,
finishes and product-gallery image mappings. These are current checks, not a
promise of future inventory or routing.

iPhone/MagSafe files remain 1392 × 2220 pixels at 300 dpi (printfile 331);
Samsung files remain 1396 × 2304 pixels at 300 dpi (printfile 441). Each
addition retains its own variant-to-file and exact template association. The
62 guide sources are deduplicated into 59 unchanged PNGs under
`test/fixtures/printful-case-guides/`, with SHA-256 pins in the manifest.
Template coordinates are normalized using their declared dimensions, which
can differ from the downloaded PNG dimensions. Camera contours come from the
grey exclusion mask; conservative safe rectangles remain below the camera and
inside the rounded safe outline. Outer shell bounds also enclose the camera
exclusion: Samsung guides can extend it beyond the main safe body, and an
extrusion hole must not cross its outer contour. The previous products' print
files, safe/layout coordinates, reference photos and prices are unchanged.

Explicit device profiles replace generation-number shortcuts for cameras,
flash/sensors, buttons and rounded/square corners. They cover single-camera
Air, vertical and diagonal dual-camera iPhones, both Pro island styles,
Samsung triple cameras and Ultra layouts including the S20 Ultra periscope.
Older preview camera bounding boxes are reconciled with their unchanged
provider contours. MagSafe relief is measured from the guide where present;
older shared templates omit it, so those profiles use the matching reference
photograph's proportions. Matte/glossy pairs share device geometry and print
coordinates while retaining separate identities, prices and materials.

Printful's Catalog API repeats the single-camera Air photo across all four
iPhone 17 MagSafe models. Those eight variants use their corresponding
unmodified transparent product-page gallery photos, with the exact model
mapping pinned per photo; the prior corrected Pro photo is preserved.
All variant labels are localized in the five translation catalogs.

Regression checks cover all 140 IDs and finish pairs, guide hashes, camera
contours, safe rectangles, actual camera arrangements, transparent photo
overrides and full-resolution corner landmarks for all 70 device/family
profiles. Browser review renders and rotates every profile using the real
viewer. These previews remain calibrated product illustrations; no physical
samples or manufacturing CAD certification are implied.

### Checkout safeguards

Provider numeric costs accept only binary floating-point noise around whole
cents. Real fractional cents and malformed monetary strings remain invalid.
Tough phone cases are explicitly blocked for HK, JP, KR, SG and TW, following
the published product restrictions, even if Printful returns a successful
quote. The policy is public product metadata and is also enforced for cost
estimates, shipping rates, reused checkout sessions and fulfillment submission.
The shipping form identifies affected items and clears stale quote state.

A read-only standard-rate check on 2026-10-24 covered every added variant for
synthetic Germany and US destinations. `shippingAtVerification` in the manifest
records departure country and possible customs per variant. Five mug color/size
combinations currently depart the US for Germany; some oak/white frames depart
Latvia for US delivery. These observations are evidence, not permanent promises;
checkout obtains fresh shipping and customs information for the actual address.

Implementation verification: the full `npm test` suite passed 890 tests on
2026-10-24. Additional focused checks cover reused single/cart checkout sessions,
case-hole ray intersections, front/back reading direction, local photo hashes,
and preview context lifecycle. Browser checks covered the gallery and editor in
side-by-side and stacked layouts. Nothing was deployed or pushed.
