# Entwicklungsrechner einrichten (macOS)

Diese Anleitung ist die zentrale Liste der Voraussetzungen für das Team.
Sie gilt für Macs mit Apple-Chip und Intel. Installiert wird die jeweils
passende Architektur; ein `node_modules`-Ordner wird nie zwischen Rechnern
kopiert. macOS muss von den verwendeten Werkzeugen unterstützt werden;
die aktuellen Grenzen stehen bei [Docker](https://docs.docker.com/desktop/setup/install/mac-install/)
und [Homebrew](https://docs.brew.sh/Installation). Ein erfolgreicher Check ersetzt
keinen tatsächlichen Testlauf oder Release-Nachweis auf dem jeweiligen Rechner.

## Der erste Befehl

Im geklonten Projektordner:

```bash
./setup.sh test --install
```

Das Skript läuft auch, wenn Node oder die Projektpakete noch fehlen. Es erklärt
fehlende Voraussetzungen und fragt vor jeder Installation einzeln nach.
Enter bedeutet **Nein**. Bei Bedarf bietet es Homebrew, Node 22 mit npm,
Docker Desktop und die Projektpakete an. macOS-Dialoge, Administrator-Passwort
und die erste Docker-Einrichtung müssen am eigenen Rechner abgeschlossen werden.
Danach denselben Befehl erneut ausführen. Es werden keine Shell-Profile geändert,
globalen Node-Verknüpfungen überschrieben oder Zugänge vergeben.

Ohne `--install` wird nur geprüft. Es gibt drei Profile:

| Aufgabe | Nur prüfen | Installation/Hilfe anbieten |
| --- | --- | --- |
| Anwendung lokal starten | `./setup.sh develop` | `./setup.sh develop --install` |
| Automatisierte Tests | `./setup.sh test` | `./setup.sh test --install` |
| Rechner für freigegebene Deployments vorbereiten | `./setup.sh deploy` | `./setup.sh deploy --install` |

Mit vorhandenem Node/npm geht auch `npm run doctor -- test` bzw.
`npm run doctor -- deploy --install`. Für fehlendes Node oder Homebrew immer
`./setup.sh` verwenden. Ohne interaktives Terminal werden keine Installationen
gestartet. Die Prüfung meldet Probleme mit einem Fehlercode und nennt diese
Anleitung. Sie lädt keine `.env`, zeigt keine Secret-Werte an und verbindet
sich nicht mit der gehosteten Datenbank. Das Deployment-Profil prüft zusätzlich
lesend die vorhandene Fly-Anmeldung, den App-Zugriff und `origin/main`.

## Was wofür gebraucht wird

| Voraussetzung | Entwicklung | Tests | Deployment | Einrichtung |
| --- | --- | --- | --- | --- |
| Node.js 22+, npm 10+ | Ja | Ja | Ja | Standard: Node 22 aus `.nvmrc`; `nvm use` bei bestehendem nvm, sonst Angebot über `brew install node@22` |
| Vollständiger Git-Checkout | Ja | Ja | Ja, mit Zugriff auf `origin/main` | Repository vom Maintainer freigeben lassen und klonen; `git` bei Bedarf mit `xcode-select --install` |
| Exakte npm-Pakete inkl. `canvas` | Ja | Ja | Ja | Prüfung/Installation gemäß `package-lock.json`, inklusive Node-/Rechnerwechsel; siehe unten |
| Laufendes lokales Docker | Für den App-Start nicht erforderlich | Ja, für automatisches Test-Postgres | Ja, für Tests und Linux-Image | `brew install --cask docker-desktop`; anschließend Docker öffnen und Einrichtung abschließen |
| Lokale `.env` und vorbereitete Entwicklungsdatenbank | Ja | Nein | Operator-`.env` erforderlich | Werte aufgabengerecht und verschlüsselt vom Maintainer beziehen |
| Fly CLI und eigenes Fly-Konto mit App-Berechtigung | Nein | Nein | Ja | `brew install flyctl`, dann `flyctl auth login`; Maintainer gibt die Organisation/App frei |
| GitHub-Zugriff, freigegebener Commit und Release-Erlaubnis | Zum Klonen | Zum Klonen | Ja | Eigene GitHub-Anmeldung/SSH-Schlüssel; Freigabe durch Maintainer |
| Netzwerk | Installation und konfigurierte Dienste | Erster Download von npm-Paketen/Postgres-Image | Installation, GitHub, Fly und Datenbank | Proxy/Firewall müssen die jeweiligen Ziele zulassen |

Homebrew ist ein angebotener Installationsweg, keine Pflicht bei bereits
funktionierenden Werkzeugen. Die Programme können auch über ihre offiziellen
Installer bereitgestellt werden. Installationsquellen:
[Homebrew](https://brew.sh/), [Node 22](https://formulae.brew.sh/formula/node@22),
[Docker Desktop](https://formulae.brew.sh/cask/docker-desktop),
[Fly CLI](https://fly.io/docs/flyctl/install/).
Die Installation dieser Werkzeuge allein startet keinen Server und führt kein
Deployment aus.

Node 22 aus Homebrew ist eine separat installierte Version. Falls `node` oder
`npm` im nächsten Terminal weiterhin fehlen bzw. zu alt sind, dort aktivieren:

```bash
export PATH="$(brew --prefix node@22)/bin:$PATH"
```

Bei nvm stattdessen `nvm use`. Danach `node --version` und `npm --version`
prüfen. `setup.sh` kann den passenden Homebrew-Pfad für seinen eigenen Aufruf
aktivieren; diese Änderung wirkt nicht auf das übergeordnete Terminal.

## Danach arbeiten

**Lokale Anwendung:** Die freigegebene Entwicklungs-`.env` sicher vom Maintainer
beziehen, im Projektordner ablegen und `./run_local.sh` starten. Dieser bleibt
der einzige unterstützte Startweg für Kollegen. Er prüft die Umgebung, bietet
im interaktiven Terminal Hilfe an und führt weiterhin die vorhandene
Paket-, Konfigurations- und Asset-Prüfung aus. `DATABASE_URL` muss auf eine für
manuelle Entwicklung freigegebene Datenbank zeigen. Die Wegwerf-Testdatenbank
wird nicht als dauerhafte Entwicklungsdatenbank eingerichtet. Fehlende optionale
Stripe-/Printful-Zugänge müssen weiterhin verständlich degradieren.

**Automatisierte Tests:** Nach der Einrichtung `npm test` oder zum Beispiel
`npm test -- test/words.test.js`. Die Testausführung prüft die benötigte Umgebung,
startet eigenes lokales Postgres 17 und räumt es wieder auf. Docker-CLI und
Docker-Dienst sind zwei verschiedene Dinge: Ein installiertes Docker reicht
nicht, wenn die App geschlossen ist. Remote-Kontexte sind gesperrt. Es werden
weder eine Supabase-Testdatenbank noch `psql`, `pg_dump` oder die Supabase CLI
benötigt. Der ausdrücklich konfigurierte lokale `TEST_DATABASE_URL`-Sonderfall
aus der [README](../README.md#testing) bleibt möglich; der Test-Runner benötigt
dann keinen Docker-Dienst. Der allgemeine `test`-Umgebungscheck prüft den
Standardweg mit Docker.

Verweigert macOS oder die Agent-/Terminal-Umgebung den Zugriff auf Docker oder
Flys Konfigurationsordner, meldet die Prüfung ein Rechteproblem. In diesem Fall
die passende lokale Freigabe prüfen; eine Neuinstallation hilft nicht automatisch.

**Deployment:** Erst `./setup.sh deploy` ausführen und offene Punkte beheben.
Anschließend gelten die bestehenden Release-Regeln in
[AGENTS.md](../AGENTS.md#where-things-deploy),
[README](../README.md#database-verification-for-releases) und
[Operations](operations.md). Die Umgebungsprüfung ist keine Release-Freigabe.
Sie ändert keine Fly-Secrets, Migrationen, Kundendaten oder App-Konfiguration.
Git-Remote-/Fly-Fehler können auch am Netzwerk oder an abgelaufenen Tokens
liegen; eine fehlgeschlagene Anfrage beweist nicht automatisch fehlende Rechte.

Lesender App-Zugriff bestätigt keine Schreibrechte. Der Maintainer muss den
Kollegen als Operator freigeben, passende Fly-Organisationsrechte erteilen und
die benötigten lokalen Operator-Werte sicher bereitstellen. Dazu gehören je
nach freigegebenem Ablauf `MIGRATION_DATABASE_URL`, `MAINTENANCE_SECRET` und die
im jeweiligen Release-Befehl validierten Integrationswerte. Eine Entwicklungs-
`.env` reicht dafür nicht automatisch aus. Die vollständige Variablenreferenz
steht in der [README](../README.md#environment-variables) und `.env.example`;
die Release-Skripte prüfen die tatsächlichen Werte. Privilegierte
Migrationszugänge bleiben lokal und gehören niemals in Fly oder Git.

Aktive Produktion wird ausschließlich mit der freigegebenen `release`-Phase von
`npm run cutover:production` aktualisiert. Exakter Commit, sauberer `main`,
Bestätigung und alle bisherigen Sicherheitsprüfungen bleiben erforderlich.
`deploy:hosted` gilt ausschließlich für den Hosted-Test-Modus. Die Umgebungs-
einrichtung startet keinen dieser Befehle.

## Native Grafikbibliotheken

`canvas` enthält nativen Code. Nach einem Wechsel von Node-Version oder
Rechnerarchitektur müssen die Pakete neu installiert werden. Das wird am
Installationsnachweis erkannt; die Prüfung lädt zusätzlich `canvas` in einem
separaten Prozess. Ein defektes natives Paket kann über `--install` eine
Neuinstallation anbieten.

Falls npm mangels passender Binärdatei aus Quellcode kompilieren muss, werden
Apple Command Line Tools, Python 3, `pkg-config` und Grafikbibliotheken benötigt.
Bei entsprechenden Compiler-/Cairo-/Pango-Fehlern:

```bash
xcode-select --install
# macOS-Installation im Dialog vollständig abschließen, dann:
brew install python pkg-config cairo pango libpng jpeg giflib librsvg pixman
./setup.sh test --install
```

Diese zusätzlichen Compiler-Pakete werden nicht pauschal installiert. Die
[canvas-Installationsanleitung](https://github.com/Automattic/node-canvas#compiling)
beschreibt den Quellcode-Build. Bei Fehlern die konkrete npm-Ausgabe prüfen;
Netzwerk-, Dateirechte- und Compilerfehler haben unterschiedliche Ursachen.

## Weitere Werkzeuge nur bei Bedarf

Die Browser-Prüfseiten (`test:emoji:browser`, `test:configurator:browser`)
werden manuell in den benötigten Browsern geöffnet. Safari ist auf macOS
vorhanden; Chrome/Firefox nur installieren, wenn diese Browser geprüft werden.
Der lokale `test:journey:browser`-Ablauf braucht zusätzlich die in der README
beschriebenen lokalen Docker-Images. Der Release-Ablauf baut und prüft sein
Linux-AMD64-Image auch auf Apple-Chips; das wird beim tatsächlichen Build
verifiziert. Kein zusätzlicher Postgres-Dienst oder manuelles Kopieren von
Fonts, Three.js, Fabric.js oder 3D-Dateien ist erforderlich.

Neue externe Werkzeuge oder geänderte Mindestversionen immer hier **und** in
`scripts/check-environment.js` bzw. `setup.sh` aktualisieren. Aufgabenbezogene
Release-/Provider-Anleitungen bleiben an ihren bestehenden Stellen; diese
Seite bündelt die Voraussetzungen und verweist auf die Abläufe.
