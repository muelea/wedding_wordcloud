# MagSafe ring band correction

The thin 0.12 cm torus is replaced by a shallow annulus with rounded edges.
The iPhone 16 Pro reference shows a band about 9% of the circle's outside
diameter; independent image bounds are pinned in
[`test/fixtures/magsafe-ring-landmarks.json`](../../test/fixtures/magsafe-ring-landmarks.json).
The ring widens inwards, preserving its original outside diameter, centre and
maximum height. The alignment stem, camera, shell, handset, materials and
artwork coordinates are unchanged. This is a preview-only correction.

Validation passed: 28 focused checks, including real geometry and artwork UVs
for all 36 MagSafe model/finish variants, camera openings, non-MagSafe case
geometry, exact provider exports and the previously corrected poster frames.

```sh
npm test -- test/product-3d-geometry.test.js test/phone-case-catalog.test.js test/product-print-area-audit.test.js
```

A separate in-app browser verified the running local iPhone 16 Pro matte
preview from the front and at an angle. No console errors were reported.

- [Front view](iphone-16-pro-matte-front.jpg)
- [Angled view](iphone-16-pro-matte-angled.jpg)
