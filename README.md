# Hangerő-asszisztens Ableton Live-hoz (MVP)

Egy kis parancssori eszköz, amely **megnézi és megméri egy zenerész hangerőviszonyait**, és olyan jelentést ír, amit bármelyik AI (ChatGPT, Claude, Gemini…) fel tud dolgozni. Nem kell hozzá screenshot és kézi WAV-export.

> ## ⚠ Állapot: élő Abletonban még NEM lett kipróbálva
> A fejlesztés felhőben, szimulált (mock) Live ellen történt. 28 automatikus teszt zöld, de ez azt bizonyítja, hogy az eszköz helyesen beszél a *dokumentált* protokollal, nem azt, hogy a **te Live 12.1-eden** működik. Az élő próbát a [docs/TESZT-UTMUTATO.md](docs/TESZT-UTMUTATO.md) vezeti végig. Amíg az nincs kipipálva, minden "teszteletlen".

## Mit tud

| Parancs | Mit csinál | Ír a projektbe? |
|---|---|---|
| `hangero telepit` | Bemásolja a Remote Scriptet az Ableton User Library-be (egyszer) | nem (a Live mappájába másol) |
| `hangero ellenoriz` | Kapcsolat, tényleges Live-verzió, képességek, hiányzó adatok | **nem** |
| `hangero vizsgal --szerep "lágy verze"` | Lejátszás közben naplózza a sávok, faderek, mute/solo/routing, automatizálás állapotát és a mérőket; jelentést ír | **nem** |
| `hangero meres --szerep "erős refrén" --utem 8` | Rövid felvétel a Main kimenetről → integrált/rövid távú LUFS, true peak, RMS | **igen, ideiglenesen** (lásd lent) |
| `hangero elemez export.wav` | Bármely WAV LUFS/true peak elemzése (ellenőrző exporthoz) | nem, Abletonhoz sem kapcsolódik |
| `hangero osszehasonlit elotte.json utana.json` | Módosítás előtti–utáni jelentés összevetése | nem |
| `hangero helyreallit` | Félbemaradt mérés után rendet rak | törli az ideiglenes sávot |

## Gyors kezdés (Windows)

1. Kell a Node.js (18+): parancssorban `node --version`.
2. Telepítés és első próba: [docs/TELEPITES.md](docs/TELEPITES.md) (kb. 10 perc).
3. Használat:
   ```bash
   hangero ellenoriz
   hangero vizsgal --szerep "lágy verze"
   ```
   Indítsd el a lejátszást az Abletonban, hagyd futni a vizsgált részt, állítsd le. A jelentés a `jelentesek/` mappába kerül (`.md` embernek, `.json` AI-nak).
4. Add a jelentést az AI-nak: [docs/AI-HASZNALAT.md](docs/AI-HASZNALAT.md).

Ableton nélkül is kipróbálhatod a szimulátorral (`npm run szimulator`, másik ablakban `hangero ellenoriz`). **Ez nem Ableton.**

## Amit a diagnózis (nem) állít

- A halkabb zenei rész önmagában nem hiba; a megadott szerep (`lágy verze` / `erős refrén`) számít, az eszköz **nem** hozza egy szintre a részeket.
- A teljes dal átlaga nem minősíti a mixet; a legnagyobb mérő nem bizonyítja, melyik sáv okozza a gondot.
- A magas csúcs nem automatikusan ok kompresszorra.
- A jelentés külön szakaszban adja a **mért tényt**, a **feltételezést** és a **javasolt ellenőrzést**.
- A Live API mérői (`vizsgal`) **nem kalibráltak** (0,85 = fader 0 dB jelölés, nem dBFS/LUFS). Valódi hangosság csak a `meres`/`elemez` számaiból jön.
- A hiányzó adat nem csend: a return sávok mérőjét a Live API nem adja ki.
- Nem ígér professzionális mixet. Nincs automaster, nincs automatikus újrakeverés.

## A `meres` mellékhatásai (nem tisztán olvasó!)

Létrehoz egy ideiglenes `HANGERO MERES` audio sávot (Resampling bemenet, monitor OFF, arm), felvesz a Mainről, majd törli a sávot, visszaállítja az arm állapotokat (exclusive arm miatt ez szükséges) és a kijelölt sávot. **Nem ír** hangerőt, panorámát, automatizálást, és nem indítja/állítja le a lejátszást. Marad: a WAV fájl a projekt `Samples/Recorded` mappájában, a Ctrl+Z lista bővülése (utána ne nyomj azonnal Ctrl+Z-t), "módosított" jelölés a projekten. Megszakításnál (Ctrl+C) is takarít; ha az ablakot bezárod vagy összeomlik, a `hangero helyreallit` napló alapján rendbe teszi. **Az első teszteket projektmásolaton végezd.**

## Biztonság és adatvédelem

- A Remote Script a `127.0.0.1:9877` porton **hitelesítés nélkül** fogad parancsokat: a gépeden futó bármely program vezérelheti a Live-ot. Kívülről nem érhető el. Tartsd ezt észben, és ne futtass megbízhatatlan programot Live közben. Az `eval` és `record` kapukat nem kapcsoljuk be.
- A jelentés alapból **nem** tartalmaz fájlútvonalat (csak a projekt nevét). A `--utvonal` kapcsolóval kerül bele.
- Nem küldünk semmit az internetre.

## Mappák

```
src/        az eszköz kódja (függőségmentes Node.js)
vendor/     az upstream Remote Script (változtatás nélkül, MIT)
test/       automatikus tesztek (szimulált Live + ismert hangjelek)
testkit/    a szimulált Live
docs/       telepítés, élő teszt-útmutató, elemzés, AI-használat
```

További: [docs/ELEMZES.md](docs/ELEMZES.md) (a terv szakmai átvilágítása, javítási és fejlesztési javaslatok), [UPSTREAM.md](UPSTREAM.md) (felhasznált kód, commit).
