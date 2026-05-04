# Kimai Timer für Elgato Stream Deck

Dieses Plugin startet per Stream-Deck-Button eine feste Kimai-Kombination aus Kunde, Projekt und Tätigkeit.

## Verhalten

- **Grün**: Die Tätigkeit dieses Buttons läuft.
- **Grau**: Eine andere Kimai-Tätigkeit läuft.
- **Rot**: Keine Tätigkeit läuft oder der Button ist noch nicht eingerichtet.
- Klick auf einen Button:
  - stoppt laufende andere Kimai-Tätigkeiten,
  - startet die konfigurierte Projekt-/Tätigkeits-Kombination,
  - lässt die eigene laufende Tätigkeit standardmäßig weiterlaufen.
- Optional kann ein erneuter Klick auf dieselbe laufende Tätigkeit diese stoppen.

## Kimai API

Das Plugin nutzt Bearer-Token-Authentifizierung. In Kimai im Benutzerprofil einen API-Token erzeugen und im Stream-Deck-Property-Inspector eintragen.

## Installation zum Testen

1. Den Ordner `de.xcame.kimai.sdPlugin` in den Stream-Deck-Plugins-Ordner kopieren.
2. Stream Deck neu starten.
3. Aktion **Timer Control** auf einen Button ziehen.
4. Im Property Inspector eintragen:
   - Kimai URL, z. B. `https://kimai.example.com`
   - API Token
   - Projekt-ID und Tätigkeits-ID oder über **Listen laden** auswählen
   - optional Kunden-ID, Beschreibung, Tags, Button-Titel

### Plugin-Ordner

macOS:

```bash
~/Library/Application Support/com.elgato.StreamDeck/Plugins/
```

Windows:

```powershell
%APPDATA%\Elgato\StreamDeck\Plugins\
```


## Attribution 

This project is licensed under the MIT License.

You are free to use, modify, and redistribute this code. Please keep attribution to the original project by linking back to this repository.