# Intermittent black white-mug preview — investigation, 2026-10-26

The screenshot is consistent with the mug's diffuse texture background becoming
black or transparent while the colored print remains intact. The current code
contains resource-pressure risks and cannot detect that particular failure.
The underlying iPhone trigger is **not confirmed**: normal rendering, repeated
viewer creation and shipping-page return navigation passed in desktop browser
engines. A separate allocation-failure cleanup bug was reproduced. No application
source was changed by this investigation.

## Reported behavior and scope

- Product label: white mug, 325 ml; palette: Confetti.
- The body, rim and handle are black, with specular highlights and colored words.
- Reported on approximately iPhone 12 and iPhone 14/15; exact iOS versions unknown.
- Possibly occurs on entering the design page or returning from shipping.
- Investigated the current working checkout. The exact commit served when the
  supplied screenshot was taken is unknown.

## Evidence in the code

### 1. This model maps one generated canvas over the entire mug

`src/productPreviewModels.json` selects `mug-325` for the white 325 ml mug. Its
GLB has one `MeshStandardMaterial`, metallic factor 0 and no embedded texture.
`public/js/printful-product-model.js:209` assigns the generated atlas to that
material and explicitly sets its color to white. This includes the handle.

`paintAtlas()` at `public/js/printful-product-model.js:95` clears the canvas,
fills the entire atlas white, and draws the artwork into its UV cell. The white
mug has no accent cell, base photograph or legitimate black product-color
setting. I found no normal product-selection branch that requests the appearance
in the screenshot.

The material is opaque. Transparent black texels can therefore produce black
ceramic instead of making the mug invisible. Specular highlights still render,
and colored text pixels can retain their colors.

**Controlled visual experiment:** suppressing only the atlas's white background
fill, without changing the model, material color, lights or words, produces the
same visual pattern: black body, rim and handle, with colored lettering.
See [normal WebKit rendering](webkit-normal.png) and
[injected missing-background rendering](webkit-lost-white-fill.png).
This is an intentionally injected fault, **not a natural reproduction of the
iPhone defect**. It identifies a compatible rendering mechanism, not why the
background would be lost on the phone. Black RGB corruption could look similar.

### 2. Entering the editor increases this atlas from 4 MiB to 64 MiB

`atlasSizeFor()` at `public/js/printful-product-model.js:12` gives `mug-325`
a square atlas up to 4096 × 4096, even though its artwork occupies one quarter.
The editor at `views/configure.ejs:4657` does not override this limit. The
browser probe confirmed an actual 4096 × 4096 atlas.

- RGBA8 bitmap equivalent: **64 MiB** for the atlas alone.
- GPU RGBA8 texture with a full mip chain: approximately **85.3 MiB**.
- These figures describe pixel storage, not measured process memory. Driver
  staging, canvas backing stores and other preview/editor resources add further
  costs; physical allocation and sharing are browser-dependent.

The gallery explicitly limits its atlas to 1024 at
`views/configure.ejs:5955`: 4 MiB of RGBA8 pixels. Opening the same mug in the
editor therefore increases atlas pixel count **16-fold**. Cart thumbnails and
the shared enlarged preview use `render3D()` at
`public/js/cart-product-preview.js:66`, which also leaves the atlas at its full
default size, including when creating a small thumbnail.

`MAX_TEXTURE_SIZE` is a dimension capability, not an available-memory budget.
This asymmetry is a credible contributor to an intermittent mobile-only issue,
especially around navigation and several cart previews. It is not proof of
memory exhaustion in this incident.

### 3. Disposal releases WebGL resources but leaves canvas storage to the browser

`public/js/printful-product-model.js:260` disposes the model and texture but
does not zero the atlas canvas dimensions. `public/js/mug-3d-viewer.js:659`
also disposes textures/renderer and removes its display canvas without zeroing
its internally owned front/back/studio canvas dimensions.

This is not evidence of a permanent JavaScript memory leak. It means reclamation
of those canvas backing stores depends on browser lifetime/garbage collection,
which can leave transient overlap during repeated viewer creation or navigation.
Explicitly releasing owned backing stores is a reasonable mobile hardening step.

### 4. A bad texture can still be reported as ready

At `public/js/mug-3d-viewer.js:720`, rendering is followed by an
`isContextLost()` check and a ready status. No atlas pixel/opacity health check
or rendered-output check occurs. Only the display canvas has WebGL loss/restore
listeners; the 2D source canvases have no equivalent recovery handling.

The injected black-mug experiment completed with a live WebGL context and
`gl.getError() === 0` in both browser engines. This confirms that current ready
checks cannot detect that particular corrupted-content condition. It does not
mean all possible texture-upload failures would escape detection.

The loader catch at `public/js/mug-3d-viewer.js:725` discards its error, and the
texture-update catch at `views/configure.ejs:4632` also drops its error detail.
That limits retrospective diagnosis of a real device failure.

### 5. Shipping return already has a restoration path

`views/configure.ejs:5845` destroys the viewer on `pagehide`.
`views/configure.ejs:5865` handles a persisted `pageshow` by reloading an
initialized workspace so the local draft/cart snapshot and viewer can be rebuilt.
There is no obvious missing Back-navigation handler in the current code.

### 6. Confirmed cleanup bug when the initial 2D canvas allocation fails

The viewer creates its WebGL renderer and attaches its display canvas before
calling `textureCanvas.getContext('2d')` at
`public/js/mug-3d-viewer.js:92`. If that returns null, setting `fillStyle`
throws immediately. The cleanup-protected initialization block does not begin
until line 695, so this early failure never reaches `destroy()`.

A focused failure-injection check using the existing lifecycle fixture confirmed:

```json
{
  "error": "Cannot set properties of null (setting 'fillStyle')",
  "rendererDisposed": false,
  "contextReleased": false,
  "displayCanvasRemoved": false
}
```

This is a reproducible error-path resource leak. It could compound resource
pressure when initialization is retried. It does not directly reproduce black
ceramic with surviving words: the injected failure stops that viewer's creation.
The existing failed-initial-texture test throws later from the artwork drawer,
inside the protected block, so it does not cover this earlier failure.

## Checks performed

All browser checks used local fixtures, with no application database or provider
credentials. WebKit here is a desktop engine with mobile viewport/identity, not
the iPhone GPU, iOS memory limits or an actual iOS Safari process.

| Check | Result |
| --- | --- |
| Normal 325 ml mug, desktop Chromium and WebKit | White; atlas background RGBA 255/255/255/255; no GL errors |
| Deliberately suppress atlas white fill | Black mug including handle; lettering preserved; no GL errors |
| Forced WebGL context loss and restoration, both engines | Restored white rendering |
| 12 destroy/recreate cycles per engine | All 24 loaded atlases retained white backgrounds; no GL errors in those new viewers |
| Actual configurator → shipping → browser Back, WebKit, five round trips | Design retained; white rendering and no page errors on every return |
| Initial 2D texture context returns null, lifecycle fixture | Throws before cleanup; renderer/context/display canvas remain unreleased |
| `npm test -- test/mug-3d-lifecycle.test.js test/printful-product-model.test.js` | All 32 tests passed using the repository's disposable local Postgres runner |

The return-navigation probe read the rendered framebuffer: approximately 97.6%
of opaque mug pixels were bright, with no dark pixels, consistently across all
six captures. See [navigation measurements](navigation-results.json) and
[viewer probe output](viewer-results.jsonl).

After forced WebGL restoration, destroying that restored viewer emitted
`INVALID_OPERATION: delete: object does not belong to this context` warnings
in both engines. Rendering recovered and subsequent viewers were white. This
is a separate observed cleanup concern; it is not established as the cause of
the supplied screenshot. The isolated Chromium probe also requested a missing
favicon (404), unrelated to the model.

## Recommended next implementation

1. Bound mobile editor atlas memory and use smaller atlas limits for small cart
   thumbnails. Choose limits based on screen requirements while preserving the
   existing UVs and all fulfillment artwork.
2. Zero internally owned canvas dimensions on disposal, including failure and
   asynchronous-load cancellation paths. Put initial allocations inside the
   cleanup guard and explicitly handle null 2D contexts. Do not resize externally
   owned canvases.
3. Detect a missing opaque background at a known unprinted atlas location;
   perform a bounded repaint/recreation and show the existing retry state if it
   remains invalid. A CPU pixel check alone cannot detect every GPU-only error.
4. Preserve useful error details and capture bounded diagnostics: product/model,
   atlas dimensions, page lifecycle, WebGL loss events and texture health. Avoid
   logging customer artwork or personal data.
5. Retest design entry and repeated shipping/cart returns on an affected physical
   iPhone, including Safari background/foreground transitions. Confirm the exact
   iOS and served asset versions before attributing this to an upstream bug.

The strongest working hypothesis is an intermittent canvas/texture failure,
with preview memory pressure a plausible contributor. These changes would harden
the relevant code, but should not be described as a confirmed root-cause fix until
the real-device condition is captured or eliminated by a controlled comparison.

## Upstream context

WebKit has historical reports of
[canvas-to-texture transfers returning transparent black](https://bugs.webkit.org/show_bug.cgi?id=207128),
[large/multiple textures causing iOS crashes](https://bugs.webkit.org/show_bug.cgi?id=241478),
and [delayed canvas reclamation exhausting the canvas budget](https://bugs.webkit.org/show_bug.cgi?id=195325).
Those reports concern particular older OS versions; the canvas reclamation
report is marked resolved/fixed. They establish precedent for these failure
classes, not that the same upstream bug is present on the reported phones.
