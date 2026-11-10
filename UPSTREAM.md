# Felhasznált külső kód

| | |
|---|---|
| Projekt | whybothercoding/ableton-mcp-server |
| Verzió | 3.0.0 |
| Commit | `0a897bf48e032bdd31f36511701b2afaf655eabb` (2026-10-11) |
| Licenc | MIT (`vendor/LICENSE-ableton-mcp-server.txt`) |
| Mit vettünk át | csak a Live-ban futó Remote Script: `vendor/AbletonMCP/` (változtatás nélkül) |

## Miért ez az alap
- Live 12 vagy újabb kell hozzá, **Max for Live nem** (a Producer Pal Max for Live-ot és Live 12.3+ verziót igényel, ezért kiesett).
- Megvan benne minden, amit az MVP-nek olvasni kell: sávok, csoportok, returnök, Main, mute/solo/routing, hangerő, automatizálás-állapot (`playing` / `overridden`), mérők, transport.
- Ugyanaz a Remote Script később MCP-szerverrel (Claude Desktop stb.) szerkesztésre is használható.
- A másik jelölt (alaarab/livemcp) 220 eszközt ad, de nincs benne belső felvétel/hangmérés.

## Amit **nem** használtunk az upstreamből, és miért
- `measure`: Session-jelenetekre épül, indítja/leállítja a klipeket, és alapból **lehúzza a Main faderét** (`master_volume` 0,55). Arrangement-alapú dalhoz és a "ne nyúlj semmihez" elvhez nem jó.
- `bounce` + ffmpeg: a hangelemzéshez ffmpeg kellene. Helyette a `src/audio.js` WAV-elemzőt használjuk (nincs külső függőség).
- `npm run deploy`: macOS-útvonalakat keres. Helyette `hangero telepit`.

## Frissítés
Új upstream verzióhoz: cseréld a `vendor/AbletonMCP/` tartalmát, frissítsd ezt a fájlt és a `src/report.js` TOOL.upstream mezőjét, futtasd a teszteket, majd **élő Live-ban újra a docs/TESZT-UTMUTATO.md-t**.
