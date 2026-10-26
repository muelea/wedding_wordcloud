# Exact print-fill and gallery performance — 25 October 2026

**Follow-up:** Native Safari mouse-wheel testing exposed stalls that the scripted scrolling benchmark below missed. The subsequent fixes and native-input verification are recorded in [the Safari scrolling investigation](gallery-scroll-2026-10-25.md); those results supersede the scrolling conclusion in this report.

The 10 pt minimum and existing layouts are preserved. The changes reduce measurement and numeric search work, and fix the large gallery scrolling stalls caused by repeated 3D construction. They **have not achieved an almost-instant, empty-cache full gallery**.

The final fixed catalog snapshot contains 344 variants in 26 groups, with 28 default print sides. These measurements prepare the default variant of every group, not every possible variant. The catalog grew during parallel development; comparisons below keep it fixed within each pair.

## Layout changes

- Free-rectangle containment checks compare pieces cut on the same side and unchanged rectangles that can contain them. Original order and duplicate ties remain intact.
- Distributed packing finds the first nonempty square ring using row masks, then applies the original spiral tie order on that ring. It no longer builds a transposed collision map. Single-word masks use a simpler writing loop.
- Print rotation search examines the nearest available column on each side of its anchor in each row. Distance arithmetic, floating-point score plateaus, row order and first-column ties are preserved.
- Automatic print seeds use the existing frequency curve without measuring discarded live-cloud boxes. The optimizer still measures every box it actually uses.
- Private configurator canvases share **actual native Canvas TextMetrics** within one client. Keys include the exact assigned font string and text-shaping settings. Storage is bounded to 8,192 entries and a 4 MiB accounting budget, invalidated on font loading completion and disposal. Loading fonts bypass sharing. Completed layouts distinguish measurement settings and font epochs. No estimated widths or scaled-font substitutes are used.
- The loopback performance probe now checks enabled Customize buttons, derives the surface count from the catalog, reports capacity/errors, and verifies the actual snapshots. The previous readiness check referred to a div's nonexistent `disabled` property and assumed a smaller catalog. Cache verification uses a recently completed entry because the bounded LRU may evict the first product in a large catalog.

Candidate portfolios, iteration counts, scoring, the physical 10 pt rule and insufficient-capacity behavior are unchanged. Production workers still receive measured rectangles; native font measurement remains in the page.

## Cold-load measurements

Local Chromium/in-app browser on an Apple M1, four numeric workers, sorted 40-word `classic-wedding.json` input. Each navigation starts with empty application layout/measurement caches. Browser and OS font caches can outlive navigation. Another worker was active on the shared machine. These are local observations, not production/mobile percentiles or hosted network/database startup timings.

Readiness means the actual artwork is ready to customize for all groups. It does not imply all offscreen 3D models have been constructed.

| Fixed 344-variant catalog, three paired runs | Original | Optimized |
| --- | ---: | ---: |
| First group ready, median | 2.05 s | 1.48 s |
| All 26 groups ready, median | 15.95 s | 11.23 s |
| All groups, individual runs | 15.95 / 21.83 / 15.67 s | 11.06 / 11.64 / 11.23 s |
| Sum of numeric-worker job elapsed durations, median | 35.62 s | 15.88 s |
| Numeric searches per navigation | 729 | 729 |

The paired median full-gallery time fell about 30%. Worker durations overlap across workers and include scheduling contention; their sum is **not measured OS CPU time**. Subsequent optimized instrumentation runs ranged from 10.64 to 16.15 s, so the paired result must not be presented as a latency guarantee. One instrumented run made 53,580 native measurements, spending 2.47 s inside `measureText` alone; this excludes font assignment and the remaining search/refinement work.

Earlier catalog comparisons are separate: a 23-group iteration measured 12.85 → 8.24 s; a fixed 26-group/216-variant pair measured 10.34 → 9.86 s. Neither establishes an instant full gallery for the current catalog.

## Gallery scrolling

The original intersection callback immediately destroyed 3D viewers leaving the viewport and built viewers synchronously as new cards entered. A repeatable 12-second down-and-back pass through the settled gallery created 47 viewers, spending 5.20 s constructing them. The worst frame gap was 1.43 s.

The gallery now:

- Defers new 3D construction until 120 ms after page scrolling settles.
- Retains six nearby viewers, evicting the least recently viewed offscreen one when space is needed. Visible cards take priority if a viewport contains more than six previews. Eviction preserves a bitmap of the exact rendered view.
- Avoids resizing unchanged 3D previews and painting offscreen/unchanged flat previews. ResizeObserver schedules only affected cards.
- Releases retained viewers and pending scroll work on editor entry/suspension and disposal. Retry, filtering and variant changes retain their cleanup behavior.

| Settled gallery, same continuous scroll | Before | After |
| --- | ---: | ---: |
| Viewers constructed during pass | 47 | 0 |
| Frames observed | 324 | 720 |
| Frame gaps over 50 ms | 21 | 0 |
| Worst frame gap | 1,433.9 ms | 17.8 ms |
| Long tasks | 24 | 0 |

A second run with the repository probe observed 720 frames, zero long tasks, zero gaps over 50 ms and a 17.7 ms maximum gap. Artwork snapshots remained byte-identical, no new layout jobs started, and no preview errors occurred. Native browser scrolling followed by a pause rendered all six visible middle-gallery previews successfully; returning to the top restored those previews successfully too.

New, unvisited 3D previews wait until scrolling stops; revisited cards can retain their live viewer or cached image. Model construction after stopping can still take time. These measurements cover desktop Chromium, not physical-device Safari or touch scrolling. During a separate **cold-load** scroll, computation still produced 14 frame gaps above 50 ms, with a 66.7 ms maximum; smooth settled-gallery scrolling does not imply perfectly smooth scrolling during the initial computation.

The reusable check is available through the database-free fixture with `?probe=performance&view=products&workers=4`, then **Measure gallery scrolling**. It records frame timing, model construction, layout-job reuse and snapshot preservation. Hardware timing is reported rather than asserted as a universal threshold.

## Exactness and verification

All **28 default print-side SHA-256 hashes match the original engine**, including colors, fingerprints, rotations and rounded coordinates. All sides have complete word sets, no overlaps, measured bounds inside safe areas and no ordinary text below 10 pt. Async layouts match synchronous layouts. The repository probe also passes exact-layout and retained-cache reuse verification after the scrolling change.

The final focused run passes **119 tests**. The gallery's 35 tests also pass after the final display-density invalidation change. Coverage includes:

- `packing-parity.test.js`: 42 fixed numeric references plus touching/narrow grids.
- `svg-export.test.js`, `export-font-metrics.test.js`, `print-readability.test.js`, `print-fill.test.js`.
- `print-layout-async.test.js`, `print-layout-client.test.js`, `configurator-layout-feedback.test.js`.
- `product-gallery.test.js`, including new scroll deferral, retained bitmap, bounded viewer eviction, suspension and targeted repaint regressions.
- `mug-3d-lifecycle.test.js` for renderer/resource cleanup.

A separate focused `area-layout.test.js` check (`^fit-area preserves fonts`) passes with five real fonts, custom angles, duplicate words, emoji, images/icons and repeated fixed-point behavior. In the browser, entering the editor removes every retained gallery canvas, and returning restores all 26 prepared designs without errors. The complete-search reference hashes pass, and a separate native-Canvas comparison of 23 earlier default products matches original JSON byte for byte. This does not claim exhaustive verification of all 344 variants and orientations.

Raw measurements, CPU profiles, baseline output and test logs are in `/private/tmp/ww-cold-2026-10-25/`. The `browser-344-{before,after}-verified.json` files contain the original/output hashes; `repository-probe-verified.json` and `repository-scroll.json` contain the reusable probes' results. The full database-backed suite was not run for this localized frontend performance work.

## Remaining limit and recommendation

A new cloud still requires hundreds of searches and thousands of distinct font measurements. No result supports calling a truly uncached full gallery instant.

For near-instant navigation from an established live cloud while preserving these exact layouts, the next architectural step is **browser-side preparation before navigation and reuse of completed layouts**. Reuse must include ordered words/counts, exact product geometry, DPI/10 pt policy, font environment and engine version. Changed inputs need computation. This improves that journey; it does not make a genuinely new cloud free to calculate. This preparation architecture has not been implemented in this change.

A whole-layout OffscreenCanvas worker prototype was evaluated and removed: its font metrics sometimes differed from the page at fractional sizes, and exact replay/verification plus fallback erased its speed advantage. An early bisection-rounding exit was also rejected because it did not reduce real native measurement calls. Approximating metrics, dropping candidates or accepting different layouts would violate the requested constraint.

No push or deployment was performed. Parallel catalog/UI changes were preserved.
