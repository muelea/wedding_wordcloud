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

The mug gallery also shows small reference photos beside the product details.
These are the unmodified `variants[].image` files returned by Catalog API
`GET /products/19` on 2026-10-24, for the selected white glossy mug size:

- `white-mug-325ml.jpg`: variant 1320, `https://files.cdn.printful.com/products/19/1320_1663762583.jpg`
- `white-mug-444ml.jpg`: variant 4830, `https://files.cdn.printful.com/products/19/4830_1519394046.jpg`
- `white-mug-591ml.jpg`: variant 16586, `https://files.cdn.printful.com/products/19/16586_1680616351.jpg`

The main mug preview continues to use the existing 3D renderer and print mapping.
Photo framing is separate from print geometry: the 444 ml photo is positioned
at 20% vertically to exclude its excess bottom whitespace; the tall 591 ml mug
is contained in the image frame so its rim and base stay visible.

Catalog expansion (2026-10-24): `catalog-{variantId}.jpg` files are unmodified
`variants[].image` responses, with source URLs pinned in
`src/productCatalogManifest.json`. `layer-10457.png` and `layer-10458.png` are
Printful's organic cotton tote front composition layers; their exact full-file
rectangles and blank fabric colors are pinned in the same manifest. New 3D
previews use procedural geometry, not these reference photographs. See
`docs/print-geometry.md` for the supported range and physical fidelity limits.

The organic tote layers are semi-transparent over the complete fabric blank,
including the handles. Their provider `background_color` must sit behind the
whole composition, with the layer's opaque white pixels masking the outside
and handle opening. Coloring only the artwork canvas leaves a white bag around
a colored print rectangle. The gallery and editor share this full-composite
background; the original provider layers remain unmodified.
