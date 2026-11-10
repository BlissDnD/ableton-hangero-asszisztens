# A terv szakmai átvilágítása

Forrás: a három jelölt repó README-je és kódja (a rögzített commitokon), valamint az EBU R128 / ITU-R BS.1770 szabványok ismert módszere. **Élő webes kutatást ebben a körben nem végeztem**; amit "ellenőrzött"-nek jelölök, az a letöltött kódban látható, nem Abletonban kipróbált.

## 1. Mit szeretnél elérni

Kezdőként rendbe tenni egy készülő zene hangerőviszonyait úgy, hogy a meglévő automatizálás megmarad, a szándékosan lágy és erős részek nem lesznek egyformák, és az AI **megértse** a projektet, anélkül hogy screenshotot készítenél vagy kézzel exportálnál. Hosszabb távon: az AI javasoljon, majd (óvatosan, visszavonhatóan) maga is nyúljon bele, rendszerezzen.

## 2. Hogyan felel meg ennek a megoldás

| Cél | Megoldás | Állapot |
|---|---|---|
| Ne kelljen screenshot | `vizsgal`: sávok, faderek, mute/solo/routing, automatizálás-állapot, mérők időbélyeggel, JSON + magyar összefoglaló | kész, szimulátoron tesztelt, **élőben nem** |
| Ne kelljen kézi export | `meres`: belső felvétel a Mainről + saját LUFS/true peak elemző | kész, elemző ismert jelekkel igazolt, **felvételi lánc élőben nem** |
| Automatizálás megmarad | a megfigyelés nem ír; a mérés csak ideiglenes sávot hoz létre; hangerőt soha nem ír (teszt őrzi) | kész, szimulátoron tesztelt |
| Lágy ≠ erős | szerep megadása, szerepfüggő értelmezés, külön jelentések, nincs szintegyenlítés | kész |
| Mért tény / feltételezés / ellenőrzés | a jelentés három külön szakasza | kész |
| Módosítás után újramérés | azonos `--tol-utem`/`--utem`, `osszehasonlit` | kész, élőben nem |
| AI tud szerkeszteni | **nem része az MVP-nek**; ugyanaz a Remote Script mellé az upstream MCP-szerver | lásd 5. |

## 3. A terv technikai feltételezéseinek ellenőrzése

| Feltételezés | Eredmény |
|---|---|
| A whybothercoding szerver Live 12.1-en fut | ⚠ A dokumentáció "Live 12 vagy újabb", 12.4-en fejlesztve. 12.1-en **nem igazolt**; az `ellenoriz` ezt jelzi, és az élő próba dönt. |
| Van `measure` (élő mérők figyelése) | ⚠ Van, de Session-jelenetekre épül, klipeket indít/állít le, és **alapból lehúzza a Main faderét** (0,55). Arrangement-alapú dalhoz és a "ne nyúlj semmihez" elvhez alkalmatlan, ezért nem használjuk. A mérőket a read-only `audio_snapshot`-ból vesszük. |
| Van `bounce` (belső felvétel + elemzés) | ⚠ Van (ideiglenes sáv, Resampling, Session-slot felvétel), de ffmpeg kell hozzá, és megszakításnál nincs tartós napló. Ugyanezt a módszert átvettük, de saját elemzővel és naplóval/helyreállítással. |
| Az automatizálás kiolvasható | ⚠ Részben. Az Arrangement-automatizálás **görbepontjai nem olvashatók**, csak az, hogy egy paraméter automatizált-e (`playing`) vagy felülbírált (`overridden`). A hangerő követéséhez ezért mintavételezzük a fader értékét lejátszás közben. |
| Tempó- és ütemmutató-váltások | ❌ Az idővonalon lévő váltások az API-ból nem olvashatók. A tempót minden mintában olvassuk (a Live az automatizált tempót követi), az ütemmutatót ritkábban; váltásnál a jelentés jelzi, hogy a pozíciók közelítők. |
| A mérők kalibrált dB-ben vannak | ❌ Nem: Live-egység (0,85 ≈ 0 dB fader-jelölés). Return sáv mérője 0. Ezért van külön, valódi mérés. |
| A `describe_set` ujjlenyomata jelzi a változást | ⚠ Az upstream ujjlenyomat a sávok **hangerejét, panját, mute-ját is hasheli**, ezek automatizáláskor lejátszás közben maguktól változnak, így hamis riasztást adna. Saját szerkezeti ujjlenyomatot használunk (`src/fingerprint.js`). |
| A telepítő Windowson is megy | ❌ Az upstream `npm run deploy` macOS-útvonalat keres. Saját `hangero telepit` van; a Library.cfg-alapú felismerés élőben nem igazolt, kézi `--konyvtar` a biztos út. |
| ffmpeg kell a hangelemzéshez | ✅ Egyszerűbben megoldható: saját WAV-elemző (BS.1770 K-súlyozás, EBU kapuzás, true peak). EBU 3341-stílusú ellenőrzés: 1 kHz, −23 dBFS sztereó → −23,0 LUFS (±0,15), +10 dB → +10 LU, mono −3 LU, fs/4 inter-sample csúcs, kapuzás. Nem ellenőrzött: a true peak szűrő a szabvány 48 tapes szűrőjétől eltérhet; LRA nincs. |
| A belső felvétel nem változtatja a lejátszást/automatizálást | ❓ **Élőben nem igazolt**, ez a T5/T7 teszt. A mérés a Main-ről (Resampling) vesz fel egy üres Session slotba; a hangerőkhöz nem nyúl. |
| Teljes Arrangement-szerkesztés (vágás, kijelölt rész másolása, tempó beírás) | ❌ A Live API nem engedi (lásd 5.). |

## 4. Problémás pontok és kockázatok

1. **Tört Ableton (legnagyobb bizonytalanság).** A segítséget a tört példány beszerzéséhez/üzemeltetéséhez nem tudok adni. Technikailag: a módosított telepítők néha eltérően kezelik a User Library-t, a Remote Scriptet vagy a Max/Python környezetet; ilyenkor a Remote Script nem töltődik be. Az `ellenoriz` ezt az első lépésben megmutatja. Hosszú távon: az Intro/Standard/Suite legális, a 12-es főverzió frissítései ingyenesek, van diák- és próbaverzió.
2. **Nem hitelesített helyi port.** A 127.0.0.1:9877 bármely helyi programnak parancsot ad a Live-ra (a Live a te felhasználóddal fut). Kívülről nem érhető el. Ne futtass megbízhatatlan programot, és az `eval`/`record` kapukat tartsd kikapcsolva.
3. **A mérés mellékhatásai.** Ideiglenes sáv, arm/kijelölés átmenet, a Ctrl+Z lista bővülése, megmaradó WAV, "módosított" jelölés. Csökkentés: napló + `helyreallit`, szerkezeti ujjlenyomat-ellenőrzés a mérés után, projektmásolaton kezdd.
4. **Exclusive arm.** Ha be van kapcsolva, az ideiglenes sáv armolása más sávok armját kikapcsolja; mi visszaállítjuk, de ezt a Live-ban láthatod egy pillanatra.
5. **A mérés csak hallható, lejátszott dolgot rögzít.** Fut a lejátszás, Live előtérben, hangmotor be. Nem gyorsabb a valós időnél.
6. **Kezdőpont-bizonytalanság.** A felvétel kezdetét a lejátszófej két leolvasásának átlagából becsüljük (a bizonytalanság a jelentésben). Az ütemekhez rendelés állandó tempót feltételez.
7. **Csúcs forrása.** A "mely sávok voltak hangosak a Main csúcsán" csak korreláció; a célzott sáv/csoport mérés még nincs kész (a Resampling helyett sáv `Post Mixer` forrás kell hozzá, az upstream támogatja, nálunk még nincs bekötve).
8. **Nyelv/kódolás.** Windows `cmd` régi kódlapján az ékezetek elcsúszhatnak: használd a Windows Terminalt, vagy `chcp 65001`. A jelentésfájlok UTF-8-ak.

## 5. Szerkesztés AI-val (amit a beszélgetésben kérdeztél)

Ugyanazzal a Remote Scripttel az upstream MCP-szervert is használhatod (Claude Desktop közvetlenül; ChatGPT-nél a helyi MCP-támogatás változó, a biztos út a jelentésfájl átadása). Ez **nem része ennek az MVP-nek**, külön telepítés, de a Remote Script ugyanaz.

| Működik (dokumentált, 12.1-en nem igazolt) | Korlátos | Nem megy (Live API) |
|---|---|---|
| mixer (hangerő, pan, send, mute/solo, routing), eszközparaméterek, eszköz betöltése/törlése/áthelyezése, sávok létrehozása/duplikálása/törlése/átnevezése/színezése, MIDI-hangjegyek szerkesztése, Session-klipek, minden módosítás egy Ctrl+Z lépés | **Automatizált paraméter átírása felülbírálja az automatizálást.** Locatorok: olvasás, átnevezés, ugrás; tetszőleges helyre lerakni nem. Arrangement-klip: olvasás, átnevezés, törlés, új létrehozása; áthelyezés csak másolás+törlés trükkel (a `duplicate_clip_to_arrangement` megléte az `ellenoriz` kimenetében látszik). Plugin: csak a Live-ban "Configure"-ral kiválasztott paraméterek | időtartomány kijelölése/másolása/kivágása, klip vágása/átméretezése, tempó- és ütemmutató-váltás beírása az idővonalra, sávok csoportba rendezése, freeze, export, mentés |

Következmény: "szekciók rendszerezése" részben megoldható (locator-átnevezés, színezés, sávsorrend, MIDI), a "vágd ki a 2. refrént és tedd a végére" típusú idővonal-szerkesztés nem megbízható. Hangerő-módosítási javaslat: **automatizált paramétert ne az AI írjon át**, hanem mondja meg, mit módosíts az automatizálási görbén; nem automatizált paramétert (pl. EQ-sáv, send) visszavonható lépésben változtathat.

## 6. Fejlesztési lehetőségek (prioritási sorrend a tervedből)

1. ✅ *Előtte–utána összehasonlítás* — alap kész (`osszehasonlit`); élőben ellenőrizendő. Bővíthető sávonkénti LUFS-sel.
2. *Sáv/csoport célzott mérés* — a `bounce` upstream támogatja a `source: tracks/N` + `Post Mixer` felvételt; nálunk a `meres --sav` kapcsoló a következő lépés. Szükséges hozzá a csúcs forrásának megerősítése.
3. *Referenciaszám hangerőillesztett összehasonlítása* — a `hangero elemez` már számol LUFS-t; kell: referencia WAV betöltése, hangerőillesztés (a referencia LUFS-hez normalizálva), spektrum-összevetés. Elégséges rá a WAV-elemző.
4. *Frekvenciaegyensúly, mélytartomány, sztereókorreláció, mono-kompatibilitás* — a WAV-elemző bővítése: FFT-sávok, L/R korreláció, mid/side energia, mono összegzési veszteség. Ugyanazon a felvételen futtatható, Abletont nem érinti.
5. *Visszavonható hangerőmódosítás* — csak jóváhagyás után, nem automatizált paraméteren, `expect` névvel védve, előtte-utána mérés. Automatizált sávnál: javaslat, nem beavatkozás.

További, nem a tervben szereplő ötletek: LRA (loudness range) a szekciókhoz; a short-term görbe ütemenkénti megjelenítése; jelentés-séma verziózása (megvan: `hangero-jelentes/1`) és JSON Schema; automatikus "mérd le az összes locator-szakaszt egymás után" üzemmód; UI-automatizálás (AutoHotkey) az API által nem engedett idővonal-műveletekhez — törékeny, csak később és óvatosan.

## 7. Amit szándékosan nem csináltunk

Automaster, automatikus újrakeverés, minden plugin belsejének megértése, dashboard. A jelentés nem ad minőségi ítéletet ("jó/rossz mix").
