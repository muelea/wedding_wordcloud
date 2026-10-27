# Print-content pipeline audit — 2026-10-27

This is a local pre-deployment audit. The maintainer clarified that no deployment,
commit or push is authorized during this work. Mockup queue, loading, retry and
expiry changes are owned by the separate chat **Prüfe Mockup-Loading und Polling**;
that chat was notified of the renderer changes and shared-file boundaries.

## Findings and local corrections

| Finding | Reproduction | Correction |
| --- | --- | --- |
| Browser fallback can hide missing print glyphs | Classic accepts `東京`, but its glyph indices are both zero; other offered fonts also accept unavailable letters/symbols. | Validate every text run against the selected normal/bold font before cart saving. Provider outlining also rejects missing glyphs, protecting legacy/direct rendering paths. |
| Available glyphs alone do not prove correct text shaping | Baloo 2 contains `नमस्ते शक्ति`, but the outline exporter changes the joined letters and vowel positions. See `complex-script-before.png`. Remaining combining marks have the same unsupported positioning risk. | Reject Devanagari and remaining combining marks after the normal NFC sanitization. Return an actionable localized save error before payment. This adds an explicit supported-text boundary; it does not add complex-script support. |
| Cuba's white stripes and star turn black in print | The source flag inherits `fill="#fff"` from its SVG root. The inline print parser discarded that root attribute. | Preserve root presentation attributes in the embedded artwork. |
| Qatar's flag changes proportions in print | Its intrinsic 1400×550 viewport intentionally stretches a 75×18 viewBox with `preserveAspectRatio="none"`. The print exporter replaced that with `meet`. | Preserve the original SVG viewport and aspect-ratio rule inside the outer contained emoji box. |
| A missing browser font face can be accepted | Font loading flattened both load results before checking for an empty result; a loaded normal face could mask an absent bold face or vice versa. | Require each requested face to return loaded fonts independently. |

Account previews report the same unsupported-text condition clearly. Other
account persistence, manual-save semantics and commerce isolation are unchanged.
No mockup-generation/loading code was modified by this audit.

## Pipeline traced

1. The editor serializes whole-word font, weight, italic slant, underline,
   strike-through, colour, position, rotation and image source/geometry.
2. Configuration saving normalizes and validates every surface, then checks
   reproducibility and raster decoding before accepting an immutable snapshot.
3. Text becomes local-font vector outlines; bundled emoji vectors retain their
   own paints and proportions. PNG/JPEG uploads are decoded directly by canvas
   and interleaved with vector runs, preserving stacking order. This avoids the
   production librsvg limitation that can omit embedded raster images.
4. Customer preparation renders and uploads one immutable PNG per print surface.
   The configuration/product/design specification and byte SHA-256 are recorded.
5. Printful mockups reference those prepared objects through signed URLs. Approval
   is bound to the exact configurations, completed surface previews and active
   prepared-file references.
6. After verified payment, production artifacts reference the same Storage object.
   Fulfillment does not render a new PNG or upload another copy. The order payload
   uses exact variant/placement mappings and opaque application capability URLs.
7. Serving a paid capability verifies the stored byte length and SHA-256 before
   returning PNG bytes. Wrong IDs/nonces and changed specifications fail closed.

## Evidence

- `test/print-approval.test.js` now carries all **80 font/style combinations**
  (five fonts × normal/bold × normal/italic × underline on/off × strike-through
  on/off), complex emoji sequences, Cuba/Qatar flags, rotated PNG/JPEG uploads
  and different front/back pillow images through real local HTTP routes,
  disposable migrated Postgres, preview approval, a signed simulated payment,
  production artifact creation and the final Printful payload. It verifies
  exact stored/served bytes, dimensions, image pixels and every text cell, with
  no render/upload after approval.
- The same fixture is retained in `approved-print.png` at **2700×1050** with
  transparency. `proof.json` records its SHA-256 and byte length. This PNG is a
  renderer proof, not a customer purchase or a provider mockup.
- `test/emoji-rendering.test.js` compares the actual rendered browser-source and
  inline-print pixels of **all 3,944 bundled emoji assets**, at intrinsic
  resolution. It checks nonempty content and premultiplied RGBA differences;
  the fixes make the complete catalog pass.
- Font tables and canvas advances are checked for all five normal/bold faces and
  letters used by the six supported locales. Font/style tests cover rotation,
  decoration, vector outlining, product orientations and missing/unsupported
  characters. Cart and account endpoints have regression coverage for rejection.
- Raster tests cover PNG/JPEG presence, transparency, holes, colour, ten rotations,
  overlapping sources, layer order, safe-area edges, decoding failures,
  deterministic output, concurrent isolation, strip boundaries and all catalog
  orientations/surfaces. The full catalog raster test passed locally.
- Chromium 155: **35 browser checks passed**, including add, transform,
  undo/redo and serialized reload. At small display sizes Fabric's extra bitmap
  sampling changes edge pixels. The probe retains its 2.5% content threshold and
  also compares 2×2 premultiplied averages only when raw error is below 5%; the
  deliberate cropped-source regression must still fail. Native image pixels and
  print geometry are not changed to satisfy this probe.
- The existing guarded production command's Linux verification list now includes
  text-style and emoji checks, in addition to raster and font checks. No release
  command was run.

Completed verification:

| Check | Result |
| --- | --- |
| Final native cart/account save, approval/payment/file reuse and localization run | 69 passed |
| Native font/style contracts, including unsupported shaping | 28 passed |
| Native complete emoji asset parity and crop-detection regression | 6 passed |
| Linux image, font, style and emoji content run | 64 of 65 passed initially; the one failing Caveat edge comparison is explained below and passes in the focused follow-up |
| Linux focused font/style and neighboring exact export-metrics checks | 32 passed |
| Real Chromium 155 emoji lifecycle checks | 35 passed |
| Actual Fabric editor versus provider PNG geometry, plain and mixed labels | 160 cases; no painted-bound difference above two print pixels |
| Full-resolution uploaded-image catalog raster check, native runtime | 343 products, 446 orientation states, 452 print surfaces passed |
| Candidate image versus audited source/font SHA-256 manifest | 24 files matched; zero mismatches |
| Diff whitespace check | Passed |

The Linux raster run intentionally excludes only the exhaustive catalog raster
matrix already passed locally. It includes decoding, rotation, overlap,
transparency, strip parity, malformed inputs and the image-count limit.
The first combined Linux run found a two-pixel Caveat painted-edge difference
between Pango text hinting and SVG outlines, against an existing one-pixel bound.
The comparison now allows two pixels, matching the independent real-Fabric
measurement and the existing rotated-font allowance. The focused Linux follow-up
passes every font/style plus exact glyph-advance checks. No font file, glyph path,
print coordinate or renderer output was changed to make that comparison pass.
Two print pixels are approximately 0.17 mm at 300 DPI, or 0.34 mm at 150 DPI;
this remains a disclosed rasterization difference, not pixel identity.

The broader release-wide suite was deliberately interrupted after the maintainer
clarified the audit-only scope. It had also begun during concurrent mockup edits.
Its interruption output is not evidence of functional regressions and it is not
a completed full-suite result or release approval. No release command was run.
Tests use synthetic artwork, simulated external providers and local disposable
Postgres. Hosted customer/purchase data is not a fixture.

## Scope of the conclusion

The file reuse contract can be proven byte-for-byte. A successful mockup by itself
cannot prove every editor glyph or raster image survived the earlier renderer.
The defects above demonstrate why both content pixels and final bytes matter.

This run does not create or confirm a real Printful order, make a real payment,
verify a fresh provider download of this candidate, or certify a physical sample.
The provider boundary is simulated in the end-to-end test. The current API
contract was checked against Printful's official
[print-file documentation](https://developers.printful.com/docs/) and
[v2 layer positioning documentation](https://developers.printful.com/docs/v2-beta/).
Provider print dimensions/aspect ratios and rotatable print files determine
placement; the mockup is a reference for physical printing, not a manufacturing
or colour guarantee. Safari/Firefox/Android were not exercised in this run.

The checkout is shared with ongoing authorized work. A future release still
requires verification of a stable exact commit under the existing guarded
release process. This audit is not production release approval.
