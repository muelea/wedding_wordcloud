# Journey and font acceptance — 2 September 2026

Status: the corrected **local Linux candidate passes the checks below**.
No deployment or source-control push was performed. This is not a guarantee
that every possible input/device/provider failure has been tested.

## Candidate and isolation

- Source baseline: `6d08d873311547322fad60f2ea036b1473bc01e4`, plus this working-tree change.
- Local image: `wolkenworte:journey-candidate`.
- Image SHA-256: `b3e9c3650e5bfe9a43a9f928b842d6cd6a3d339536d6a28ed8ee9368478caf8b`.
- Linux AMD64, Node 22.23.2, repository Dockerfile; real pages, editor, routes,
  print validation, migrations and Postgres transactions.
- Disposable Postgres and restricted `wolkenworte_app` runtime role. No hosted
  database, real provider credentials or persistent Docker volumes.
- Real Chromium in-app browser and actual macOS Safari in a separate test
  window. The user's existing live Safari page was not changed.
- Price provider and Stripe SDK transport simulated. The actual Stripe adapter
  generates metadata, amounts, locale, expiry and return URLs. Signed payment
  events traverse the real webhook verifier and transactional payment handling.
- Fulfillment and email use mocks; external Printful order-write counter: zero.

## Root cause and fixes

The unmodified production image reproduced the user's exact default-font case:
`test` plus red heart → configurator → empty-cart shipping confirmation → save
error. The response was `invalid_design`, not a failed cart/session write.

The previous Classic file was the **latin-ext-only Gelasio WOFF**, whose glyph
table omitted ordinary letters such as `test`. Different OS fallbacks produced
different text widths, causing Linux to reject a design positioned by the Mac.
The strict print-boundary validation was correct and remains unchanged.

With explicit maintainer permission, Classic now uses a full local Gelasio TTF
on browser and server. Source commit, SHA-256 and SIL OFL license are tracked
beside the font. The legacy npm font route remains for already-cached clients.
The tradeoff is a larger complete file (168,556 bytes) and explicit font updates,
not a new CDN, startup dependency, service or draft-storage architecture.

Additional fixes found during acceptance:

- Font loading rejects missing faces, network failures and timeouts rather than
  accepting a system fallback. Save waits for an in-flight font choice. A slow
  earlier choice cannot replace a newer one or recreate deleted/restored text.
- Shipping requests have a deadline covering headers **and response body**.
  Failures restore controls; duplicate clicks cannot start concurrent requests.
- Editing a shipping address invalidates an in-flight old price; checkout locks
  the address it is confirming. Page exit aborts/fences stale responses.
- A cancelled checkout's old quote cannot overwrite a newer address or quantity
  draft on reload. This was reproduced in the browser before fixing it.
- The product geometry regression loop no longer silently skips products with
  no orientation options, notably mugs.

## Automated evidence

- Full `npm test`: **263 passed, 0 failed/skipped/cancelled**, 113.9 seconds.
- Focused final-image Linux font/editor/shipping tests: **24 passed, 0 failed**.
- All five font files contain basic Latin and the letters/punctuation used by
  the six supported locales. Canvas glyph advances agree with independent
  reads of the actual font tables on both Mac and Linux.
- **7,580 designs**: 3,790 real Fabric outputs plus their reopened forms, covering
  all 12 products/16 product-orientation combinations and all five fonts.
  Includes 15 text/emoji cases, three angles, enlargement to print boundaries,
  every product layout action and reconstruction of serialized designs.
- The exact 7,580 serialized outputs captured on macOS also pass the production
  print validator in the final Linux candidate: **zero cross-platform failures**.
- Boundary reconstruction permits up to two print pixels of Fabric/decimal
  clamping, but requires unchanged content, font, colour and angle. Both original
  and reopened geometry must satisfy the unmodified server safety margin.
- Regression tests cover font-download ordering/failure/deletion; save waiting
  for fonts; address/price races; double submits; failed JSON; hanging response
  bodies; checkout timeout/retry; stale page-exit responses; failed navigation;
  newer address/quantity drafts versus cancelled-checkout quotes.
- Existing tests additionally cover cart storage denial/corruption/full limits,
  event/tab isolation, expired events/quotes, immutable approved output, guest
  ownership, payment idempotency and leased fulfillment/email work. These are
  automated state/integration checks, not claims of manual testing in every UI.

## Real-browser results

| Font | Chromium save/reopen | Safari edit/save/reopen | Compact font sheet |
| --- | --- | --- | --- |
| Klassisch / Gelasio | Pass | Pass | Pass |
| Lora | Pass | Pass | Pass |
| Montserrat | Pass | Pass | Pass |
| Caveat | Pass | Pass | Pass |
| Baloo 2 | Pass | Pass | Pass |

The four non-default Chromium save/reopen cases used the first corrected-font
candidate. Safari repeated all five on the final image, including the new font
loading guards. The final image also passed the Chromium original default-font
flow and all compact-sheet font choices. No silent font substitution was used.

Final-candidate journeys that passed:

- Original word plus heart → explicit empty-cart confirmation → shipping in both
  Chromium and Safari. No order was created merely by saving the configuration.
- Shipping → back to design restores the interactive editor and 3D mug; select
  all, font changes, resize, rotation, repeated save and reload remain usable.
- Each edit replaces the one cart position rather than adding duplicate items.
- Safari logo navigation from a saved design reaches Home without saving again.
  A new cloud word appears in the fresh design (three elements); the explicit
  saved-cart link reopens the approved two-element design unchanged.
- Home navigation from the fresh dirty design offers save/discard/cancel.
  Cancelling keeps the editor; explicit discard leaves the saved cart unchanged.
- Cancelled checkout restores its unchanged address, quantity and quote.
  Editing Berlin to Hamburg and reloading retains Hamburg and asks for a new
  price, instead of silently restoring Berlin and its old quote.
- Provider pricing failure recovers with a retry; an eight-second delayed price
  is ignored after the address changes; a response exceeding the browser
  deadline shows an error and re-enables the form. Normal retry then succeeds.
- A payment response delayed beyond the deadline recovers without navigation.
  Retrying reuses the existing checkout session; it does not create a duplicate.
- Simulated payment reaches the real completed-order page. Repeating the same
  signed event leaves one `paid_test` order, one mocked fulfillment and one
  delivered mock confirmation email. Earlier abandoned checkout attempts remain
  `checkout_pending`, not paid orders or production orders.
- Browser Back to shipping after payment refuses reuse of the purchased cart.
- A separate mixed cart (mug and poster) splits products across two addresses,
  computes a combined quote and enters/cancels checkout successfully. Both
  addresses also survive shipping → design → shipping afterward.
- At a 390-pixel viewport (375-pixel content area with scrollbar), the real
  compact font dialog displays all five choices; selecting each updates its
  selected state. The poster saves and the two-product cart reaches shipping.

## Limits and remaining release checks

- Actual iPhone/Android touch, virtual keyboards, Windows, older browser
  versions, browser storage denial and uploaded photos were **not all manually
  exercised in this run**. They must not be represented as universally verified.
  Compact viewport testing is not a substitute for an actual mobile device.
- Full glyph coverage beyond the application's supported Latin locales is not
  claimed. Emoji use the existing pinned artwork pipeline, not font glyphs.
- Existing Three.js legacy-build deprecation warnings remain. Chromium recorded
  `AbortError: Transition was skipped` on synthetic checkout fixture navigation;
  the payment journey completed. This is not a clean-console certification.
- The conservative dirty flag may still ask to save after rotate then Undo,
  even when the design visually matches the saved version. No data loss observed.
- Real external Stripe/Printful/Resend integration and a hosted smoke after an
  approved deployment remain separate guarded checks. No real charge, live
  fulfillment order or provider email was submitted by this acceptance run.

Reproduction commands and the isolated runner are documented in README's
“Cart and navigation acceptance” section. Do not deploy solely because unit
tests passed; preserve these real-browser and cross-OS checks for future changes.
