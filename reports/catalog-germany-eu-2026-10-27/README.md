# Germany and EU catalog fulfillment audit 27 October 2026

**343 of 344 listed variants pass.** 1 listed variant fails the Germany/EU fulfillment criteria. All 26 product groups have at least one passing variant.

Live checks ran from **2026-10-27T16:27:20.960Z** to **2026-10-27T16:33:33.812Z**. The catalog fulfillment configuration was unchanged during the audit. No catalog, prices, application configuration or database records were changed; no orders, uploads or purchases were created.

## Exception

### Poster im Eichenrahmen — 61 × 91 cm · Eiche

- Product key: `framed-poster-11793`; Printful product **304**, variant **11793**.
- Active globally, but Germany availability is **not fulfillable** for the configured `digital` technique.
- Current provider stock regions: AU: in_stock.
- The shipping estimate returned HTTP 400 and rejected delivery to the Berlin address.
- Independent per-variant availability check agrees. The non-binding order-cost estimate returned HTTP 400 and explicitly says this variant ships only to **Australia and New Zealand**, rejecting the Berlin address.
- The older pinned fixture recorded `in stock` and departure `LV`. It is now stale for this variant.
- Recommendation: hide or remove this exact variant from the Germany/EU assortment. Keep the other verified variants in its group.

## Complete group coverage

Every offered size/color/device/finish combination was checked individually. EU dispatch below is the departure country returned for one item delivered to synthetic Berlin address 10115, with the catalog's configured placements, printing technique and product options.

| Product group | Printful product | Listed variants | Pass | EU dispatch for passing variants | Failing variant IDs |
| --- | ---: | ---: | ---: | --- | --- |
| White ceramic mugs | 19 | 3 | 3 | Spain (ES), Latvia (LV) | — |
| Cork-backed coaster | 611 | 1 | 1 | Latvia (LV) | — |
| Matte posters | 268 | 7 | 7 | Spain (ES), Latvia (LV) | — |
| Framed posters | 304 | 22 | 21 | Latvia (LV) | 11793 |
| All-over tote bags | 84 | 3 | 3 | Latvia (LV) | — |
| Throw blankets | 395 | 2 | 2 | Latvia (LV) | — |
| Decorative pillows | 83 | 5 | 5 | Latvia (LV) | — |
| Spiral notebook | 474 | 1 | 1 | Latvia (LV) | — |
| Colored-interior mugs | 403 | 11 | 11 | Spain (ES), Latvia (LV) | — |
| Mouse pad | 518 | 1 | 1 | Latvia (LV) | — |
| Laptop sleeves | 394 | 2 | 2 | Latvia (LV) | — |
| Standard canvases | 3 | 46 | 46 | Spain (ES) | — |
| Water bottles | 382 | 2 | 2 | Latvia (LV) | — |
| Straw tumblers | 585 | 2 | 2 | Latvia (LV) | — |
| Enamel mug | 407 | 1 | 1 | Spain (ES) | — |
| Travel mugs | 663 | 2 | 2 | Latvia (LV) | — |
| Wine tumbler | 632 | 1 | 1 | Latvia (LV) | — |
| Organic cotton tote bags | 367 | 2 | 2 | Spain (ES) | — |
| Tough iPhone cases | 601 | 58 | 58 | Italy (IT) | — |
| MagSafe iPhone cases | 798 | 36 | 36 | Italy (IT) | — |
| Tough Samsung cases | 686 | 46 | 46 | Italy (IT) | — |
| Framed canvases | 614 | 39 | 39 | Spain (ES) | — |
| Thin canvases | 616 | 13 | 13 | Spain (ES) | — |
| Organic cotton T-shirts | 456 | 18 | 18 | Spain (ES), Latvia (LV) | — |
| Organic cotton sweatshirts | 493 | 10 | 10 | Spain (ES), Latvia (LV) | — |
| Organic cotton hoodies | 479 | 10 | 10 | Spain (ES) | — |

Current dispatch totals: **Italy (IT): 140 variants**; **Latvia (LV): 58 variants**; **Spain (ES): 145 variants**. Every passing variant returned `customs_fees_possible: false`.

## Method and evidence

1. Took an inventory of the live workspace's shared `PRODUCTS` catalog: 344 distinct variant IDs across 26 Printful products and 26 gallery groups. Germany has 0 locally prohibited catalog variants.
2. Queried `GET /products/{id}` for active product/variant membership and explicit stock regions. Required an in-stock EU or EU_* region; UK stock alone does not qualify.
3. Queried the paginated `GET /v2/catalog-products/{id}/availability?selling_region_name=germany&techniques={technique}` feed, intersecting it with active variants. Required `in stock` for the exact configured technique. Orphan availability records were not treated as active catalog variants.
4. Requested a separate `POST /v2/shipping-rates` estimate for every catalog variant, quantity one, STANDARD/EUR, using the same placement/technique/product-option mapping as checkout. Validated exact shipment-item coverage with the existing application normalizer. Required every departure country to be an EU member and every customs flag to be false.
5. Independently reconfirmed the exception through the per-variant Germany availability endpoint and `POST /orders/estimate-costs`, which calculates costs without creating an order.

- [All 344 variant results (CSV)](variants.csv)
- [Compact summary and group results (JSON)](summary.json)
- [Full availability, stock, shipping request/response evidence and request timestamps (JSON)](audit.json)
- [Independent exception confirmation (JSON)](exception-11793-confirmation.json)
- [Catalog snapshot and configured fulfillment identities (JSON)](catalog-snapshot.json)

## Scope and recommendation

These results establish current availability and estimated EU dispatch for Germany. They do not guarantee future stock, routing, production location, every German postal address, larger quantities or mixed baskets. A shipping estimate is not an actual completed shipment. Printful itself says that selecting a selling region does not guarantee domestic fulfillment.

Keep the passing assortment. Hide the failing variant for Germany/EU sales, and refresh the pinned availability evidence when making that catalog change. If EU-only fulfillment is a firm business rule, add a separate checkout rule that rejects a non-EU or unknown departure estimate, rather than only showing a customs warning. The existing checkout refreshes shipping estimates, but the current code does not impose an EU-only departure requirement.

Provider documentation: [Printful v2 API](https://developers.printful.com/docs/v2-beta/) explains availability by technique/region and shipping departure/customs fields. [Printful selling-region preferences](https://help.printful.com/hc/en-us/articles/50263175954577-What-are-the-selling-region-preferences) explains the limits of regional selection.
