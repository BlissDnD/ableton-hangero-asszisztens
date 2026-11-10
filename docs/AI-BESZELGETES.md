# Beszélgetés az AI-val az Abletonról (MCP)

A `src/mcp.js` MCP-szervert indít, amin keresztül az AI (Claude Desktop vagy Claude Code) közvetlenül látja és szerkeszti a megnyitott projektet. Ableton + a Remote Script (lásd TELEPITES.md) legyen nyitva, `ellenorzes.bat` legyen zöld.

## Bekötés
- **Claude Code:** a mappában lévő `.mcp.json` automatikusan betölti (új munkamenetben jóváhagyást kér).
- **Claude Desktop:** `claude_desktop_config.json` → `mcpServers`:
  ```json
  { "mcpServers": { "hangero": { "command": "node", "args": ["C:\ÚTVONAL\ableton-hangero-asszisztens\src\mcp.js"] } } }
  ```
  Utána indítsd újra a Claude Desktopot.

## Eszközök
| Eszköz | Mire jó | Ír a projektbe? |
|---|---|---|
| `attekintes` | sávok, hangerők dB-ben, mute/solo, automatizált-e | nem |
| `arrangement` | ütem-blokkonként ki szól; sávonkénti klip-szakaszok | nem |
| `midi_olvas` | hangok, ritmusrács-pontosság, elcsúszott hangok, átfedések | nem |
| `midi_javit` | kvantálás, eltolás, transzponálás, velocity; alapból **előnézet** | csak `vegrehajt:true`-val |
| `hangero_allit` | hangerő (dB), pan, mute, solo; automatizáltat nem ír át | igen (visszavonható) |
| `visszavon` | az utolsó módosítások visszacsinálása | igen |
| `lejatszas` | indítás adott ütemtől, leállítás | nem |
| `vizsgal` | lejátszás közbeni megfigyelés, jelentés | nem |
| `meres` | LUFS / true peak (ideiglenes sávot hoz létre és töröl) | ideiglenesen |

## Biztonság
Minden módosítás a `~/.hangero-asszisztens/undo.json`-ba kerül (utolsó 50). Az automatizált paraméterek védettek. Nagy hangerőugrás megerősítést kér. Az idővonal klipjeinek létrehozása/mozgatása/vágása a Live API-n át **nem** lehetséges, ezt az AI javaslatként adja, kézzel kell megcsinálni.
