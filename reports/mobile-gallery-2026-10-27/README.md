# Mobile gallery investigation — 27 October 2026

The gallery had avoidable mobile CPU, download and GPU work. The changes below reduce that work substantially, while retaining the complete print artwork. They do **not** establish an instant or universally smooth mobile gallery.

## Changes

- Mobile prepares artwork only for the viewport and a viewport-height margin ahead/behind, rather than immediately preparing all 26 product groups. Prices, names and variant controls still appear for the whole catalog. IntersectionObserver-free browsers retain the eager fallback. Desktop preparation remains eager.
- Nearby mobile previews render before they enter the screen. Actual visibility remains separate, so preloading does not count as a product impression. Visible previews take priority over nearby previews. A three-viewer mobile WebGL budget replaces the six-viewer desktop budget; eviction retains the exact rendered bitmap.
- Touch/scroll activity pauses new mobile layout jobs. Running layouts cooperate at their next yield, with a 4 ms computation slice rather than 8 ms. New previews resume after 120 ms without scrolling on mobile; desktop keeps its existing 350 ms delay. This is a scheduling budget, not a hard maximum task duration: individual native operations and shader/model initialization can still exceed it.
- Editor entry pauses new catalog jobs but releases existing layout waiters, so the editor cannot deadlock when requesting a layout already shared with the gallery. Disposal also releases waiters. Leaving the preload margin cancels a pending model regardless of which intersection callback arrives first.
- Gallery source textures now also have a 1024-pixel edge limit; the provider atlas was already bounded separately. A formerly 2048-pixel source has approximately one quarter of its prior pixel area. Print dimensions, source coordinates, mesh geometry and editor/export resolution are unchanged.
- Viewer startup and thumbnail capture no longer submit duplicate first frames. Provider and procedural startup each render one complete initial frame.
- Fabric loads on the first actual editor entry. Merely browsing the gallery no longer downloads/parses its 299,013-byte script (92,265 bytes with local default gzip). Concurrent requests share the load; errors/timeouts permit retry. The editor library is still served from its pinned local npm package.

## Measurements and limits

Database-free local fixture, in-app Chromium on the development Mac, 390 × 844 viewport, iPhone device signals and hardwareConcurrency=4 (two numeric workers), 40 words from `marketing/clouds/classic-wedding.json`. New navigations reset the page's layout cache. These are individual observations, **not medians, mobile hardware measurements, cellular-network tests or production timings**. The fixture deliberately has no database, provider calls or production compression/cache policy. First-preview times below start at navigation, not first input.

| Scenario | Before | Final |
| --- | ---: | ---: |
| Stationary: first exact product preview | 1.269 s | 1.193 s |
| Stationary: artwork groups prepared after 10 s | 25 / 26 | 3 / 26 |
| Stationary: frames with a gap over 50 ms | 0 | 0 |
| Stationary: longest observed long task | none recorded | 51 ms |
| Jump run: first exact product preview | 1.098 s | 1.052 s |
| Jump to the unseen mouse pad at ~3 s: time until exact preview | 0.742 s | 0.884 s |
| Jump run: artwork groups prepared after 10 s | 26 / 26 | 7 / 26 |
| Jump run: longest observed long task | 114 ms | 99 ms |
| Jump run: largest rAF gap over 50 ms | 100 ms | 83.4 ms |
| Fabric requested while browsing | yes | no |
| Configured maximum live 3D viewers on mobile | 6 | 3 |

The strongest demonstrated benefit is avoiding roughly 88% of initial product-group preparation for a stationary visitor, alongside lower texture/context budgets and one fewer large script download. These captures show only a modest first-preview improvement. The unseen-product jump was slower in this pair; there is no evidence here of a faster cold jump. Nearby preloading helps sequential browsing, but a far-away product still needs its own artwork and model.

The final jump still contains one approximately 99 ms main-thread task and an 83 ms rAF gap. Their timing coincides with first-time nearby rendering; attributing the exact cost requires a device CPU/GPU trace. Scripted jumps and desktop rAF measurements do not prove smooth native iPhone touch scrolling. Production cold starts, cellular latency and physical Safari/Android behavior remain unmeasured.

Raw captures are `before-stationary.json`, `before-jump.json`, `final-stationary.json` and `final-jump.json` in this folder. SHA-256 hashes of every prepared final artwork match the corresponding baseline product, including the mouse pad and laptop sleeve.

## Correctness and checks

The mobile browser handoff probe passes all six checks: opening the existing fullscreen editor, exact artwork handoff, returning to the gallery, exact returned artwork, explicit cart acceptance and exact artwork in the accepted fixture configuration. The gallery requested no Fabric script before editor entry and exactly one afterward. See `handoff.json`.

252 distinct focused checks pass across gallery behavior, the layout client, asynchronous/synchronous layout parity (including the mobile slice budget), responsive UI, lazy runtime loading/retry, configurator restoration/loading and selected renderer lifecycle/framing tests. Renderer checks include every 3D variant, both print sides, all-product full-turn framing, stale completion/disposal, and one first render. Two early whole-renderer-file attempts were interrupted during its long framing matrix; the relevant lifecycle and framing selections were subsequently run to completion. No full application suite was run. `git diff --check` passes.

The existing analytics changes were preserved. Extracted-page unit-test harnesses received no-op analytics dependencies so restoration/loading checks exercise the current template; those stubs do not change application analytics.

## Reproduce and next target

Run `node scripts/check-configurator-browser.js --gallery`, set a phone-sized browser viewport, and append `&view=products&probe=mobile-performance` to its emitted URL. Add `&jump=1` for the timed jump. After ten seconds, `#mobile-gallery-performance-report` contains the JSON capture. The **Check mobile gallery handoff** button exercises the real editor, browser-local draft and in-memory cart/configuration fixture. All instrumentation remains fixture-only.

The next performance investigation should trace a cold gallery and native flings on physical iPhone Safari and Android. Further substantial latency gains need reuse of completed personalized layouts/previews, or a lightweight initial personalized preview with interactive 3D created on demand. The current exact, previously unseen artwork still has a real computation cost; changing its search quality or print metrics was outside this change.

No push, deployment, hosted database write, payment or provider operation was performed.
