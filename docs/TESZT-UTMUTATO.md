# Élő próba Ableton Live 12.1-ben

Ezt a szimulált teszt nem tudja kiváltani. Minden lépés eredményét írd be a táblázatba (✅ igazolt / ❌ nem működik / ⚠ eltér), és ha valami ❌ vagy ⚠, add meg a pontos kimenetet.

**Szabály:** az elejétől a végéig egy **projektmásolaton** dolgozz (File → Save a Copy…), és előbb mentsd el az eredetit.

## Előkészület
- [docs/TELEPITES.md](TELEPITES.md) kész, `hangero ellenoriz` hibátlan.
- Live: Preferences → **Record, Warp & Launch → File Type: WAV** (a mérés WAV-ot olvas, AIFF-et nem).
- A Live ablaka legyen az előtérben a mérések alatt (háttérben a mérők 0-t mutathatnak).
- Válassz egy ~8 ütemes részt, ahol legalább egy sáv **hangereje automatizált**, és egy lágy és egy erős szakaszt.

## T1 – Kapcsolat és verzió *(elfogadási feltétel 1)*
`hangero ellenoriz` → írd le: a kiírt Live-verziót, az "Automatizálás" sort, a "Szerkezet" sort (sávok száma egyezik?).

## T2 – Melyik projekt, melyik rész *(2)*
Játszd le a lágy részt, `hangero vizsgal --szerep "lágy verze" --max-masodperc 20`. A jelentésben a projekt neve, az ütem- és ütésszám (**Szakasz**) egyezik azzal, amit az Abletonban látsz? Tempó, ütemmutató helyes?

## T3 – Automatizált sáv követése felülbírálás nélkül *(3)*
Olyan résszel, ahol egy sáv faderje automatizált:
1. Előtte: jegyezd fel az automatizálás kinézetét, és hogy a "Re-Enable Automation" gomb **nem** világít.
2. `hangero vizsgal …`
3. Jelentés: a sáv "Mozgó fader" sorban szerepel, eleje→vége érték a hallható/látható mozgással egyezik?
4. Utána: ugyanaz a görbe, a gomb továbbra sem világít, a jelentésben "felülbírált automatizálás" üres vagy változatlan.

## T4 – Szerkezet változatlan *(3, 6)*
A T2/T3 jelentésben: "A projekt szerkezeti ujjlenyomata … azonos". Nézd át a projektet: nincs új sáv, hangerő, kapcsoló.

## T5 – Hangmérés ellenőrző exporttal *(4)*
1. `hangero meres --szerep "erős refrén" --tol-utem N --utem 8` (N = kezdő ütem; indítsd a lejátszást néhány ütemmel előbb). Olvasd el a kiírt tervet, és erősítsd meg.
2. Mérés alatt ne nyúlj semmihez. A végén a mellékhatások és a "Ellenőrzés: … azonos" sor megjelenik.
3. Exportáld ugyanazt a részt kézzel: jelöld ki a 8 ütemet az Arrangementben (vagy loop-keret), File → Export Audio/Video, **Rendered Track: Master**, WAV, 24 bit, **Normalize: Off**, dither Off.
4. `hangero elemez "C:\...\export.wav"`
5. Hasonlítsd össze: integrált LUFS, true peak. **Várt eltérés:** pár tized LU (a felvétel kezdete néhány ms-t csúszhat, az export pontosan a kijelölésen kezdődik). Ha **>0,5 LU** vagy a true peak >0,5 dB eltér, ❌, és a két jelentést küldd el.

> A true peak számítás egyszerűsített 4x túlmintavételezés, a BS.1770 48-tapes szűrőjétől kb. 0,1 dB-re eltérhet. Ezt éppen ez a próba hivatott kideríteni.

## T6 – Lágy és erős külön *(5)*
Mérd mindkét részt külön (`--szerep "lágy verze"`, majd `"erős refrén"`). A jelentések külön fájlok, a szerep szerint eltérő megjegyzéssel. Az eszköz nem hozta egy szintre őket.
Utána: `hangero osszehasonlit lagy.json eros.json` (a "FIGYELEM: nem ugyanazt a részt" üzenet itt várt).

## T7 – Helyreállítás *(6)*
Mérés előtt jegyezd fel: melyik sávok vannak **arm**-olva, melyik sáv a **kijelölt**, a Main és a sávok hangereje, a mute/solo.
- **Normál lefutás után:** nincs `HANGERO MERES` sáv, arm/kijelölés/hangerők ugyanazok. A WAV ott van a `Samples\Recorded`-ban.
- **Megszakítás:** indíts `meres`-t, a felvétel közben nyomj **Ctrl+C**-t. Ugyanez az ellenőrzés.
- **Kemény megszakítás:** zárd be a parancssor ablakát a felvétel közben. Majd `hangero helyreallit`, és ugyanez az ellenőrzés.
- Ctrl+Z: nézd meg, mit tud visszavonni a Live. Jegyezd fel (ez egy ismert mellékhatás).

## T8 – Módosítás utáni újramérés *(7)*
Állíts a mixen egy dolgot (pl. egy EQ-t), mérd újra **ugyanazt** a részt ugyanazzal a `--tol-utem`/`--utem` értékkel, majd `hangero osszehasonlit elotte.json utana.json`. A különbség (LU) egyezik a füleddel?

## Eredménytábla

| Teszt | Elfogadási pont | Eredmény | Megjegyzés |
|---|---|---|---|
| T1 | 1 | | |
| T2 | 2 | | |
| T3 | 3 | | |
| T4 | 3, 6 | | |
| T5 | 4 | | |
| T6 | 5 | | |
| T7 | 6 | | |
| T8 | 7 | | |

## Ha valami nem megy

| Tünet | Valószínű ok |
|---|---|
| Minden mérő 0 | A Live nem az előtérben van, vagy a hangmotor ki van kapcsolva. |
| A mérés "néma" | Ugyanez; vagy a Main némítva van; vagy a Resampling nem engedélyezett a sávon. |
| `A felvételi fájl nem található` | A Live a fájlt máshová mentette; a jelentésben a fájlnevet látod, keresd a projekt `Samples\Recorded` mappájában, és `hangero elemez`-zel elemezd kézzel. |
| `Ez AIFF fájl` | Állítsd a felvételi fájltípust WAV-ra. |
| `HIBA … create / routing / launch` | A Remote Script 12.1-en nem támogat valamit: küldd el a pontos hibaüzenetet, ez a legértékesebb információ. |
| Maradt `HANGERO MERES` sáv | `hangero helyreallit` |

## Mit küldj vissza

A kitöltött táblázatot, a `hangero ellenoriz` teljes kimenetét, és hibánál a konzol szövegét plusz a jelentés `.json` fájlját (útvonalat nem tartalmaz).
