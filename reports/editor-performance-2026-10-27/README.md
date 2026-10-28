# Editor interaction performance — 27 October 2026

## Cause and isolation

Reproduced the two-word editor slowdown in native Safari 26.5.2 on the development Mac using the database-free configurator fixture. Dragging had a 179 ms median frame interval (approximately 5.6 fps), 219 ms p95, and 87 of 90 intervals over 50 ms. The same local case ran at approximately 60 fps in Chromium. This explains why Chromium-only gallery tests did not expose the Safari regression.

The editor's change callback scheduled a complete product preview on every editing frame. The provider mug model repainted and uploaded a 4096 × 4096 atlas: 64 MiB of base RGBA pixels before mipmaps, mostly outside the artwork cell. The cost was paid even when the phone's Canvas view hid the product. Zooming could overlap an already queued expensive update. The gallery itself was suspended with zero retained live viewers during these measurements.

Control experiment: suppressing only `renderProductPreview`, with Fabric, selection, dirty tracking and canvas rendering unchanged, brought native Safari dragging to 17 ms median/p95/max, with zero intervals over 50 ms. A separate 1024-pixel atlas experiment reduced the median to 22 ms, but still spent about 9 ms per preview update. This identified preview generation/upload as the bottleneck; simply reducing its resolution was insufficient to remove it from active editing.

## Changes

- Keep Fabric's immediate canvas rendering and existing advisory-check scheduling. Product previews coalesce to the latest design after 120 ms without another edit/layout update. Pending thumbnail capture is cancelled as soon as another edit arrives.
- Skip product and thumbnail generation in the mobile Canvas view. Switching to Product or leaving the workspace schedules the latest artwork through the existing layout callback.
- Limit the editor's provider atlas to 2048 pixels per edge (16 MiB base RGBA for the square mug atlas). Artwork continues to draw directly in print coordinates. Full product-detail rendering, mesh/UV geometry, editor resolution, stored designs and provider print exports are unchanged.
- Cancel pending preview frames/timers when a viewer is replaced or destroyed.

## Measurements

Individual local runs; these are frame-interval distributions within one run, not medians across repeated runs. Native Safari viewport was 720 × 701 CSS pixels, with the real two-word Fabric editor and provider mug model. Scripted dragging alternated a one-pixel move on 90 successive animation frames. The final probe additionally alternated word edits for 30 frames, then zoomed for 30 frames and observed 60 idle frames. It measures the application path, not physical pointer-to-display latency or production network behavior.

| Native Safari scenario | Median interval | p95 | Maximum | Intervals over 50 ms |
| --- | ---: | ---: | ---: | ---: |
| Original dragging | 179 ms | 219 ms | 1128 ms | 87 / 90 |
| Original zoom, immediately following dragging | 17 ms | 214 ms | 228 ms | 2 / 30 |
| Control: dragging with product updates suppressed | 17 ms | 17 ms | 17 ms | 0 / 90 |
| Fixed dragging | 17 ms | 17 ms | 38 ms | 0 / 90 |
| Fixed text edits | 17 ms | 17 ms | 17 ms | 0 / 30 |
| Fixed zoom, immediately following edits | 17 ms | 37 ms | 41 ms | 0 / 30 |
| Fixed idle | 17 ms | 24 ms | 26 ms | 0 / 60 |

The original drag/zoom/idle capture called `updateTexture` 91 times. The fixed drag/text/zoom/idle capture called it once, after editing settled; the update took 33 ms. Active dragging and text changes submit no product texture uploads. A settled redraw can still take a few frames on Safari; it no longer repeats throughout the gesture. Continuous real-time product animation during a word drag is deliberately replaced by a preview of the latest settled design.

Chromium at 390 × 844 with iPhone device signals entered the actual mobile canvas and measured 16.7 ms median intervals for drag, text and zoom, with no interval over 50 ms and zero product texture updates. This uses a desktop CPU and is not a physical iPhone benchmark.

Native Safari also ran the mobile canvas with iPhone device signals at 720 × 701: dragging and text changes had 17 ms median/p95 intervals, zoom had 17 ms median/18 ms p95, and all phases had zero intervals over 50 ms. No product texture update ran while Canvas was visible. This is also desktop hardware. Safari detected the connected physical iPhone but continued to show **Connecting…** on both checks, so physical-device inspection was unavailable.

## Regression checks and reproduction

223 focused checks pass across editor performance, configurator session/restore behavior, desktop/mobile workspace controls, product pickers, responsive UI, touch/viewport math, overlap warnings and provider atlas rendering. The complete application suite was not requested or run. `git diff --check` passes.

The new regression tests exercise the actual template functions with deterministic clocks: repeated edits keep one pending callback, never upload a product texture while continuous, cancel stale thumbnails, render the latest artwork once, skip all hidden mobile preview types, catch up on Product, cancel work on navigation, and preserve print geometry under the atlas budget.

Run `node scripts/check-configurator-browser.js`, open its emitted local configurator URL with `&probe=editor-performance`, and select **Measure editor interactions**. Append `&device=mobile` for the mobile canvas (use a phone-sized viewport for the portrait layout). The report is `#editor-performance-report`. Fixture-only `&no-preview=1` and `&texture=1024` switches reproduce the control experiments. Neither the fixture nor the probe uses hosted databases, payments or provider writes.

The change is local; no push or deployment was performed.
