# Safari mouse-wheel investigation — 25 October 2026

The reported delayed scrolling was reproducible with native Safari wheel input. The earlier `scrollTo` benchmark did not cover this input path or pauses between gestures; its smooth timing did not establish smooth mouse-wheel scrolling.

## Findings and changes

1. **Previously rendered cards were still rebuilding WebGL models.** The six-viewer cache evicted old models, but reentering the viewport rebuilt them even though an exact bitmap had been retained. Pauses between wheel movements also triggered rows of new models. A native down-and-back reproduction created 23 viewers despite all 26 artwork designs being ready, with a maximum main-thread frame gap of approximately two seconds.

   Revisited cards now display their retained rendered image. A deliberate pointer drag or relevant keyboard action restores the interactive model; capture-phase initialization lets that same first input reach the viewer. Artwork snapshots are unchanged. Variant changes, retry, resizing and pixel-density changes still refresh previews when needed.

2. **New models could finish in bursts.** First-time previews now run one per idle turn, with only one asynchronous provider initialization in flight. Wheel input marks activity immediately, before the scroll event, and cancels pending preview work. Work resumes after 350 ms without wheel/scroll activity. Pending offscreen models are disposed before they upload their completed textures. Suspension/disposal clears queued work and fences late completions.

3. **The cache could exceed six contexts.** When nine cards were partly visible, the previous exception retained nine live viewers. One preview became unavailable during testing. The gallery now uses six as a hard budget during normal interaction, retaining exact bitmaps for additional visible cards and avoiding eviction of a model currently being dragged. Native verification rendered all 26 cards successfully while retaining six viewers.

4. **Ordinary page scrolling had root-level non-passive wheel/touchmove handlers.** Those handlers required the browser to consult the main thread even without an overlay. Containment listeners now belong to the actual dialogs, menus and pickers. A root backdrop guard exists only while a modal is open; closing the final modal removes it. Mutation observers cover dynamic surfaces and role changes. Nested menus, edge containment, native internal scrolling, zoom gestures and touch cancellation retain their behavior. Removing the root listener alone did not eliminate model-construction stalls, so both changes were needed. [WebKit describes the relationship between wheel handlers and asynchronous scrolling](https://trac.webkit.org/wiki/WhatsChangingwithscrollingonmacOS).

5. **Small gallery previews used large model atlases.** The gallery now requests a 1024-pixel provider atlas, a maximum pixel ratio of 1.5 and a 300,000-pixel render budget. A 1024-square RGBA atlas has one sixteenth the base texture memory of a 4096-square atlas, before mipmaps/driver overhead. This changes preview raster resolution, not model UVs or print geometry. The editor and immutable print/export settings are unchanged.

## Native Safari verification

A separate, database-free fixture was tested in Safari on the same Mac, using native wheel events. The existing application tab and its cart were retained. Results below are local observations, not device/browser guarantees.

The final repeat test explicitly began with **26 ready designs and 26 rendered previews**:

| Observation | Final repeat pass |
| --- | ---: |
| Native wheel events / scroll updates | 8 / 8 |
| Model constructions / destructions | 0 / 0 |
| Maximum observed wheel event age | 2 ms |
| Maximum main-thread frame gap | 38 ms |
| Frame gaps over 50 ms | 0 |
| Ready designs / rendered previews at end | 26 / 26 |
| Live WebGL viewers | 6 |
| Root scroll-blocking listeners without a modal | 0 |
| Artwork snapshots byte-identical | Yes |

The first-load recording started with zero ready designs and captured its first wheel input while that count was still zero. All five recorded wheel events produced scroll updates; their maximum observed age was approximately 2 ms. All 26 previews eventually rendered and the live viewer count remained six. Startup still had main-thread rendering hitches: the maximum frame gap in the 800 ms windows following wheel input was 138 ms, with 11 gaps over 50 ms. The largest main-thread frame gap across the entire startup/idle recording was 823 ms. This does **not** establish perfect 60 fps during cold loading. In a separate small-wheel run, all 21 recorded wheel events produced scroll updates, with a 10 ms maximum event age. Main-thread rAF gaps do not directly measure Safari's independent compositor frame rate.

All **15 browser modal/popover checks pass in Safari**, including nested locks, releasing the last lock, background containment, native internal scrolling and preserving page position.

The 10 pt fill minimum, candidate selection and layout engine were not changed in this follow-up. The previous cold-load report's approximately 11-second full-gallery result remains a separate unresolved performance target.

## Verification and reproduction

The final focused run passes **68 tests** across `product-gallery.test.js`, `overlay-scroll.test.js` and `print-preview.test.js`. Eight additional focused tests pass across renderer lifecycle and provider atlas/UV checks, for **76 focused tests** in this follow-up. No full database-backed suite was run.

New regressions cover immediate wheel deferral, one model per idle turn, asynchronous provider serialization, pending offscreen disposal, cached reentry without rebuilding, first-drag/keyboard restoration, suspension/late completion fencing, a nine-visible-card viewport with a six-viewer cap, root listener cleanup and dynamic surface binding.

Run the existing database-free browser fixture with `node scripts/check-configurator-browser.js --gallery`. Open the emitted configurator URL with `view=products&probe=gallery-input`. The probe is injected before application scripts and records **trusted native wheel events**, frame timing, model creation/destruction, rendered-card counts, root blocking listeners and snapshot preservation. Use **Start native wheel recording**, scroll normally with pauses and direction changes, then **Finish native wheel recording**. Add `recordOnLoad=1` to start during initialization. `probe=scroll` checks modal/menu containment. The old performance probe is now explicitly labeled **scripted** scrolling.

Raw native AX reports and logs are in `/private/tmp/ww-scroll-2026-10-25/`, particularly `final-native-cold.ax.txt`, `final-native-repeat.ax.txt` and `final-focused.log`. No push or deployment was performed. Parallel gallery/thumbnail/overview work was preserved.
