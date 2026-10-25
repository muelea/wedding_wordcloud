# Print-fill performance — 24 October 2026

## Further cold-load optimization

The follow-up keeps the same search portfolio and candidate-selection order, but
overlaps independent numeric candidates through a bounded worker pool. The pool
uses half the reported hardware concurrency, capped at four; unknown/two-thread
devices use one. The first gallery product prepares alone, then the remaining
products use the same bounded parallelism. Palette/side reuse still belongs to
the current page; these cold measurements do not use a saved geometry cache.

Further work removes repeated text-box parsing and score calculation within a
fill, reuses grid storage and scale-independent anchor plans, and marks exact
forbidden positions in the distributed-rotation search. Upright-pair pressure and
all float edge comparisons remain authoritative. Posted tasks avoid browser
nested-timer delays while retaining the eight-millisecond refinement budget.

On the same ordered 40-word Chromium fixture, the final clean four-worker run
observed first-card readiness at **0.83 seconds** and all eight cards at
**3.73 seconds**, compared with the preceding implementation's 1.56 / 11.02
seconds. The longest observed main-thread task was 66 ms, including previews.
All ten serialized optimizer outputs retained their original SHA-256 hashes.
A preceding fresh-origin run observed 0.87 / 3.72 seconds; other late four-worker
runs observed 0.89–0.90 / 3.93 seconds. Three workers measured 0.93 / 4.22 seconds
locally. These are layout-cache-cold
page loads on this workstation with locally served assets, not a claim that a
fresh network load or every mobile device completes in four seconds.

The first product is now usable in under a second in the measured desktop runs;
the entire cold gallery is **not instantaneous**. Guaranteeing every product in
a few milliseconds for arbitrary new clouds would require already computed exact
artwork. This change does not substitute an approximate preview, scale a different
product's layout, or delay calculation until after a customer selects a product.
The remaining cards finish progressively in the background.

Verification for this follow-up passed all **212 focused checks**, covering the
product/orientation and mixed-font matrices, 500-word capacity, repeated Fill
fixed points, SVG/export font metrics, original numeric packing hashes, async
parity, bounded queues, cancellation, worker failure/fallback and configurator
session/loading behavior. Six portable full-search reference cases also retain
the pre-change results with nonlinear test metrics, styled text, emoji, images
and motifs. The phone-viewport browser probe passed all **53 checks**, including
all variants, exact editor handoff, both sides, undo, gallery return and cart
approval. Browser synchronous parity passed on every side; cached reuse took
2.2 ms without starting a worker job. This follow-up did not rerun the complete
database-backed suite; the earlier full-suite outcome is retained below.

## First implementation (comparison baseline)

The first implementation integrated the faster search into `public/js/wordcloud-core.js`.
The synchronous and asynchronous print APIs consume the same deterministic layout
steps. Numeric packing runs through the existing measured-box worker protocol;
font measurements stay on the page, and refinement yields with an eight-millisecond
work budget. The gallery, explicit Fill, initial editor preparation, cloud rebuilds
and automatic product transfers use this background path.

At that stage, `public/js/print-layout-client.js` used one worker, a bounded priority queue,
cancellation, stale-response fencing and exact fallback. Its automatic-only cache
has at most 24 completed entries / 2 MiB and 16 in-flight entries, belongs to this
page only, and returns independent artwork for each print side. Geometry keys
include exact origins, dimensions, content, preferred sizes, styles, resolved fonts
and the engine version; palette changes reuse geometry. No cache records are
written to drafts or baskets. Pillow sides share a calculation; notebook origins
remain separate. Gallery work prioritizes visible cards and deliberate size choices,
drops superseded queued variants, and pauses queued preparation while editing.

The final local Chromium run used the same ordered 40-word wedding input as the
baseline. All ten complete serialized optimizer outputs matched the original
SHA-256 hashes. Observed first-card readiness was 1.56 seconds, all eight cards
were ready in 11.02 seconds (baseline 26.54 seconds), and the longest observed
main-thread task during the layout window was 76 ms (baseline 3,393 ms). The window
includes product-preview rendering, not just layout. These are individual local
observations with the current combined working tree, including concurrent gallery
UI work; they are not mobile percentiles or a promise of sub-second cold fills.

Ten surfaces required nine optimizer calculations and 252 numeric worker jobs;
the unchanged pillow back reused its geometry in approximately 0.2 ms. A complete
unchanged automatic build, including font measurement and recoloring, took 4.8 ms
on the subsequent explicit reuse check and started no worker jobs. The browser's
synchronous-parity check passed on every print side. The reproducible check is
available through `--gallery` / `&probe=performance` and its verification button.

Verification includes the original-output packing regression corpus (42 cases,
including the 80/120/200-word branch boundaries and 500 words), subpixel/touching
edge cases, asynchronous mixed-font parity, cancellation and fallback tests,
bounded cache tests, viewport/variant scheduling, all five fonts across the existing
product/orientation matrix, and real-browser gallery handoff checks. The desktop
gallery probe and all 44 mobile-viewport probe checks passed. Mobile Fill completed
and its single-step Undo restored editing history. This was mobile emulation;
Safari was in use by the parallel work and was left untouched.

The complete suite with four concurrent files reported 866 passes and two failures
out of 868 checks. Both failures describe the same Postgres foundation case and
its parent: the existing concurrent setup hit `55P03` (row-lock timeout). Rerunning
that entire file alone passed all 11 checks. An earlier default-concurrency run
also exposed stale gallery/loader test fixtures, which were corrected, and two
socket deadline failures; all eight word/isolation checks passed together when
rerun serially. The configurator integration file separately passed all 27 checks.
The full suite therefore was not wholly green in one concurrent invocation; every
failing case passed its focused recheck. Runtime database locks/timeouts and socket
code were not changed.

The implementation preserves the parallel gallery/cart work. Nothing was pushed
or deployed. The sections below retain the initial investigation and prototype
measurements for comparison.

## Initial investigation

The recommended change is to preserve the current deterministic layout search and
replace its repeated collision queries with exact forbidden-position bit masks.
Combine that with a bounded worker, visible-product priority and reuse of completed
automatic layouts. The isolated prototype already makes the complete gallery about
2.5 times faster in Chromium, with identical serialized designs in the measured
comparison. Background execution and caching are the next steps toward a responsive,
fast-feeling gallery as the catalog grows.

The initial investigation left application code and the existing uncommitted
gallery work intact; the follow-up implementation is described above.

## What the current implementation does

- `views/configure.ejs:3936` builds product artwork from the word-frequency curve
  and real Canvas font measurements, then calls the print optimizer and palette pass.
- `public/js/design-layout.js:1030` compares horizontal and rotated layouts,
  placement priorities, distributed vertical accents and sparse row arrangements.
  It grows text within the existing allowance, validates bounds/non-overlap,
  selects candidates, and balances their visible spacing.
- `public/js/wordcloud-core.js:499` supplies the shared packing engine. Its
  distributed search uses a product-shaped grid, eight variants for the measured
  40-word case, and ten scale trials per variant. Each trial repeatedly searches
  nearby grid positions and checks their rectangles against spatial buckets.
- `public/js/product-gallery.js:147` serializes preparation and caches promises
  by product key. Its timer yields **between** calculations; each optimizer call
  still occupies the main thread until completion. The intersection observer
  controls mug rendering, while every initial product layout is still queued.
- `views/configure.ejs:5851` separately builds every print side. Eight cards mean
  ten optimizer calls because the pillow and notebook each have two sides.

For the measured seed, each surface invokes the shared packer 28 times: 280 calls
across the gallery, and approximately 22,400 distributed scale trials before counting
the other candidate families. Existing measurement caching and the shorter path for
more than 120 elements already help; this is not an uncached naive packer.

## Measurements

The browser fixture used the 40 entries in
`marketing/clouds/classic-wedding.json`, sorted by descending contribution count
and English text comparison to match the benchmark's explicit source order. It
rendered the real configurator, bundled fonts and product assets with the existing
database-free fixture. No provider or database was involved.

These are local macOS/ARM64 Chromium observations, not mobile performance promises.
The final sequential A/B comparison ran after the Node tests and other benchmark
processes finished. The prototype changed only the shared packing search; gallery
scheduling, font measurement, quality scoring, candidate counts and spacing passes
remained the same.

| Measurement | Current engine | Prototype | Improvement |
| --- | ---: | ---: | ---: |
| All eight cards have prepared artwork | 26.54 s | 10.72 s | 2.48× |
| Total optimizer time, ten surfaces | 26.14 s | 10.33 s | 2.53× |
| Time inside the shared packer | 22.28 s | 6.14 s | 3.63× |
| Longest observed main-thread task | 3.393 s | 1.105 s | 3.07× shorter |

The shared packer consumed about 85% of optimizer time in that baseline. An earlier
browser comparison measured 28.57 s versus 10.34 s for the complete gallery, so the
observed overall improvement was roughly 2.5–2.8× across these exploratory runs.
These are individual runs, not statistical percentiles. “Prepared artwork” means
the gallery's design is ready and its selection control is enabled; it does not
measure final image-network completion or GPU presentation.

A Node CPU profile independently identified `collides`, `consider` and their
placement loop as the main hot path. Native font measurement also contributes.
Coverage/empty-region scoring was a smaller cost. This supports optimizing the
collision search first while retaining the existing quality criteria.

## The prototype algorithm

The current algorithm already chooses from a finite grid of candidate centers.
For each word and scale, every placed rectangle excludes a rectangular range of
those centers. The prototype encodes the union of those forbidden ranges in
`Uint32Array` row and column masks.

It first checks the preferred anchor directly. If that is blocked, it builds the
masks and finds the first free position on each successive search ring using bit
operations. It preserves the original ring, direction, edge order and tie-breaking.
Analytical range estimates are corrected using the original floating-point
coordinate comparisons. These masks describe exact candidate-center collisions;
they do not approximate painted words with a lower-resolution occupancy image.

The free-rectangle candidate family, scale trials, priorities, rotations, actual
font metrics, output rounding, quality selection and final spacing remain intact.
The change accelerates the existing search without reducing its portfolio.

## Verification completed

- Current implementation: all 36 tests in `area-layout`, `print-fill` and
  `product-gallery` passed. These include all products/orientations, mixed content,
  repeated fills, historical spacing regressions and capacity clouds.
- Current implementation: all 11 SVG export and actual-font-metric tests passed.
- Existing real-browser gallery probe: all checks passed, including catalog
  variants, exact front/back editor handoff, return-to-gallery behavior and cart
  artwork preservation.
- Prototype: all 24 tests in `print-fill`, `svg-export` and `export-font-metrics`
  passed with the complete prototype core substituted in memory.
- Prototype: deep equality against the original output passed for 14 complete
  designs: ten gallery surfaces plus sparse, reported dense, emoji-heavy and
  500-word mug cases. Equality includes geometry, rotation, color and provenance.
- Prototype: deep equality passed for 48 seeded packing cases spanning 1, 2, 5,
  10, 12, 13, 40, 73, 120, 121, 200 and 500 elements, varied proportions and emoji.
- Chromium: SHA-256 hashes of all ten complete serialized optimizer outputs
  matched between the current engine and final prototype.
- `git diff --check` passed. The full `npm test` suite was not run, consistent with
  the repository's focused verification policy for this investigation.

This is evidence of equivalence on the tested corpus, not a universal proof.
Production integration still needs explicit touching-edge/subpixel cases, all five
fonts/styles, the existing font-geometry coverage, and Safari/mobile acceptance.

## Recommended implementation

1. **Integrate the accelerated search with an exact-output regression harness.**
   Preserve the current candidate and scoring order. Include threshold sizes,
   extreme aspect ratios and floating-point boundary cases. Keep the shared
   live/export consumers covered because they use this same core.
2. **Run numeric packing in one long-lived, bounded worker.** The live cloud
   already demonstrates the right boundary in `cloud-layout-worker.js` and
   `live-cloud-layout.js`: send measured boxes, return geometry, fence stale
   results and dispose cleanly. Batch a product's candidate packings to avoid
   28 separate worker round trips. Preserve Canvas measurements from the page;
   slice the remaining measurement/refinement work between bounded phases.
   A worker keeps computation independent of UI scripts, as defined by the
   [HTML worker specification](https://html.spec.whatwg.org/multipage/workers.html).
   Worker execution improves responsiveness; it does not itself eliminate CPU work.
3. **Prepare visible cards first, and prioritize deliberate selection.** Queue
   offscreen products after visible/near-visible ones. Allow product/variant
   changes to supersede obsolete queued work. Keep one active job, a bounded
   catalog queue and generation/version checks. Additional catalog products
   should not delay the first visible cards.
4. **Reuse exact automatic artwork with explicit invalidation.** Key an
   event-scoped, bounded cache by ordered contents/counts, resolved slot geometry,
   fonts/styles and their asset revision, and layout-engine version. Preserve
   existing draft expiry and account/event isolation. Cache geometry independently
   of palette, then run the existing color pass. Exact pillow front/back geometry
   is duplicated today and can share one calculation with independent copies.
   The notebook's two safe areas differ only in horizontal offset and the measured
   results translated exactly, but generalized origin normalization requires
   dedicated equivalence tests because rounding and fingerprints include origin.
   Matching aspect ratios alone are insufficient for exact reuse: DPI, absolute
   dimensions, minimum sizes and rounding can change the winning arrangement.
5. **Keep preview-to-editor handoff exact.** Reuse the prepared tenth-pixel design
   when opening the editor or adding to the basket. Edited drafts and immutable
   cart/paid artifacts retain their current state contract. A palette change or
   gallery revisit should not launch another geometry search for unchanged input.

Initial acceptance targets should distinguish cold calculation from cached use:
no layout-caused main-thread task over 50 ms on the selected test devices,
near-immediate cached gallery re-entry, visible-card work independent of offscreen
catalog size, and exact output parity. The measured desktop prototype still needs
roughly one second per cold surface. Sub-100-ms cold fills and performance on
phones have **not** been established; validate those before making that promise.

## Local investigation artifacts

The standalone prototype, baseline harness, saved reference designs, equivalence
runner, CPU profile and browser fixture are preserved outside application code at
`/private/tmp/wolkenworte-fill-audit-2026-10-24/`. They are local temporary artifacts,
not production modules or committed test fixtures. Run from the repository root:

```sh
node /private/tmp/wolkenworte-fill-audit-2026-10-24/verify.cjs
NODE_ENV=test node --require /private/tmp/wolkenworte-fill-audit-2026-10-24/preload.cjs \
  --test test/print-fill.test.js test/svg-export.test.js test/export-font-metrics.test.js
node /private/tmp/wolkenworte-fill-audit-2026-10-24/browser.cjs
```

The browser runner prints its loopback URL. Open a fresh URL for the current
engine, then add `&engine=prototype` for the prototype. Its visible report records
durations, long tasks and complete-output hashes. It never mounts in the real app.
