# Framed poster preview calibration

The old 0.9 cm preview rails were visibly narrower than Printful's reference
photographs. The poster-only geometry now uses size-specific photo proportions,
mitred rails, a shallow inner lip and a small outer bevel. Oak has procedural
grain running along each rail. These are visual calibrations, not factory CAD
dimensions. The existing full artwork panel, print coordinates and fulfillment
files are preserved. Floating framed canvases use their existing renderer.

Independent source-photo bounds for all nine sizes are recorded in
[`test/fixtures/framed-poster-landmarks.json`](../../test/fixtures/framed-poster-landmarks.json).
Tests compare the horizontal and vertical rail fractions for every offered
size/colour in portrait and landscape, within 0.35 percentage points of the
photo's overall extent. They also verify full artwork UVs, opaque unprinted
backs, a raised inner lip, colour consistency and single-release oak textures.

Validation passed: 46 focused checks using:

```sh
npm test -- test/product-3d-geometry.test.js test/product-print-area-audit.test.js test/product-catalog.test.js test/mug-3d-lifecycle.test.js
```

Browser review used a separate in-app browser. Black 30 × 40 cm and oak were
checked against the running local product previews. The isolated repository
browser fixture supplied synthetic wedding artwork for black 30 × 40 cm and
white A2, including the real editor's portrait-to-landscape switch. No browser
console errors were reported. No application records or provider jobs were
created by this verification.

- [Black 30 × 40 cm, blank](black-30x40.jpg)
- [Black 30 × 40 cm, synthetic artwork](black-30x40-artwork.jpg)
- [Oak, angled construction](oak-angled.jpg)
- [White A2, portrait artwork](white-a2-artwork.jpg)
- [White A2, landscape artwork](white-a2-landscape.jpg)
