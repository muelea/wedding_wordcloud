# Stripe-Live-Prüfung vom 27. Oktober 2026

Die Stripe-Live-Grundkonfiguration ist eingerichtet. Der laufende Server verwendet
jedoch noch den älteren Katalog mit **12 Varianten**. Die lokal geprüften
**343 Varianten und das neue Modell mit festen Produktpreisen sind noch nicht
veröffentlicht**. Der Live-Server enthält weder `productCostSnapshot.json` noch
`productCatalogManifest.json`; sein Preiscode hat noch keine `catalogPrice`-
oder `componentPrice`-Funktion. Dateiprüfsummen bestätigen den Unterschied.

## Tatsächlich geprüft

- Der bereits auf Fly hinterlegte Live-Schlüssel authentifiziert das richtige
  Wolkenworte-Konto. `charges_enabled` und `payouts_enabled` sind aktiv.
- Stripe Tax ist im Live-Konto `active`, mit deutschem Firmensitz und den
  vereinbarten aktiven Einstellungen DE `oss_union` und GB `standard`.
- Karte und PayPal sind in der aktiven Standard-Zahlartenkonfiguration
  verfügbar und eingeschaltet. Die konkrete Anzeige bleibt von Betrag,
  Lieferland und sonstiger Stripe-Eignung abhängig.
- Genau ein aktiver Live-Webhook zeigt auf
  `https://wolkenworte.fly.dev/webhook/stripe` und abonniert exakt
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.expired` und `charge.refunded`.
- Die beiden Live-Secrets sind tatsächlich `Deployed`; Stripe-Test-Secrets
  sind auf Fly nicht vorhanden. Das verwendete Webhook-Secret stimmt mit dem
  vorbereiteten lokalen Live-Secret überein. Keine Secret-Werte wurden ausgegeben.
- Fly-Release 103 läuft in Frankfurt mit `APP_ENVIRONMENT=production`,
  Live-Zahlungen, Live-Fulfillment und Live-Mail. Preisparameter: 50 %,
  3,69 % und 49 Cent. Die Stripe-Konfigurationsvalidierung liefert keine Fehler.
- Der bestehende Produktions-Readiness-Smoke besteht: Health, Startseite,
  kanonische Weiterleitung und Abweisung unsignierter Provider-Webhooks.

## Signaturprüfung ohne Bestellung

Der veröffentlichte Stripe-Webhook-Handler stimmt per SHA-256 mit dem lokal
gelesenen Handler überein. Ein unbekannter Ereignistyp wird dort vor jedem
Datenbank- oder Fulfillment-Zweig bestätigt. Genau diesen funktionslosen Typ
`wolkenworte.readiness_probe` haben wir am konfigurierten Live-Endpunkt geprüft:

- Falsche Signatur: HTTP 400.
- Korrekte Signatur mit dem vorbereiteten Live-Secret: HTTP 200,
  `received: true`.

Dies bestätigt Erreichbarkeit und aktive Signaturprüfung. Es ist ein eigener
Prüfaufruf, kein von Stripe zugestelltes Zahlungsereignis. Es entstanden keine
Kunden-, Checkout-, Zahlungs-, Bestell- oder Fulfillment-Objekte und keine
Geschäftsdatenänderungen. Konfiguration, Secrets und Deployment blieben unverändert.

## Was für den neuen Stand noch erforderlich ist

Für die neuen Produktpreise müssen im Stripe-Dashboard keine festen Prices
angelegt werden; die Anwendung erzeugt Checkout-Positionen mit ihren eigenen
validierten Beträgen und Steuerkategorien. Erforderlich ist ein separat
freigegebener Release des aktuellen Anwendungsstands über den vorgesehenen
Produktions-Release-Pfad, einschließlich dessen vollständiger Release-Prüfungen.
Diese Prüfung hat keinen solchen Release gestartet oder abgenommen.

Die tatsächliche Zahlungsautorisierung, ein erfolgreiches Zahlungsereignis,
Steuerverbuchung und Auszahlung wurden nicht ausgelöst. Die zuvor dokumentierte
Preisprüfung erfolgte in der Sandbox. Stripe hält
[Sandbox-Steuereinstellungen und Registrierungen getrennt vom Live-Modus](https://docs.stripe.com/tax/testing),
weshalb die Live-Einstellungen hier ausdrücklich unabhängig gelesen wurden.

Sanitisierte technische Nachweise: [stripe-live-readiness.json](stripe-live-readiness.json).
