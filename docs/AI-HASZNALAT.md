# Használat bármelyik AI-val (ChatGPT, Claude, Gemini…)

A jelentés szándékosan **fájl**, nem élő kapcsolat: így ugyanúgy működik mindenhol, és nem kell hozzá semmilyen integráció.

## 1. Jelentés készítése
```bash
hangero vizsgal --szerep "lágy verze"
```
Indítsd el az Abletonban a lejátszást a vizsgált rész előtt, hagyd futni, állítsd le. A `jelentesek/` mappában két fájl jön létre:
- `jelentes_…md` – embernek (és az AI-nak is jó),
- `jelentes_…json` – géppel feldolgozható (`--nyers`-sel mellé CSV a mintákkal).

Valódi hangosság kell? `hangero meres --szerep "erős refrén" --tol-utem 57 --utem 8` (előbb olvasd el a README mellékhatás-részét; kezdd projektmásolaton).

## 2. Átadás az AI-nak
Másold be a `.md` fájl teljes tartalmát (vagy töltsd fel a `.json`-t), és írd mellé:

```
Ez egy Ableton-zenerész hangerő-jelentése. A felhasználó kezdő, a zenén dolgozik.
Kövesd a jelentés végén lévő "AI-nak szóló szabályokat".
Feladat: 1) foglald össze 3 mondatban, mit látsz; 2) külön sorold fel, mi a mért tény,
mi a feltételezés, és mi a javasolt következő ellenőrzés; 3) ne javasolj olyan változtatást,
amit a mérések nem támasztanak alá; 4) az automatizált sávoknál ne azt mondd, hogy írjam át a
faderét, hanem hogy az automatizálási görbén mit érdemes megnézni. A rész szerepe: <lágy verze / erős refrén>.
```

Egy ugyanazon rész módosítás előtti–utáni kiértékeléséhez: `hangero osszehasonlit elotte.json utana.json`, és az eredményt (vagy mindkét jelentést) add az AI-nak.

## 3. Mit ne várj
- A `vizsgal` számai (0–1 mérő) **nem dB-k**; csak egymással összevethetők.
- Az AI innen "hall", nem valódi hangot. A `meres` ad hangosságot (LUFS, true peak), spektrumot egyelőre nem.
- Az AI-nak nem szabad ítéletet mondania a mixről a jelentés alapján; a szabályok ezt a jelentésben is rögzítik.

## 4. Mi van a Claude Code / Claude Desktop + MCP útvonallal?
Ha az AI-nak *vezérelnie* is kell az Abletont (mixer, eszközök, MIDI), az upstream MCP-szerver ugyanezen a Remote Scripten át teszi (lásd [ELEMZES.md](ELEMZES.md) 5. szakasz). Ehhez külön telepítés kell, és a ChatGPT-nél a helyi MCP-támogatás a termékváltozattól függ — a jelentésfájl átadása ott a biztos út. Ezt az MVP nem tartalmazza.
