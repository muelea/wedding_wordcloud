# Product mockup assets

These are Printful's official blank-product composition layers for the exact
catalog variants offered by the configurator. The design canvas is rendered
under each layer so that product edges, material texture, handles, binding,
folds and shadows remain visible without calling the asynchronous Mockup
Generator during editing.

Retrieved from Printful's Catalog API on 2026-08-25:

- `tote-front.jpg`: product 84, variant 4533, front-facing catalog image
- `coaster-flat.png`: product 611, variant 15662, flat front style 3006
- `matte-poster-30x40.png`: product 268, variant 8948, vertical flat style 16291
- `matte-poster-50x70.png`: product 268, variant 8952, vertical flat style 16293
- `framed-poster-black-30x40.png`: product 304, variant 9357, black vertical flat style 24662
- `framed-poster-black-50x70.png`: product 304, variant 9358, black vertical flat style 24667
- `throw-blanket-flat-horizontal.png`: product 395, variant 10986, horizontal flat style 3051
- `spiral-notebook-front.png`: product 474, variant 12141, front flat style 7424
- `spiral-notebook-back.png`: product 474, variant 12141, back flat style 7425
- `basic-pillow-flat.png`: product 83, variant 4532, 18 x 18 inch flat style 12675/12676

Do not replace these with generic product photography: the preview must keep
matching the Printful variant that will actually be ordered.

The full-file mappings for coaster, matte posters, blanket and both notebook
sides were rechecked against Printful's positional API on 2026-09-03. Their
local images match the API assets byte for byte. See
[`docs/print-geometry.md`](../../../docs/print-geometry.md) for safe-area sources,
verified dimensions, and the limits of photograph-based previews for the tote,
framed posters and pillow.
