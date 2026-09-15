# Steuerkonzept: Printful + Stripe

Stand: 14. September 2026

## Unser Fall

- Verkäufer und Zahlungsempfänger: deutsche UG.
- Besteuerung: Regelbesteuerung, B2C-Verkäufe.
- Ware: personalisierte physische Produkte.
- Printful produziert und versendet direkt an den Kunden.
- Der Kunde bezahlt die UG über Stripe; Printful berechnet der UG Produktion,
  Versand und gegebenenfalls Steuer.
- Es liegen zwei Lieferungen vor: `Printful -> UG -> Kunde`.

## Klare Empfehlung

**Live zunächst nur für Lieferadressen in Deutschland freigeben.**

Bis die Transportzuordnung schriftlich bestätigt ist, sind EU-weite oder
weltweite Live-Verkäufe nicht steuerlich belastbar automatisierbar. Der von
Printful geschätzte Steuerbetrag und das geschätzte `departure_country` lösen
dieses Problem nicht.

Für den Deutschland-Start gilt:

- Printful: echte deutsche USt-IdNr. der UG hinterlegen und freigeben lassen.
- Stripe Tax: tatsächliche deutsche Geschäftsadresse und ausschließlich die
  tatsächlich bestehende deutsche Registrierung hinterlegen.
- Kundenverkauf nach Deutschland: vorläufig 19 % USt. für alle aktuellen
  Produkte und Versand; Produktklassifizierung vor Live-Start bestätigen lassen.
- Lieferziele außerhalb Deutschlands im Backend ablehnen.
- Printful-Aufträge mit Abgang außerhalb der EU nicht automatisch bestätigen,
  bis Einführer, Einfuhrumsatzsteuer und Zollabwicklung feststehen.
- Die bestehenden Live-Sperren bleiben bis zur Freigabe aktiv.

## Was an der bisherigen Aussage falsch ist

1. **Die deutsche USt-IdNr. macht Printful-Rechnungen nicht generell
   steuerfrei.** Printful richtet seine Steuer nach Registrierungsstatus,
   tatsächlichem Fulfillment-Land und Lieferziel.
2. **Printful-Steuer ist keine Kundensteuer.** Sie ist Eingangssteuer oder
   Beschaffungskosten der UG und bestimmt nicht den Stripe-Steuersatz.
3. **OSS gilt nicht automatisch für Printful-Dropshipping.** Wird die
   Warenbewegung der Lieferung `Printful -> UG` zugeordnet, ist die Lieferung
   `UG -> Kunde` eine ruhende Lieferung im Zielland. Dafür kann eine lokale
   Registrierung im Zielland erforderlich sein; diese Lieferung gehört dann
   nicht in den OSS.
4. **Eine deutsche USt-IdNr. verschiebt die Warenbewegung bei Abgang aus
   Lettland oder Spanien nicht auf die Lieferung der UG.** Dafür wäre bei einer
   innergemeinschaftlichen Beförderung eine USt-IdNr. des tatsächlichen
   Abgangslands erforderlich, die Printful vor Versandbeginn verwendet.
5. **0 % von Stripe bedeutet nicht automatisch steuerfrei.** Stripe kann 0
   ausgeben, weil für das Land keine Steuerregistrierung hinterlegt ist
   (`not_collecting`).
6. **Ein Versand in ein Drittland ist nicht automatisch eine steuerfreie
   Ausfuhrlieferung der UG.** Das gilt nur, wenn gerade die Lieferung der UG die
   bewegte Lieferung ist und alle Nachweise vorliegen.

## Transportzuordnung

Maßgeblich ist nicht der API-Aufruf, sondern wer den selbständigen Frachtführer
beauftragt beziehungsweise auf wessen Rechnung und Risiko transportiert wird.

Die öffentlich verfügbaren Printful-Bedingungen sind hierfür nicht eindeutig:

- Printful organisiert den Versand und übergibt an den Frachtführer.
- Die UG bezahlt Printful den Versand.
- Die allgemeine Klausel verlagert Gefahr und Eigentum bei Übergabe an den
  Frachtführer. Für Händlerlieferungen nach Deutschland nennt Printful jedoch
  einen besonderen Gefahrübergang erst nach Überschreiten der deutschen
  Grenze; für Nutzer im EWR/UK enthält der Vertrag eine weitere Sonderregel.

Deshalb muss die folgende Einordnung schriftlich bestätigt werden:

### Variante A: Printful veranlasst die Versendung

- Bewegte Lieferung: `Printful -> UG`.
- Lieferung `UG -> Kunde`: ruhend am Bestimmungsort.
- EU-Kunde außerhalb Deutschlands: grundsätzlich lokale B2C-Lieferung im
  Zielland; OSS ist dafür nicht anwendbar.
- Folge: lokale USt-Registrierungen in den belieferten EU-Staaten können ab dem
  ersten Umsatz erforderlich sein.

Dies entspricht dem ausdrücklichen Dropshipping-Beispiel der EU-Kommission:
Kauft A die Ware bei B in einem anderen Mitgliedstaat und lässt B direkt an
As Kunden senden, gilt As Kundenlieferung ohne eigene Warenbewegung und ist
kein innergemeinschaftlicher Fernverkauf.

### Variante B: Die UG ist Zwischenhändler mit Transportverantwortung

Ohne wirksame Verwendung einer USt-IdNr. des Abgangslands bleibt die bewegte
Lieferung ebenfalls grundsätzlich `Printful -> UG`.

Nur wenn die UG

- die Transportverantwortung nachweisbar trägt und
- Printful vor Versandbeginn aktiv eine USt-IdNr. des tatsächlichen
  Abgangslands verwendet,

kann die Bewegung `UG -> Kunde` zugeordnet werden. Dann kann der
grenzüberschreitende EU-B2C-Verkauf grundsätzlich über den Union-OSS erklärt
werden. Die vorgelagerte Printful-Lieferung ist dann eine lokale Lieferung im
Abgangsland; dortige Registrierung und Vorsteuerbehandlung bleiben zu prüfen.

Diese Variante ist mit Printful derzeit operativ ungeeignet: Das
Fulfillment-Land wird automatisch geroutet, kann sich ändern und lässt sich
nicht verbindlich je Bestellung auswählen.

## Fallmatrix

| Tatsächlicher Abgang | Kunde | Vorläufige Behandlung der UG | Freigabe |
|---|---|---|---|
| EU | Deutschland | Deutsche B2C-Lieferung, 19 %; Printful-Beleg separat buchen | Empfohlener Startfall |
| Nicht-EU | Deutschland | Kunden-USt. voraussichtlich 19 %; Einführer, EUSt und Zoll vorher klären | Blockieren |
| EU | anderes EU-Land | Bei Variante A lokale Lieferung im Zielland, nicht OSS | Blockieren bis Registrierung |
| EU | anderes EU-Land | OSS nur bei nachgewiesener Variante B und rechtzeitig verwendeter USt-IdNr. des Abgangslands | Blockieren bis Bestätigung |
| EU | Drittland | Nicht pauschal als Ausfuhr der UG behandeln; Bewegungszuordnung und lokale Regeln klären | Blockieren |
| Nicht-EU | gleiches Nicht-EU-Land | Lokale Umsatz-/Sales-Tax-Regeln und Schwellen; Printful-Steuer bleibt getrennt | Marktweise freigeben |
| Nicht-EU | anderes Land | Importeur, Einfuhrabgaben, lokale Steuer und Versandweg klären | Blockieren |

## Einstellungen bei Printful

- Legal Name, Anschrift und deutsche USt-IdNr. exakt auf die UG eintragen.
- Nur tatsächlich erteilte und aktive Steuer-IDs hinterlegen.
- Deutsche USt-IdNr. von Printful genehmigen lassen.
- Backup-Fulfillment soweit verfügbar deaktivieren; das reduziert, beseitigt
  aber nicht die Herkunftsunsicherheit.
- Für jede Bestellung endgültige Rechnung, Steuerbericht, tatsächliches
  Fulfillment-Land und Sendungsdaten speichern.
- Printful-Steuer nie als Kundensteuer verwenden.
- Resale Certificates nur nach tatsächlicher US-Registrierung einreichen.

## Einstellungen bei Stripe

- Head Office: tatsächliche Anschrift der UG, nicht ein Printful-Standort.
- Tax Registration: zunächst nur Deutschland; keine fiktiven Registrierungen.
- Automatic Tax: im Sandboxbetrieb aktiviert lassen.
- Produktcode `txcd_99999999` nur vorläufig. Vor Live-Start bestätigen, dass
  alle Produkte in allen freigegebenen Ländern dem Standardsatz unterliegen;
  andernfalls je Steuerklasse getrennte Positionen verwenden.
- Versandcode `txcd_92010001` beibehalten.
- Einen Betrag von 0 nur akzeptieren, wenn der Stripe-Steuergrund gespeichert
  und zulässig ist; `not_collecting` muss Checkout blockieren.
- Für mehrere tatsächliche Versandursprünge reicht Stripe Checkout Automatic
  Tax nicht aus. Checkout kann keinen transaktionsbezogenen
  `ship_from_address` erhalten. Dafür wäre die Stripe Tax Calculations API mit
  eigenem Zahlungsfluss oder ein anderer belastbarer Prozess nötig.
- Steuerregistrierungen in Stripe erst aktivieren, nachdem die behördliche
  Registrierung tatsächlich wirksam ist.

## Bedeutung für den bestehenden Code

### Bereits richtig

- `src/pricing.js` trennt Printful-Steuer von der Kundensteuer.
- `src/stripe.js` aktiviert Stripe Automatic Tax, verwendet exklusive Beträge
  und trennt Ware und Versand.
- `src/checkoutTax.js` übernimmt den signierten, abgeschlossenen Stripe-Betrag
  statt selbst einen Steuersatz zu raten.
- Das geschätzte Printful-Abgangsland wird intern gespeichert und dem Kunden
  nicht als Garantie angezeigt.

### Vor Live-Start ändern

1. Serverseitige Lieferland-Allowlist einführen; zunächst nur `DE`.
2. Nicht-EU-Abgänge für deutsche Bestellungen vor Printful-Bestätigung stoppen,
   solange die Importabwicklung nicht festgelegt ist.
3. Stripe-Steuergrund, Jurisdiktion, Satz und Registrierungsstatus dauerhaft
   speichern; `not_collecting`, unbekannte und nicht freigegebene Fälle
   ablehnen.
4. Tatsächliches Fulfillment-/Abgangsland aus dem endgültigen Printful-Auftrag
   und der Rechnung speichern. Die Shipping-Rate-Schätzung ist kein Nachweis.
5. Printful-Steuer in der Margenrechnung nur dann herausrechnen, wenn sie
   nachweislich als Vorsteuer abzugs- oder vergütungsfähig ist. Der aktuelle
   Code zieht sie immer von den Beschaffungskosten ab und kann dadurch die
   Marge zu hoch ausweisen.
6. Produkte nicht dauerhaft in einer aggregierten generischen Steuerposition
   zusammenfassen, wenn sie unterschiedliche Steuerklassen haben.
7. Dem Verbraucher vor dem zahlungspflichtigen Abschluss einen hervorgehobenen
   Gesamtpreis einschließlich USt. anzeigen. Die aktuelle Nettoanzeige auf der
   Versandseite reicht dafür nicht als Zielzustand.
8. Steuerrechnung/Gutschrift und Buchhaltungsexport mit Kundensteuer,
   Lieferland, tatsächlichem Abgang, Printful-Beleg und Stripe Tax Transaction
   vorsehen.
9. Abweichung zwischen geschätztem und tatsächlichem Abgangsland nach Zahlung
   als Fulfillment-Sperre behandeln, nicht nur protokollieren.

## Verbindlich zu klärende Fragen

### An Printful

> Wer schließt bei einem normalen API-Auftrag den Beförderungsvertrag mit dem
> Frachtführer, auf wessen Rechnung erfolgt der Transport und wer trägt während
> des Transports die Gefahr des zufälligen Untergangs? Ist das von
> `/v2/shipping-rates` gelieferte `departure_country` für einen anschließend
> erstellten Auftrag verbindlich? Falls nein: Zu welchem Zeitpunkt und über
> welches API-Feld steht das endgültige Abgangsland vor Produktions- und
> Versandbeginn unveränderlich fest? Können je Auftrag mehrere EU-USt-IdNr. des
> Händlers abhängig vom tatsächlichen Abgangsland verwendet werden?

### An den Steuerberater

> Wer veranlasst nach den Printful-Vertragsbedingungen im API-Dropshipping die
> Versendung im Sinne von Abschnitt 3.14 Abs. 7 UStAE? Welcher Lieferung wird
> sie nach § 3 Abs. 6a UStG zugeordnet? Ist bei Zuordnung zu Printful die
> Lieferung der UG an den Verbraucher als ruhende Lieferung im Bestimmungsland
> lokal zu registrieren und vom Union-OSS ausgeschlossen? Welche USt-IdNr. muss
> die UG bei einer abweichenden Zuordnung je tatsächlichem Abgangsland vor
> Versandbeginn gegenüber Printful verwenden, und wie sind Einfuhrfälle zu
> behandeln?

Die Antwort muss die Kombinationen `Abgangsland -> Zielland`, die
Transportverantwortung, den Importeur und die zu verwendende USt-IdNr. enthalten.
Eine Aussage nur zum Printful-Steuerbetrag genügt nicht.

## Freigabekriterien für weitere Länder

Ein Land darf erst freigeschaltet werden, wenn für jeden möglichen Printful-
Abgang dorthin dokumentiert ist:

- Zuordnung der Warenbewegung;
- Steuerort und Steuersatz des Kundenverkaufs;
- aktive Registrierung und Meldeweg, lokal oder OSS;
- richtige USt-IdNr. gegenüber Printful;
- Importeur und Abgaben bei Drittlandsbewegungen;
- verbindliche Herkunft vor Zahlung oder sichere Fulfillment-Sperre;
- Kundenrechnung, Gutschrift und Buchhaltungsexport;
- automatisierter Test für steuerpflichtig, zulässig 0 % und
  `not_collecting`/nicht unterstützte Fälle.

## Primärquellen

- [§ 3 Abs. 6a UStG](https://www.gesetze-im-internet.de/ustg_1980/__3.html)
- [§ 3c UStG](https://www.gesetze-im-internet.de/ustg_1980/__3c.html)
- [§ 18j UStG](https://www.gesetze-im-internet.de/ustg_1980/__18j.html)
- [UStAE, Abschnitt 3.14](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Umsatzsteuer/Umsatzsteuer-Anwendungserlass/Umsatzsteuer-Anwendungserlass-31-12-2025.pdf?__blob=publicationFile&v=3)
- [EU-Kommission: OSS-Erklärung und Dropshipping-Beispiel](https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/declare-and-pay-oss_en)
- [BZSt: One-Stop-Shop, EU-Regelung](https://www.bzst.de/DE/Unternehmen/Umsatzsteuer/One-Stop-Shop_EU/one_stop_shop_eu.html)
- [Printful: Umsatzsteuer bei EU-Bestellungen](https://help.printful.com/hc/de/articles/360014067279-Wie-wird-die-Umsatzsteuer-auf-Bestellungen-angewendet-die-nach-Europa-geschickt-werden)
- [Printful: Fulfillment-Standort ist nicht frei wählbar](https://help.printful.com/hc/en-us/articles/360014068659-Can-I-choose-where-my-products-are-fulfilled)
- [Printful Terms of Service](https://www.printful.com/de/richtlinien/herunterladen/terms-of-service)
- [Stripe Tax: Einrichtung und Registrierungen](https://docs.stripe.com/tax/set-up)
- [Stripe Tax: Ship-from-Adressen](https://docs.stripe.com/tax/calculating#ship-from-address)
- [Stripe Tax: Gründe für 0 Steuer](https://docs.stripe.com/tax/zero-tax)
- [§ 3 PAngV](https://www.gesetze-im-internet.de/pangv_2022/__3.html)

Dieses Dokument ist die technische Arbeitsgrundlage. Die markierten
Einordnungen müssen vor Live-Verkäufen schriftlich durch einen qualifizierten
Steuerberater bestätigt werden.
