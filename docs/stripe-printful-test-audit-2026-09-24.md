# Prüfung der neun Stripe-/Printful-Testkäufe vom 24.09.2026

**Aktueller Entscheidungsstand (24.09.2026):** Die Steuerkonfiguration ist für
den ersten Start vom Betreiber akzeptiert und vorerst abgeschlossen: nativer
Stripe Checkout mit DE `oss_union` als Berechnungseinstellung und zusätzlichem
GB `standard`. Abschnitt 7 dokumentiert den erfolgreichen GB-Nachtest. Die
Erweiterung um den tatsächlichen Versandursprung wird für den Start
zurückgestellt; die unten beschriebenen Grenzen bleiben bestehen. Der
verbindliche Projektstand einschließlich der noch offenen Go-live-Punkte steht
in [launch-readiness.md](launch-readiness.md). Es wurde kein Livebetrieb aktiviert.

Die Zahlungs- und Datenverarbeitung besteht den Abgleich bei allen neun Bestellungen (32–40). 225 einzelne Datenprüfungen bestanden. Bei der Steuerklassifizierung außerhalb der EU besteht eine wesentliche Lücke: Stripe meldet deutsche VAT mit 0 % und dem Grund `zero_rated`; der tatsächliche Printful-Versandursprung wird nicht an Stripe Checkout übergeben. Das bestätigt keine US-Nexus-Behandlung und keine korrekte lokale UK-Versteuerung.

Datenerhebung: 2026-09-24T18:07:10.256Z. Käufe: 24.09.2026, 17:49–18:02 UTC. Ausschließlich lesender Zugriff auf die Projekt-Datenbank, Stripe-Sandbox und die neun Bestellstatus-Endpunkte. Keine Einstellungen, Zahlungen, E-Mails oder Printful-Produktionsaufträge ausgelöst.

Alle neun Käufe: eine weiße 11-oz-Tasse, Printful-Variante 1320, identischer gespeicherter Entwurf, eine Lieferadresse und ein Versandpaket, Währung EUR.

## 1. Printful-Angebote

Die folgenden Beträge stammen aus den unveränderlich an den Bestellungen gespeicherten, normalisierten Printful-Kostenschätzungen und Versandangeboten. Sie sind keine endgültigen Printful-Rechnungen. Versandursprung ist der Wert aus dem Versandangebot, kein Beleg einer tatsächlichen Produktion. Alle Beträge in EUR.

| Bestellung / Ziel | Versand ab | Ware vor tax/vat | Versand | tax | vat | Printful gesamt | Einfuhrgebühren möglich |
|---|---|---:|---:|---:|---:|---:|---|
| 32 Deutschland | LV | 5,60 | 4,69 | 0,00 | 0,00 | 10,29 | Nein |
| 33 Frankreich | LV | 5,60 | 4,69 | 0,00 | 0,00 | 10,29 | Nein |
| 34 Lettland | LV | 5,60 | 4,69 | 0,00 | 2,16 | 12,45 | Nein |
| 35 Spanien | ES | 5,60 | 4,69 | 0,00 | 2,16 | 12,45 | Nein |
| 36 England | GB | 5,95 | 4,89 | 0,00 | 2,17 | 13,01 | Nein |
| 37 Schweiz | ES | 5,60 | 9,29 | 1,20 | 0,00 | 16,09 | Ja |
| 38 USA / Kalifornien | US | 5,25 | 5,99 | 0,50 | 0,00 | 11,74 | Nein |
| 39 USA / New York | US | 5,25 | 5,99 | 1,00 | 0,00 | 12,24 | Nein |
| 40 USA / North Carolina | US | 5,25 | 5,99 | 0,92 | 0,00 | 12,16 | Nein |

Printful weist für Inlandslieferungen nach Lettland und Spanien jeweils 2,16 EUR VAT aus, für Großbritannien 2,17 EUR VAT. Für die Schweiz stehen 1,20 EUR im Feld `tax`; die genaue rechtliche Art dieser Abgabe ist im gespeicherten Angebot nicht erläutert. In den USA variiert `tax` zwischen 0,50 EUR (CA), 1,00 EUR (NY) und 0,92 EUR (NC).

## 2. Unsere Berechnung und Stripe-Ergebnis

Bestehende Preisregel, für alle neun Käufe centgenau reproduziert: Produktkosten vor Printful tax/vat × 1,50 (auf volle Cent aufgerundet), plus Printful tax/vat ohne Aufschlag, plus Gebührenreserve. Versand wird mit dem Printful-Betrag separat weitergegeben. Die Printful-Steuer wird genau einmal als Einkaufskosten berücksichtigt; die Endkundensteuer kommt anschließend von Stripe.

| Bestellung / Ziel | Warenbetrag netto inkl. Reserve | Davon Gebührenreserve | Versand netto | Stripe-Satz | Stripe-Steuer Ware + Versand | Endbetrag |
|---|---:|---:|---:|---:|---:|---:|
| 32 Deutschland | 9,27 | 0,87 | 4,69 | 19 % | 2,65 | 16,61 |
| 33 Frankreich | 9,27 | 0,87 | 4,69 | 20 % | 2,79 | 16,75 |
| 34 Lettland | 11,52 | 0,96 | 4,69 | 21 % | 3,40 | 19,61 |
| 35 Spanien | 11,52 | 0,96 | 4,69 | 21 % | 3,40 | 19,61 |
| 36 England | 12,10 | 1,00 | 4,89 | 0 % | 0,00 | 16,99 |
| 37 Schweiz | 10,73 | 1,13 | 9,29 | 0 % | 0,00 | 20,02 |
| 38 USA / Kalifornien | 9,30 | 0,92 | 5,99 | 0 % | 0,00 | 15,29 |
| 39 USA / New York | 9,83 | 0,95 | 5,99 | 0 % | 0,00 | 15,82 |
| 40 USA / North Carolina | 9,74 | 0,94 | 5,99 | 0 % | 0,00 | 15,73 |

Die Gebührenreserve basiert auf 3,65 % + 0,25 EUR und einer internen pauschalen Steuerannahme von 20 %. Diese Annahme beeinflusst den Nettopreis auch bei steuerfreien Stripe-Ergebnissen, nicht jedoch die von Stripe ausgewiesene Kundensteuer. Die im Sandbox-Zahlungsobjekt ausgewiesenen Zahlungsgebühren liegen bei allen neun Käufen unter der Reserve; daraus folgt keine Zusage über sämtliche Gebühren oder spätere Live-Kosten.

Rechenbeispiel Lettland: 5,60 × 1,50 + 2,16 + 0,96 = 11,52 EUR Warenbetrag; plus 4,69 EUR Versand = 16,21 EUR netto; plus 3,40 EUR Stripe-Steuer = 19,61 EUR. Produkt- und Versandsteuer werden jeweils gerundet.

## 3. Tatsächlich bei Stripe angekommen

- Sämtliche Lieferadressen einschließlich Land, Postleitzahl und US-Bundesstaat stimmen zwischen gespeichertem Printful-Empfänger, Checkout-Anfrage und Stripe-Customer überein.
- Nettowarenbetrag und Versand centgenau übernommen; `automatic_tax.enabled=true`, Ergebnis jeweils `complete`.
- Waren-Steuercode `txcd_99999999`; Versand-Steuercode `txcd_92010001`; beide `exclusive`.
- Zum Prüfzeitpunkt genau eine aktive Sandbox-Steuerregistrierung: Deutschland, `oss_union`. Keine aktive US-, UK- oder CH-Registrierung. Stripe Tax verwendet Deutschland als Hauptsitz.
- DE/FR/LV/ES: `standard_rated` mit 19/20/21/21 %.
- GB/CH/US: jeweils `country=DE`, `tax_type=vat`, `percentage=0`, `taxability_reason=zero_rated`. Es steht dort nicht `not_collecting` wegen fehlender Zielregistrierung.
- Bei allen neun Käufen `invoice_creation.enabled=false` und `invoice=null`: keine von Stripe erstellte Rechnung; die Bestellbestätigung kommt aus unserer Anwendung.

## 4. Wesentliche Befunde und Grenzen

**Versandursprung fehlt in der Stripe-Steuerberechnung.** Unsere Checkout-Anfrage übermittelt den Empfänger und die Beträge, aber keinen Printful-Versandursprung. Stripe dokumentiert den Hauptsitz als Standardursprung. Für GB → GB und US → US bildet die von Stripe ausgewiesene deutsche Nullbesteuerung damit nicht die tatsächliche lokale Versandkonstellation ab. Dass die Endbeträge numerisch den erwarteten Nullsteuerbeträgen entsprechen, belegt nicht die richtige steuerliche Einordnung. Für EU-Inlandsfälle LV → LV und ES → ES liefert Stripe hier zwar den passenden nominalen Landessatz, kennt aber ebenfalls den tatsächlichen lokalen Versandweg nicht.

[Stripe: Versandursprung und unterstützte Integrationen](https://docs.stripe.com/tax/ship-from-address), [Stripe: Gründe für Nullsteuer](https://docs.stripe.com/tax/zero-tax). Die Dokumentation nennt die eigenständige Tax API als reguläre Integration für `ship_from_details`; für native Integrationen wie Checkout wird eine Preview angeboten. Eine Umstellung wurde nicht vorgenommen.

**USA/Nexus ist mit diesen Käufen nicht bewiesen.** Die drei Käufe testen US-Empfänger und unterschiedliche Printful-Steuern; sie testen keinen Schwellenübertritt, keine US-Steuerregistrierung und keine bundesstaatliche Steuerberechnung auf den Verkaufspreis.

**Charlotte-Adresse weicht ab.** Gespeichert und unverändert an Stripe übertragen wurde `1025 Westlake Dr, Charlotte, NC 28273`. Vorgeschlagen war `11025 Westlake Dr`. Der Test für NC und Postleitzahl 28273 fand statt, aber nicht mit der exakt genannten Hausnummer. Printful liefert nur Versandland US; ob aus Charlotte produziert würde, ist daraus nicht feststellbar.

**Schweiz:** Printful meldet Versand ab Spanien und mögliche Einfuhrgebühren; der entsprechende spezifische Hinweis ist in der gespeicherten Bestätigung enthalten. Die 1,20 EUR aus dem Printful-Feld `tax` fließen zusätzlich als Einkaufskosten in unseren Warenpreis ein. Daraus folgt nicht, dass alle möglichen Einfuhrabgaben bereits bezahlt sind.

**Zahlung und Bestätigung bestehen den Abgleich.** Alle neun Checkout Sessions vollständig und bezahlt; PaymentIntent erfolgreich, Betrag und Verknüpfung passend; je eine gespeicherte Checkout-Webhook-Verarbeitung, keine ausstehenden Stripe-Webhook-Zustellungen. Datenbank, Stripe und Bestellstatus-API stimmen überein. Alle neun Status-Endpunkte antworten HTTP 200.

**E-Mails:** Je genau ein Bestellbestätigungsjob, je ein Sendeversuch, alle vom Provider als `delivered` gemeldet. Warenbetrag, Versand, Steuer und Endsumme stimmen in gespeichertem Text und HTML mit Stripe überein. DE und FR wurden mit englischer Checkout-Sprache abgeschlossen, die übrigen sieben mit deutscher; die Bestätigungen entsprechen dieser Sprachwahl. Providerzustellung bedeutet nicht, dass der Empfänger die E-Mail gelesen hat.

**Produktion war absichtlich simuliert.** Alle neun Bestellungen und Lieferungen sind `mocked`, mit `MOCK-WC-…`-IDs. Keine echten Printful-Produktionsaufträge und keine Druckdatei-Artefakte für diese Testkäufe. Geprüft wurden die gespeicherten Angebotsantworten, die Verarbeitung und die Sandbox-Zahlung; finale Herstellerrechnungen, physischer Versand und reale Einfuhrabfertigung waren nicht Bestandteil dieses Tests.

**Befund zum ursprünglichen Prüfzeitpunkt:** Die Nullsteuer-Ergebnisse bestätigen keine korrekte lokale UK-/US-Behandlung. Der GB-Nachtest in Abschnitt 7 ergänzt diesen Stand; die Versandursprung-Erweiterung wurde anschließend vom Betreiber für den ersten Start zurückgestellt. Es wurden keine Rechtsannahmen allein aus dem eingeschalteten OSS-Modus abgeleitet.

## 5. Anschlussprüfung: Versandursprung, 24.09.2026

Auf Wunsch des Nutzers wurden die öffentliche Dokumentation und unsere Integration geprüft sowie ein neues Printful-Versandangebot und vier isolierte Stripe-Sandbox-Steuerberechnungen abgerufen. Keine neuen Zahlungen, Checkout Sessions, Printful-Aufträge oder verbuchten Steuertransaktionen wurden erzeugt. Registrierungen und Anwendungscode blieben unverändert.

### Stripe: reguläre API funktioniert, Checkout-Preview offen

Die öffentliche Stripe-Dokumentation bietet eine Anmeldung für die Preview `tax_ship_from_native_integrations_preview`. Sie dokumentiert keine allgemein verfügbare Übergabe für unseren bisherigen Checkout. Im installierten Stripe-SDK ist `ship_from_details` bei der Tax Calculation vorhanden, nicht bei Checkout Session Create. Aus diesen Befunden lässt sich keine kontospezifische Preview-Freischaltung nachweisen. Es wurde keine Preview-Anmeldung oder Supportnachricht versendet; Zugang, Parameter und API-Version für Checkout muss Stripe bestätigen.

Mit unserem vorhandenen Sandbox-Schlüssel wurden dagegen drei Berechnungen über `stripe.tax.calculations.create` erfolgreich durchgeführt; ein vierter Test bestätigte die erforderliche US-Ursprungs-PLZ. Verwendet wurden die unveränderten Nettobeträge, Lieferadressen und Steuercodes der ursprünglichen Käufe, ergänzt um das Versandland aus Printful.

| Ausgangskauf | Übergebener Ursprung → Ziel | Ergebnis der separaten Tax API |
|---|---|---|
| 33 | LV → FR | 2,79 EUR VAT, Frankreich, 20 %, `standard_rated`; Endbetrag 16,75 EUR |
| 34 | LV → LV | 3,40 EUR VAT, Lettland, 21 %, `standard_rated`; Endbetrag 19,61 EUR |
| 36 | GB → GB | 0,00 EUR VAT, Großbritannien, `not_collecting`; Endbetrag 16,99 EUR |
| 40 | US → US, ohne Ursprungs-PLZ | Validierungsfehler für `ship_from_details[address][postal_code]` |

Das britische Ergebnis belegt den Unterschied zur ursprünglichen Checkout-Berechnung: gleicher Endbetrag, aber jetzt britische VAT mit `not_collecting` statt deutscher VAT mit `zero_rated`. Die lettische Inlandsberechnung ergibt mit der bestehenden Stripe-Konfiguration weiterhin 21 %; aus diesem numerischen Ergebnis wird keine rechtliche OSS-Berechtigung abgeleitet.

### Printful: vollständige Angebotsantwort enthält keine Ursprungs-PLZ

Das neue Angebot wurde für Variante 1320, Menge 1 und die korrigierte Adresse `11025 Westlake Dr, Charlotte, NC 28273` abgerufen. Die unverarbeitete Antwort von `POST /v2/shipping-rates` enthält im Shipment ausschließlich `departure_country`, `shipment_items` und `customs_fees_possible`. Für STANDARD: 5,99 EUR Versand, Ursprung `US`, Einfuhrgebühren-Flag `false`. Es fehlt also kein Ursprungsfeld allein durch unsere Normalisierung; die Antwort selbst enthält weder Werk-ID noch Absenderstaat noch Absender-PLZ.

Auch die öffentliche [Printful-V2-Dokumentation](https://developers.printful.com/docs/v2-beta/) beschreibt beim Versandangebot nur das Herkunftsland. Der spätere Shipment-Endpunkt dokumentiert zusätzlich einen Herkunftsbundesstaat in `departure_address`, aber keine Ursprungs-PLZ und keinen verlässlichen Weg, diese vor dem Checkout zu erhalten. Es wurde keine Produktion ausgelöst, um spätere Versanddaten zu erzwingen.

Laut [Printful zur Standortauswahl](https://help.printful.com/hc/en-us/articles/50265294440209-Can-I-choose-where-my-products-are-fulfilled) wird der konkrete Standort bei der Auftragsübermittlung automatisch anhand von Adresse, Bestand, Technik und Kapazität ausgewählt. Ein Standort kann nicht manuell festgelegt werden. Die Auswahl einer Verkaufsregion oder das Abschalten von Ausweichstandorten garantiert daher nicht das Werk Charlotte.

### Ergebnis und konkrete offene Anbieterfragen

- EU-/UK-Versandländer können technisch bereits mit unseren vorhandenen Angebotsdaten an die separate Tax API übergeben werden. Die Integration mit Zahlungsabschluss, Steuerverbuchung und Erstattungen ist noch nicht implementiert.
- Für US-Ursprünge reicht das dokumentierte Printful-Angebot nicht aus, um Stripes Pflichtfelder wahrheitsgemäß zu füllen. Die PLZ eines vermuteten Werks oder die Empfänger-PLZ ist kein belegter Ersatz.
- An Stripe: Kann unser Konto die Preview für Versandursprünge in Checkout nutzen, mit welchen Parametern/API-Versionen? Welche unterstützte Behandlung gibt es bei POD, wenn vor Zahlung nur das US-Ursprungsland, aber keine Absender-PLZ bekannt ist?
- An Printful: Gibt es für API-Bestellungen vor Zahlungsabschluss einen unterstützten Endpunkt für den verbindlichen Versandstandort einschließlich US-Absender-PLZ? Falls nicht, welches dokumentierte Verfahren unterstützt Printful für Steuerberechnungen, die diese Angabe benötigen?

## 6. Vertiefte Recherche: Standardursprung und Kosten

Recherche vom 24.09.2026: Printful dokumentiert tatsächlich einen Standardursprung für bestimmte Shop-Integrationen. Die [Etsy-Lieferdetails](https://help.printful.com/hc/en-us/articles/4406603758354-What-are-the-delivery-details-on-my-Etsy-store) empfehlen ausdrücklich die US-PLZ 28273. Beim [Standardursprung für Etsy](https://help.printful.com/hc/en-us/articles/50262432783121-Can-I-change-the-country-of-origin-for-my-Printful-generated-delivery-profiles) lassen sich Land und PLZ eines Printful-Standorts für Versandprofile hinterlegen; die Seite erwähnt auch Auswirkungen auf Steuerberechnungen. Für [Weebly](https://help.printful.com/hc/en-us/articles/50262783309329-How-do-I-configure-shipping-for-Weebly) beschreibt Printful ebenfalls einen Standard-Versandursprung trotz automatischer Auftragsverteilung.

Damit ist eine Standardadresse ein dokumentierter Integrationsansatz und nicht bloß eine Vermutung von Händlern. Diese Anleitungen belegen jedoch keine von Stripe unterstützte Verwendung als tatsächliche `ship_from_details`-Adresse für unseren eigenen Shop. Ein universeller Printful-/Stripe-Tax-Fallback bei unbekannter US-Absender-PLZ sowie öffentliche Checkout-Preview-Zugangskonditionen wurden nicht gefunden. Die präzisere Anbieterfrage ist nun, ob Printfuls Standardursprung 28273 auch für Stripe Tax in diesem Modell vorgesehen und von Stripe unterstützt ist.

Die [deutsche Stripe-Tax-Preisliste](https://stripe.com/de/tax/pricing) nennt für Tax Basic 0,5 % im nativen Checkout oder 0,45 EUR je gebührenpflichtiger API-Transaktion einschließlich zehn Berechnungen; darüber 0,04 EUR je Berechnung. Kein Basic-Monatsabo. Tax Complete beginnt bei 80 EUR monatlich mit Jahresvertrag und begrenzten Kontingenten; zusätzliche internationale Gebühren sind möglich. Für die Versandursprung-Preview wurde kein eigener veröffentlichter Preis gefunden.

Die Abrechnung und monatliche Verrechnung der Berechnungsaufrufe erläutert [Stripe Support](https://support.stripe.com/questions/understanding-stripe-tax-pricing?locale=de-DE). Insbesondere sind reine Berechnungen ohne spätere Steuertransaktion nicht pauschal kostenlos. Zahlungsabwicklungsgebühren kommen nach der [Payments-Preisliste](https://stripe.com/de/pricing) hinzu. Dies sind öffentliche Standardpreise, kein aus dem Konto abgerufenes Individualangebot. Kein Tarif wurde gebucht oder umgestellt.

## 7. Neuer GB-Kauf nach Hinzufügen der Stripe-Registrierung

Bestellung 41, bezahlt am 25.09.2026 um 00:19:18 UTC (24.09.2026, 17:19:18 America/Los_Angeles). Lesender Abgleich am 25.09.2026 um 00:20:51 UTC. Neu vorhanden: aktive GB-Registrierung vom Typ `standard`, zusätzlich zu DE `oss_union`; alles Sandbox.

Empfänger London, WC1B 3DG; Printful meldet erneut Versand ab GB. Printful-Angebot unverändert: 5,95 EUR Produkt + 4,89 EUR Versand + 2,17 EUR VAT = 13,01 EUR. Daraus berechnet unsere Preisregel 12,10 EUR Warenbetrag einschließlich 1,00 EUR Gebührenreserve, plus 4,89 EUR Versand = 16,99 EUR netto.

Stripe berechnet jetzt britische VAT mit 20 %, `country=GB`, `taxability_reason=standard_rated`: 2,42 EUR auf die Ware und 0,98 EUR auf den Versand, insgesamt 3,40 EUR Steuer. Endbetrag 20,39 EUR; gegenüber dem vorherigen GB-Kauf 36 genau 3,40 EUR mehr.

Alle geprüften Abgleiche bestanden: Preisregel, Adresse, Stripe PaymentIntent, Datenbankbeträge, Text- und HTML-Beträge der Bestätigungs-E-Mail sowie Bestellstatus-API (HTTP 200). Ein verarbeiteter Zahlungs-Webhook, keine ausstehenden Stripe-Webhook-Zustellungen. E-Mail nach einem Sendeversuch als zugestellt gemeldet. Fulfillment weiterhin `mocked`; keine Stripe-Rechnung erzeugt.

Damit ist die gewünschte britische Steuerberechnung für diesen Warenkorb im bestehenden Checkout praktisch nachgewiesen. Der Test belegt keine Übermittlung des tatsächlichen Printful-Ursprungs und keine korrekte Behandlung beliebiger anderer Warenwerte oder Versandwege.
