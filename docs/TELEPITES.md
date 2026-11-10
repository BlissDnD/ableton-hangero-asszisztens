# Telepítés Windowson (kezdőknek)

Időigény: kb. 10 perc. **Először egy projektmásolattal dolgozz**, ne az egyetlen példányoddal.

## 0. Mi kell

- Node.js 18 vagy újabb. Ellenőrzés: nyiss egy parancssort (Start → `cmd`), írd be: `node --version`. Ha hibát ír, telepítsd a Node.js LTS-t a nodejs.org oldalról.
- Az Ableton Live, amiben a projekt fut. Python, ffmpeg és Max for Live **nem** kell.

## 1. Az eszköz letöltése

GitHubról (zip: Code → Download ZIP, kicsomagolás, pl. `C:\hangero-asszisztens`) vagy `git clone`-nal. Ezután a parancssorban lépj be a mappába:

```bash
cd C:\hangero-asszisztens
```

Ellenőrizd, hogy az automatikus tesztek nálad is lefutnak (ez még nem Ableton-teszt):

```bash
node --test
```

Elvárt: `# fail 0`.

## 2. A Remote Script bemásolása

```bash
hangero telepit --proba
hangero telepit
```

Az első csak megmutatja, mit másolna. Ha kiírja, hogy nem találja a User Library-t, nézd meg az Abletonban: **Options/Preferences → Library → User Library** helyét, és add meg:

```bash
hangero telepit --konyvtar "D:\Zene\Ableton\User Library"
```

A Library.cfg-alapú automatikus keresés Windowson még nem lett élőben kipróbálva, ezért ha nem talál, a kézi megadás a biztos út. A parancs a `Remote Scripts\AbletonMCP` mappát hozza létre, és fájlonként ellenőrzi a másolatot. Kézzel is megteheted: másold a `vendor\AbletonMCP` **mappát** (egészben!) a `<User Library>\Remote Scripts\` alá. Részleges másolatnál a script csendben eltűnik a listából.

## 3. Bekapcsolás az Abletonban

1. **Indítsd újra** az Ableton Live-ot (a Remote Scripteket csak induláskor keresi).
2. Options/Preferences → **Link, Tempo & MIDI**.
3. **Control Surface** egyik sorában válaszd: **AbletonMCP**. **Input: None, Output: None**.
4. Az állítási sávban ezt kell látnod: `AbletonMCP: Listening for commands on port 9877`.

Ha az `AbletonMCP` nincs a listában:
- A *beállított* User Library-be másoltál? (Preferences → Library.)
- Nézd a naplót: `%APPDATA%\Ableton\Live 12.1.x\Preferences\Log.txt` (a mappanév a verziódtól függ). Keress `AbletonMCP` vagy `RemoteScriptError` sorokat.
- Hibaüzenet "requires Live 12 or later": a Live-od túl régi.

## 4. Első ellenőrzés

Nyitva a Live és a projekt:

```bash
hangero ellenoriz
```

Jó eset: `[OK] Kapcsolat`, `[OK] Megfigyelés képességei`, és egy `[FIGY] Live-verzió` sor, hogy a 12.1 nem igazolt (ez várt: a Remote Script 12.4-en fejlesztett). **Másold ki az egész kimenetet**, ha bármi `[HIBA]`, és küldd el.

| Üzenet | Teendő |
|---|---|
| `Nincs kapcsolat… REFUSED` | Fut a Live? Be van kapcsolva az AbletonMCP a Control Surface listában? Tűzfal/9877-es port? |
| `Hiányzó parancsok: …` | Részleges másolás. Futtasd újra a `telepit`-et, indítsd újra a Live-ot. |
| `Live 11.x fut` | Az eszköz Live 12-t igényel. |
| `[FIGY] Automatizálás… felülbírálva: N` | Az Abletonban a "Re-Enable Automation" gomb világít. Az eszköz nem nyúl hozzá; te dönts. |

## 5. Hogyan tovább

Az élő próba lépései: [TESZT-UTMUTATO.md](TESZT-UTMUTATO.md). Használat és AI: [AI-HASZNALAT.md](AI-HASZNALAT.md).

## Eltávolítás

Töröld a `<User Library>\Remote Scripts\AbletonMCP` mappát, és vedd ki a Control Surface listából. Mást nem telepít az eszköz. Mérés után maradhat WAV a projekt `Samples\Recorded` mappájában: ezeket kézzel törölheted.
