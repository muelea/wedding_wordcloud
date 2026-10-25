# Product preview meshes

These 14 GLBs originate from Printful's publicly served product preview assets,
retrieved on 2026-10-24, originally integrated for 26 exact product/printfile matches. Source
filenames, URLs, original SHA-256 values and prepared asset hashes are pinned in
[`src/productPreviewModels.json`](../../../src/productPreviewModels.json).
The mapping source is Printful's
[catalog preview configuration](https://static.cdn.printful.com/dist-pf/62351.c6912764bc6932dba2b3.js);
original files use its
[3D asset directory](https://static.cdn.printful.com/static/v880/generator/3d-objects/).

The prepared GLBs retain the original geometry, indices, normals, UVs, material
names and node transforms. Embedded sample images and texture references are
removed. Two small JPEG atlases retain cork, paper and notebook binding details
with the sample print areas cleared. The viewer paints current front/back print
canvases into each original atlas layout; colored mug accents and metallic cells
are handled separately. Nothing in this folder is used for fulfillment artwork.

Runtime requests use content-hashed local assets and the pinned npm Three.js
loader. No Printful request, CDN script or model download is needed at startup.
Gallery viewers load on demand and release their GPU resources on removal.

To reproduce after obtaining the reviewed original files in a separate folder:

```sh
node scripts/prepare-product-models.js /path/to/reviewed-original-GLBs
```

The script refuses changed source hashes. Review a changed upstream model and
its mapping before updating the manifest. Do not replace unmatched catalog
variants with a similar model automatically: matching uses both the Printful
product ID and printfile ID. The explicit reviewed adaptations below are separate
from those native matches. See [`docs/print-geometry.md`](../../../docs/print-geometry.md).

## Colored-interior 444 ml adaptation — 2026-10-25

Printful's public designer provides 3D for the 325 ml colored mug, but hides
that option for 444 ml. The approved `colored-interior-444` adaptation reuses
the pinned white 444 ml geometry (`19-15oz-mug.glb`) for product 403, printfile
44. Both catalog products specify 11.9 cm height, 8.5 cm diameter and the same
2700 × 1140 print file. This is an adapted white-mug preview, not a separately
published Printful colored-mug GLB.

The manifest records its source hash and four connected vertex islands: inner
walls/rim, inner base, and two handle halves. Runtime vertex colors give those
islands the selected accent; the exterior, lower foot and band below the rim
stay white. The shape, triangle indices, normals and UV buffers are unchanged,
and every vertex in the print cell remains untinted. No extra GLB or raster
mask is required. The white mug gets no color mask. Re-preparation preserves
this adaptation only while its source hash still matches.

The offered 444 ml accents use the live designer's published swatches, checked
on 2026-10-25: Black `#050505`, Blue `#1e9fcd`, Dark Blue `#1b1b51`, Red
`#e32a2d`, and Pink `#f6a1b1`. Source: Printful's
[colored-interior mug](https://www.printful.com/custom/mugs/personalized/ceramic-mug?productId=403&productSlug=white-ceramic-mug-with-color-inside).
These correct the older approximate 444 ml accent values; normal lighting and
reflections still affect the appearance of the preview.

All fulfillment product/variant IDs, safe areas and print files remain those
of the selected colored mug. Reference comparisons and browser checks are in
[`reports/product-ux-2026-10-25/colored-mug-444/`](../../../reports/product-ux-2026-10-25/colored-mug-444/).

## Smaller square pillow adaptation — 2026-10-25

The 36 cm and 41 cm pillows explicitly adapt the pinned square pillow mesh at
35.56 cm and 40.64 cm. A separate reviewed adaptation record pins these sizes,
without claiming new upstream mappings. Their full-resolution front/back files populate
the original atlas cells; scaling changes only the preview's parent transform.

Public availability establishes technical access, not a reuse license. No
separate mesh license was found in the retrieved assets; confirm permission
with Printful before public commercial distribution. This integration is local
and has not been deployed.
