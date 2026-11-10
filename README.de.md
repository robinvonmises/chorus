# Chorus – alle Messenger in einer App

> 🇬🇧 [English version](README.md)

Eine selbst gehostete WebApp, die **Telegram**, **Signal** und **WhatsApp** in einem gemeinsamen Posteingang vereint. Läuft als Docker-Container auf deinem eigenen Server, funktioniert im Browser am Computer und als installierbare App auf dem Handy.

| Messenger | Stand |
| --- | --- |
| Telegram | ✅ eingebaut (QR-Code oder Telefonnummer) |
| Signal | ✅ eingebaut (QR-Code, als gekoppeltes Gerät) |
| WhatsApp | ✅ eingebaut (QR-Code oder Kopplungscode, inoffiziell über Baileys) |

## Was die App kann

- Ein Posteingang für alle Chats, filterbar nach Messenger oder „Ungelesen“
- Nachrichten, Antworten auf Nachrichten, Bearbeiten, Löschen
- Mit Emojis reagieren (Rechtsklick, langes Drücken oder Doppelklick für ❤️)
- Bilder, Videos und Dateien senden und herunterladen (auch per Drag & Drop oder Einfügen)
- Sprachnachrichten aufnehmen und abspielen (mit 1,5×/2× Geschwindigkeit)
- Desktop: große Drei-Spalten-Ansicht. Handy: Liste und Chat wie bei Signal
- Hell- und Dunkelmodus, Benachrichtigungen, Entwürfe pro Chat

## KI-Assistent (freiwillig)

Im Chat unten links im Eingabefeld auf den Roboter tippen:

- **Zusammenfassen**: worum es geht, was vereinbart ist, was offen ist
- **Nachricht schreiben lassen**: z. B. „sag, dass ich beim Sport bin und mich später melde“ eintippen oder einsprechen, dann als Text oder als Sprachnachricht in deiner Stimme senden
- **Autopilot**: Claude antwortet selbst, bis das eingestellte Limit (1 bis 20 Antworten) erreicht ist, dann schaltet er sich ab. In Gruppen nur, wenn jemand eine Frage stellt, dich erwähnt oder dir antwortet. Antworten werden auf Wunsch mit einer 🤖-Reaktion markiert (Telegram: „– 🤖“ am Ende, weil Telegram 🤖 nicht als Reaktion erlaubt)
- **Antworten vorschlagen**: drei passende Antworten, antippen übernimmt sie ins Eingabefeld (optional mit Richtung, z. B. „freundlich absagen“)
- **Abtippen**: Sprachnachrichten werden zu Text
- **In deiner Stimme antworten**: geschriebenen Text als Sprachnachricht senden (Knopf neben „Senden“)

Einrichten unter Einstellungen → KI-Assistent: ein Claude-API-Schlüssel (Anthropic) für Text, ein ElevenLabs-Schlüssel für Sprache und eine Stimme (z. B. deine geklonte). Die KI ist pro Chat ausgeschaltet, bis du sie dort erlaubst. Erst dann und nur auf Knopfdruck gehen Nachrichten dieses Chats an Anthropic bzw. ElevenLabs.

## Sicherheit: der Tresor

Beim ersten Start legst du ein Passwort fest. Daraus erzeugt **dein Browser** einen Schlüssel. Damit sind alle Chats, Dateien und Zugangsdaten auf dem Server verschlüsselt (Datenbank: SQLCipher, Dateien: AES-256-GCM).

- Der Server speichert den Schlüssel **nicht**. Nach einem Neustart ist alles gesperrt, bis du die App wieder öffnest.
- Signal und WhatsApp liefern Nachrichten, die in dieser Zeit ankommen, nach.
- Optional gibt es den **Komfort-Modus** (Einstellungen → Sicherheit). Dann empfängt der Server auch nach einem Neustart sofort, legt dafür aber einen Schlüssel auf der Platte ab.
- Beim Einrichten bekommst du einen **Wiederherstellungscode**. Gut aufbewahren: Ohne Passwort und ohne Code sind die Daten weg.
- **Zwei-Faktor-Anmeldung** (Einstellungen → Sicherheit): Zusätzlich zum Passwort fragt Chorus nach einem Code aus einer Authenticator-App (2FAS, Aegis, Google Authenticator, 1Password …). Geräte, denen du „30 Tage vertraust“, fragen erst danach wieder. Handy verloren? Mit dem Wiederherstellungscode kommst du rein, die Zwei-Faktor-Anmeldung wird dabei ausgeschaltet und du richtest sie neu ein.
- Nach 10 Fehlversuchen in 10 Minuten nimmt Chorus von dieser Adresse 5 Minuten lang keine Anmeldung mehr an. Bei vielen Fehlversuchen von verschiedenen Adressen wird jede Anmeldung gebremst, aber niemand ausgesperrt.
- Wenn Chorus aus dem Internet erreichbar ist: im Reverse Proxy HTTP auf HTTPS umleiten und HSTS einschalten (im Nginx Proxy Manager „Force SSL“ und „HSTS Enabled“).

## Profile für Familie und Freunde

Eine Chorus-Installation kann mehrere Personen bedienen. Jede Person hat ein eigenes Profil mit eigenem Passwort, eigener Zwei-Faktor-Anmeldung, eigenen Messengern und eigenen KI-Schlüsseln. Jedes Profil ist getrennt verschlüsselt, auch der Admin kann fremde Chats nicht lesen.

- Wer Chorus zuerst einrichtet, ist Admin.
- Neue Profile legt der Admin an: Einstellungen → Profile → Name eingeben → „Profil anlegen“. Den Einladungslink schickst du der Person. Sie legt beim ersten Öffnen ihr eigenes Passwort fest, der Code gilt nur einmal.
- Bei der Anmeldung wählt jede Person ihr Profil aus.
- Wer von einer Version ohne Profile kommt: Der bestehende Tresor wird automatisch das erste Profil (Admin), es geht nichts verloren. Den Namen dafür setzt `FIRST_PROFILE_NAME` (z. B. `FIRST_PROFILE_NAME=Wayne docker compose up -d`), umbenennen geht später auch in den Einstellungen.
- Pro Profil mit Signal läuft ein eigenes signal-cli (etwa 200–300 MB Arbeitsspeicher).

## Installation

Voraussetzung: ein Server mit Docker (z. B. Ubuntu, Debian, Synology, Unraid).

```bash
mkdir chorus && cd chorus
curl -O https://raw.githubusercontent.com/robinvonmises/chorus/main/docker-compose.yml
docker compose up -d
```

Chorus läuft dann als einfaches HTTP auf **`http://<IP-deines-Servers>:8080`**. Den eigenen Reverse Proxy (nginx, Caddy, Traefik, Nginx Proxy Manager …) einfach auf diesen Port zeigen lassen.

> **Warum trotzdem HTTPS empfohlen ist:** Über reines HTTP (außer `localhost`) erlauben Browser kein Mikrofon (Sprachnachrichten aufnehmen, Aufträge einsprechen), keine App-Installation und keine Benachrichtigungen. Alles andere funktioniert, auch der Tresor.

**Ohne eigenen Proxy** gibt es HTTPS mit selbst erstelltem Zertifikat auf Port 8443:

```bash
curl -O https://raw.githubusercontent.com/robinvonmises/chorus/main/Caddyfile
docker compose --profile https up -d
```

Wer von einer älteren Version kommt und HTTPS nicht mehr braucht, entfernt den alten Caddy-Container einmalig mit `docker compose --profile https rm -s -f https`.

### Ohne Docker (z. B. Proxmox-LXC)

Auf Debian/Ubuntu als root:

```bash
git clone https://github.com/robinvonmises/chorus.git && cd chorus
bash deploy/install-ohne-docker.sh        # erneut ausführen = Update
```

Das Skript installiert Node.js, signal-cli, ffmpeg und Caddy, richtet den Dienst `inbox` ein und meldet die Adresse. Daten liegen in `/var/lib/inbox`.

### Port ändern

```bash
PORT=9000 docker compose up -d
```

### Von unterwegs erreichbar machen

Am einfachsten mit [Tailscale](https://tailscale.com): auf Server und Handy installieren, dann ist Chorus unter der Tailscale-Adresse erreichbar, ohne Ports im Router zu öffnen. Alternativ ein Cloudflare Tunnel oder eine eigene Domain mit Reverse Proxy.

### Updates

```bash
docker compose pull && docker compose up -d
```

**Automatisch** (Chorus-Ordner als Git-Klon, Server mit systemd): `bash deploy/auto-update-einrichten.sh` richtet einen Timer ein. Der Server schaut dann jede Minute auf GitHub nach, wartet, bis das Image zum neuen Stand fertig gebaut ist, spielt es ein und geht von selbst auf den alten Stand zurück, wenn Chorus danach nicht sauber startet. `data/` und `.env` werden nie angefasst. Protokoll: `journalctl -u chorus-update`.

Hinweis: Ohne Komfort-Modus ist nach jedem Update alles gesperrt, bis du die App wieder öffnest.

### Ausprobieren ohne echte Konten

```bash
docker run --rm -p 8080:8080 -e DEMO=1 ghcr.io/robinvonmises/chorus:latest
```

## Messenger verbinden

**Telegram:** Unter [my.telegram.org/apps](https://my.telegram.org/apps) eine App anlegen (Name egal), `api_id` und `api_hash` in Chorus eintragen. Am Computer per QR-Code (Telegram → Einstellungen → Geräte → Desktop-Gerät verbinden), am Handy per Telefonnummer und Code.

**Signal:** „Messenger verbinden“ → Signal → QR-Code mit dem Handy scannen (Signal → Einstellungen → Gekoppelte Geräte → +). Signal überträgt keine alten Nachrichten, du siehst alles ab der Kopplung. Die Signal-Schlüssel liegen nur im Arbeitsspeicher und verschlüsselt im Tresor.

**WhatsApp:** „Messenger verbinden“ → WhatsApp → QR-Code scannen (WhatsApp → Einstellungen → Verknüpfte Geräte → Gerät hinzufügen) oder am Handy per Kopplungscode. WhatsApp überträgt beim Koppeln einen Teil der letzten Chats. Wichtig: Inoffizielle Clients verstoßen gegen die WhatsApp-Nutzungsbedingungen, eine Sperre ist möglich. Öffne WhatsApp am Handy mindestens alle 14 Tage.

## Einstellungen (Umgebungsvariablen)

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `PORT` | `8080` | Port im Container |
| `DATA_DIR` | `/data` | Ablage für Tresor, Datenbank, Dateien |
| `MAX_UPLOAD_MB` | `100` | Maximale Dateigröße beim Hochladen |
| `DEMO` | – | `1` = Demo-Chats zum Ausprobieren |
| `FIRST_PROFILE_NAME` | `Ich` | Name des ersten Profils beim Übernehmen eines bestehenden Tresors |
| `TRUST_PROXY` | `loopback,linklocal,uniquelocal` | Welchen Reverse Proxys Chorus die echte Absenderadresse (`X-Forwarded-For`) glaubt. Standard: nur Proxys im eigenen Netz. Liegt dein Proxy woanders, hier seine IP eintragen. |

## Entwicklung

```bash
cd server && npm install && DEMO=1 PORT=8099 npm run dev
cd web && npm install && npm run dev   # http://localhost:5173
```

Tests: `cd server && npm test`
