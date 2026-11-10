# HANDOFF – Hangerő-asszisztens (Ableton Live 12.1)

Utolsó frissítés: 2026-11-10. Repó: https://github.com/BlissDnD/ableton-hangero-asszisztens (publikus, a tulajdonos így akarja). Nyelv a felhasználóval: **magyar**. A felhasználó kezdő, Windowson dolgozik, Node.js 24 van. (Személyes jellegű háttér a felhasználó privát jegyzetében, nem ebben a publikus repóban.)

## 1. Cél (a felhasználó szavaival összegezve)
Ableton Live-hoz kapcsolódó AI hangerőasszisztens, hogy a zene hangerőviszonyait rendbe tehesse **screenshot és kézi WAV-export nélkül**, a meglévő automatizálások megtartásával. Első funkció: „Vizsgáld meg ezt a zenerészt". Hosszabb cél: az AI szerkeszthessen is (mixer, szekciók rendszerezése), de ez nem az MVP.

Diagnózis-szabályok (a kód és a jelentés is betartja): a halk rész nem hiba; a dal átlaga nem minősít; a legnagyobb mérő nem bizonyítja a forrást; magas csúcs ≠ kompresszor; külön **tény / feltételezés / javasolt ellenőrzés**; nincs automaster/újrakeverés; nem ígérünk profi mixet. Lágy és erős részeket **nem** egyenlítjük ki.

## 2. Hol tartunk

### Élőben igazolt (valódi Ableton Live 12.1, a felhasználó gépén)
- A telepítő bemásolja a Remote Scriptet, a Live **betölti** (Control Surface: AbletonMCP), a kapcsolat él.
- `ellenoriz` kimenete: Remote Script 3.0.0 / build `d44ac27ef137`; **Live 12.1**, Suite, Max for Live elérhető; 43 sáv (5 csoport), 2 return, 0 locator, 14 automatizált paraméter, 0 felülbírált; `exclusive_arm` be van kapcsolva; `introspect_api` alapú „klip-másolás" ellenőrzés **nem** adott eredményt (nem kritikus).
- Windowson a `Library.cfg` a User Library alatti **fájlra** mutatott (`…\User Library\Templates\tracklsv2.als`) – javítva (`normalizeLibrary`).

### Csak szimulált (mock) Live ellen tesztelt – 29 automatikus teszt zöld
`vizsgal` (csak olvas), `meres` (belső felvétel + LUFS/true peak + helyreállítás), `helyreallit`, jelentések, `osszehasonlit`, `telepit`. A WAV-elemző ismert jelekkel igazolt (EBU 3341-stílusú: 1 kHz, −23 dBFS sztereó → −23,0 LUFS; +10 dB → +10 LU; mono −3 LU; fs/4 inter-sample true peak; relatív kapu).

### Élőben NEM igazolt (a felhasználónak kell kipróbálnia; lásd `docs/TESZT-UTMUTATO.md`, T2–T8)
- `vizsgal` valódi `audio_snapshot` válaszformátuma 12.1-en (a mock a dokumentációból épült!). **Ez a legközelebbi kockázat.**
- Az `automation overview` / `get_automation` mezői valós projektben.
- `meres`: ideiglenes sáv létrehozása, `routing` Resampling, Session-slot felvétel Arrangement lejátszás közben, `launch record_length`, a klip `file_path`, `view.selected_track` visszaállítás, arm-visszaállítás (exclusive arm), törlés `expect` névvel.
- A WAV-hangosság egyezése egy kézi exporttal (elvárt eltérés pár tized LU; >0,5 LU = hiba). A true peak szűrő egyszerűsített (4x, ablakolt sinc), nem a BS.1770 48-tap szűrő; LRA nincs.
- A felvétel WAV formátuma (a Live fájltípus beállítása legyen WAV; AIFF-et az elemző elutasítja).

## 3. Döntések és indokok
- **Alap:** `whybothercoding/ableton-mcp-server` v3.0.0, commit `0a897bf48e032bdd31f36511701b2afaf655eabb`; **csak a Remote Script** van átvéve, változtatás nélkül a `vendor/AbletonMCP/`-be (MIT). Indok: Live 12+, **Max for Live nem kell**, minden olvasható adat megvan. Elvetve: `adamjmurray/producer-pal` (Max for Live + Live 12.3+ kell), `alaarab/livemcp` (nincs belső felvétel/hangmérés).
- **Nem használt upstream részek:** `measure` (Session-jelenet alapú, indítja/leállítja a klipeket, és alapból lehúzza a Main faderét 0,55-re), `bounce` (ffmpeg kell, nincs tartós napló), `npm run deploy` (macOS-útvonalak).
- **Saját kód:** függőségmentes Node.js (ESM), nincs ffmpeg/Python. TCP kliens a Remote Scripthez: `127.0.0.1:9877`, nyers JSON `{type, params}` → `{status, result|code,message}`, új kapcsolat kérésenként.
- **Saját szerkezeti ujjlenyomat** (`src/fingerprint.js`): az upstream `describe_set.fingerprint` hasheli a sávok hangerejét/panját/mute-ját, ami automatizáláskor lejátszás közben változik → hamis „módosult a projekt" riasztás. Kizárjuk ezeket.
- **A felvétel végét** a lejátszófej előrehaladásából és az `is_recording` jelzésből ismerjük fel, nem falióra alapján (tempóváltásnál sem csúszik).
- **Adatvédelem:** a jelentés alapból nem tartalmaz fájlútvonalat (a Windows-felhasználónevet hordozná); `--utvonal` kapcsolóval kerül bele.
- **Biztonság:** a Remote Script hitelesítés nélküli localhost port; az `eval`/`record` kapukat nem kapcsoljuk be.

## 4. Ismert korlátok (Live API)
Return sávok mérője 0-t ad (a jelentés „n/a"-nak jelzi, nem csendnek). Az Arrangement-automatizálás görbepontjai nem olvashatók (csak `playing`/`overridden`); ezért mintavételezzük a fader értékét lejátszás közben. Tempó-/ütemmutató-váltás az idővonalról nem olvasható (csak az aktuális érték; a tempót minden mintában olvassuk). Nem lehetséges az API-n át: időtartomány kijelölése/másolása/kivágása, klip vágása/átméretezése, tempóváltás beírása, csoportba rendezés, freeze, export, mentés. Automatizált paraméter kézi/AI átírása **felülbírálja** az automatizálást.

## 5. Következő lépések (prioritás szerint)
1. **Élő próba (a felhasználó):** `vizsgalat.bat` (vagy `hangero vizsgal --szerep "lágy verze"`) **projektmásolaton**, lejátszott 8 ütemes résszel. Ha a jelentés hibás/üres, a valós `audio_snapshot`/`get_automation` formátumot kell az `src/observe.js`-ben és az `src/analysis.js`-ben igazítani. Kérd el a konzol teljes kimenetét és a `jelentesek/*.json`-t.
2. T3 (automatizált sáv követése felülbírálás nélkül), T4, majd **T5 (`meres` + kézi export összevetés)**, T6, T7 (Ctrl+C és ablak-bezárás után `helyreallit`), T8. Az eredménytábla a `docs/TESZT-UTMUTATO.md`-ben van.
3. Hiba esetén: a kimenetből javítani, tesztet írni rá (`test/flow.test.js`, mock: `testkit/mock-live.js`), commit + push. **Ne állítsd élőben igazoltnak, amit nem láttál valós kimeneten.**
4. Fejlesztések (a felhasználó prioritása): előtte–utána összehasonlítás élőben; sáv/csoport célzott mérés (`meres --sav`, az upstream `routing` támogat `Post Mixer` forrást); referenciaszám hangerőillesztve; frekvenciaegyensúly/mélytartomány/sztereókorreláció/mono-ellenőrzés (a WAV-elemzőt bővítve); végül ellenőrzött, visszavonható hangerőmódosítás (csak jóváhagyással, nem automatizált paraméteren).
5. AI-általi szerkesztés: az upstream MCP-szerver ugyanazzal a Remote Scripttel (Claude Desktop). Külön telepítés, nem része az MVP-nek; részletek: `docs/ELEMZES.md` 5. szakasz.

## 6. Fájltérkép
```
README.md, HANDOFF.md, UPSTREAM.md, LICENSE
telepites.bat | ellenorzes.bat | vizsgalat.bat | hangero.cmd   (Windows dupla kattintás / parancs)
src/cli.js        parancsok: telepit, ellenoriz, vizsgal, meres, elemez, osszehasonlit, helyreallit, sugo
src/bridge.js     TCP kliens (127.0.0.1, ::1 fallback)
src/check.js      ellenoriz (verzió, képességek, hiányzó adatok)
src/observe.js    csak olvasó megfigyelés (audio_snapshot ciklus, readState)
src/analysis.js   összegzés + tény/feltételezés/ellenőrzés
src/measure.js    meres (ideiglenes sáv, Resampling felvétel, takarítás) + recover
src/journal.js    ~/.hangero-asszisztens/journal.json (megszakítás utáni helyreállítás)
src/audio.js      WAV-olvasó, K-súlyozás, LUFS (integrált/short-term/momentary), true peak, RMS
src/report.js     JSON + magyar Markdown jelentés, AI-szabályok, CSV
src/compare.js    osszehasonlit
src/install.js    telepit (User Library keresés Windowson, másolás, ellenőrzés)
src/fingerprint.js, src/time.js
vendor/AbletonMCP/  az upstream Remote Script (ne módosítsd; frissítés: UPSTREAM.md)
test/             29 teszt (node --test), testkit/mock-live.js a szimulált Live
docs/             TELEPITES.md, TESZT-UTMUTATO.md, ELEMZES.md, AI-HASZNALAT.md
```
Parancsok: `node --test` (tesztek), `npm run szimulator` (mock a 9877-en, Ableton nélküli próbához – **nem Ableton**), `node src/cli.js <parancs>`.

## 7. Környezeti tudnivalók a munkamenethez
- A felhőmunkamenetből **nincs** hozzáférés a felhasználó gépéhez/Abletonjához; minden élő eredményt ő hoz be (konzolkimenet beillesztése).
- A GitHub-proxy repó-szintű műveleteket enged (clone/commit/push); **új repó létrehozása és repó-beállítások (pl. láthatóság) tiltottak** – ezt a felhasználó kézzel csinálja. Új repó csak akkor látszik, ha a Claude GitHub App-nak van rá hozzáférése; `add_repo`-val kell a munkamenethez adni.
- A `git push` néha „push negotiation failed" figyelmeztetést ír, de lefut; mindig ellenőrizd `git fetch` + `rev-parse`-szal.
- A `musicassistant` repó a felhasználó másik projektje (Song Architect Studio), **ne nyúlj hozzá**.
- Commitokba a gép által megadott szerzőjelölés kerül; a jelentés/kód nem tartalmaz személyes adatot.

## 8. Élő próba eredménye (2026-11-10, Live 12.1)
- `vizsgal`: élőben OK (97 minta, 0 hiba, a projekt nem változott).
- `meres`: élőben lefutott (sáv létrehozás, Resampling felvétel, WAV, törlés, arm visszaállítás). 25–32. ütem: −17,45 LUFS, −4,91 dBTP.
- Kézi exporthoz (Master, 32 bit WAV) hasonlítva, hangra igazított szeletre: −17,50 LUFS (eltérés 0,05 LU, a küszöb 0,5), de a csúcs −3,99 vs −4,93 dBFS (kb. 0,9 dB, mintacsúcs is eltér). Az igazítás korrelációja csak 0,75: a kettő nem teljesen azonos tartalom (az export korábbi projektállapotból, vagy nem determinisztikus hangszerek). A true peak egyezése ezért **nem igazolt**; ismételt, azonos állapotú próba kell.
- Hiba javítva: a mérés saját ideiglenes sávja bekerült a `vizsgal` sávlistába (`observe.js` kiszűri).
- Megfigyelés: a `meres` 31,4 negyedet vett fel a kért 32 helyett; a `start_playback` + `current_song_time` beállítás futás közben működik, megállított állapotban a pozíció nem ugrik.
- Ismételhetőség: ugyanazon rész második `meres`-e −17,43 LUFS / −5,51 dBTP (az első −17,45 / −4,91). A LUFS ±0,02 LU-n belül stabil, a csúcs futásról futásra ~0,6 dB-t ingadozik (nem determinisztikus hangszerek/effektek, vagy kezdőpont-csúszás), tehát az export −3,99 dBFS csúcsa a zajon belül van. **Következtetés:** a LUFS-mérés élőben igazolt (0,05–0,07 LU eltérés a kézi exporttól); a true peak egyezése pontosan nem ellenőrizhető ilyen anyagon, a csúcsot nem szabad 1 dB-nél finomabbra venni. T5: LUFS ✅, true peak ⚠️ (zajhatár).
