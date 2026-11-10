#!/usr/bin/env node
// MCP-szerver (stdio): az AI (Claude Desktop / Claude Code) ezen keresztül beszél az Abletonnal.
// Függőségmentes. Csak stderr-re logolunk, a stdout a protokollé.
//
// Biztonsági elvek:
//  - minden írás naplózódik (undo.json) és a `visszavon` eszközzel visszacsinálható
//  - automatizált paramétert nem írunk át, hacsak kifejezetten nem kérik (`felulbiral`)
//  - a MIDI-szerkesztés alapból csak előnézet (`vegrehajt: true` kell az íráshoz)
//  - nagy hangerőugrás csak `nagy_valtoztatas: true`-val
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Bridge } from './bridge.js';
import { runCheck } from './check.js';
import { observe } from './observe.js';
import { summarize } from './analysis.js';
import { buildReport, renderMarkdown, writeReport } from './report.js';
import { measure, planText } from './measure.js';
import { journalDir } from './journal.js';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridge = new Bridge({ port: Number(process.env.HANGERO_PORT) || 9877 });

// ---------- hangerő: fader érték <-> dB (a Live kijelzőjéről gyűjtött pontok, szakaszos interpoláció) ----------
const FADER_TABLE = [
  [0.3909, -18.4], [0.5749, -11.0], [0.6, -10.0], [0.6475, -8.1], [0.7025, -5.9], [0.7249, -5.0], [0.7517, -3.931],
  [0.79, -2.4], [0.8075, -1.7], [0.85, 0], [0.94, 3.6], [1, 6]
];
export function faderToDb(v) {
  if (v <= 0) return -Infinity;
  if (v <= FADER_TABLE[0][0]) return FADER_TABLE[0][1] - (FADER_TABLE[0][0] - v) * 60; // durva, csak jelzés
  for (let i = 1; i < FADER_TABLE.length; i += 1) {
    const [v1, d1] = FADER_TABLE[i];
    const [v0, d0] = FADER_TABLE[i - 1];
    if (v <= v1) return d0 + ((v - v0) / (v1 - v0)) * (d1 - d0);
  }
  return 6;
}
export function dbToFader(db) {
  if (db >= 6) return 1;
  if (db <= FADER_TABLE[0][1]) return null; // táblázaton kívül: nem állítjuk pontosan
  for (let i = 1; i < FADER_TABLE.length; i += 1) {
    const [v1, d1] = FADER_TABLE[i];
    const [v0, d0] = FADER_TABLE[i - 1];
    if (db <= d1) return v0 + ((db - d0) / (d1 - d0)) * (v1 - v0);
  }
  return 1;
}
const r2 = (x) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 100) / 100);

// ---------- undo napló ----------
const undoFile = () => path.join(journalDir(), 'undo.json');
function readUndo() { try { return JSON.parse(fs.readFileSync(undoFile(), 'utf8')); } catch { return []; } }
function writeUndo(list) { fs.mkdirSync(journalDir(), { recursive: true }); fs.writeFileSync(undoFile(), JSON.stringify(list.slice(-50), null, 2)); }
function pushUndo(label, ops) { const l = readUndo(); l.push({ ts: new Date().toISOString(), label, ops }); writeUndo(l); }

// ---------- segédek ----------
async function automatedTracks() {
  const a = await bridge.send('get_automation', {});
  const set = new Set();
  for (const e of a.automated || []) set.add(`${e.track}|${e.name || e.parameter || ''}|${e.state}`);
  return (a.automated || []);
}
function isVolumeOrPanAutomated(list, track, param) {
  const re = param === 'volume' ? /volume|hangerő|vol/i : /pan/i;
  return list.some((e) => (e.track === track.name || e.track === track.address) && re.test(String(e.name || e.parameter || '')) );
}
function findTracks(set, selectors) {
  const all = [...set.tracks.map((t, i) => ({ ...t, address: t.address ?? `tracks/${i}` })), ...(set.returns || []).map((t, i) => ({ ...t, address: t.address ?? `returns/${i}` }))];
  const out = [];
  for (const sel of selectors) {
    const s = String(sel).trim();
    let hit = all.filter((t) => t.address === s);
    if (!hit.length) hit = all.filter((t) => t.name === s);
    if (!hit.length) hit = all.filter((t) => t.name?.toLowerCase().includes(s.toLowerCase()));
    if (!hit.length) throw new Error(`Nincs ilyen sáv: "${sel}"`);
    if (hit.length > 1 && !s.includes('*')) {
      // több egyezés: név szerinti pontos egyezés előnyben, különben jelezzük
      const exact = hit.filter((t) => t.name?.toLowerCase() === s.toLowerCase());
      if (exact.length === 1) hit = exact; else throw new Error(`"${sel}" több sávra illik: ${hit.map((t) => `${t.address} (${t.name})`).join(', ')}. Add meg a címet.`);
    }
    out.push(...hit);
  }
  return out;
}
const beatsPerBar = (set) => (set.song.signature_numerator || 4) * (4 / (set.song.signature_denominator || 4));
const beatToBar = (b, bpb) => Math.round((b / bpb + 1) * 100) / 100;
const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });

// ---------- eszközök ----------
const TOOLS = [];
const tool = (name, description, properties, required, fn) => TOOLS.push({ name, description, inputSchema: { type: 'object', properties, required }, fn });

tool('attekintes',
  'A projekt áttekintése: tempó, ütemmutató, sávok (cím, név, típus, csoport, hangerő dB-ben, pan, mute, solo, hány klip van az idővonalon), returnök, Main. Ezzel kezdj, ha nem ismered a projektet.',
  { csak_csoport: { type: 'string', description: 'Csak ennek a csoportnak a sávjai (név szerint), opcionális' } }, [],
  async (a) => {
    const set = await bridge.send('describe_set', { include_clips: false, include_scenes: false });
    const aut = await automatedTracks().catch(() => []);
    const rows = set.tracks.map((t, i) => ({ cim: t.address ?? `tracks/${i}`, nev: t.name, tipus: t.kind, csoport: t.group ?? null, hangero_db: r2(faderToDb(t.volume)), pan: r2(t.panning), mute: t.mute, solo: t.solo, idovonal_klip: t.arrangement_count ?? 0, automatizalt: aut.some((e) => e.track === t.name || e.track === (t.address ?? `tracks/${i}`)) }))
      .filter((r) => !a.csak_csoport || r.csoport === a.csak_csoport);
    return text({
      projekt: { tempo: r2(set.song.tempo), utemmutato: `${set.song.signature_numerator}/${set.song.signature_denominator}`, lejatszas: set.song.is_playing, hossz_negyed: set.song.loop_length },
      sav_szam: rows.length, savok: rows,
      returnok: (set.returns || []).map((t, i) => ({ cim: t.address ?? `returns/${i}`, nev: t.name, hangero_db: r2(faderToDb(t.volume)) })),
      main: set.master ? { hangero_db: r2(faderToDb(set.master.volume)) } : null,
      megjegyzes: 'hangero_db a Live fader-kijelzőjéhez igazított közelítés (±0,1 dB). Az automatizált sávok hangerejét nem érdemes kézzel állítani.'
    });
  });

tool('arrangement',
  'Az idővonal (Arrangement) szerkezete: melyik sávon hol vannak (nem némított) klipek, ütemekben (1-től számolva). Ütem-blokkonként kimutatja, hány sáv szól, így látszik, hol épül fel vagy ritkul a szerkezet.',
  { blokk_utem: { type: 'number', description: 'Blokkméret ütemben (alap 4)' }, sav: { type: 'string', description: 'Csak ez a sáv (név vagy cím), opcionális' }, csoport: { type: 'string', description: 'Csak ez a csoport, opcionális' } }, [],
  async (a) => {
    const set = await bridge.send('describe_set', { include_scenes: false });
    const bpb = beatsPerBar(set);
    const block = a.blokk_utem || 4;
    let tracks = set.tracks.map((t, i) => ({ ...t, address: t.address ?? `tracks/${i}` }));
    if (a.sav) tracks = findTracks(set, [a.sav]);
    if (a.csoport) tracks = tracks.filter((t) => t.group === a.csoport);
    // klip-intervallumok sávonként (némítottak külön)
    const per = [];
    let endBeat = 0;
    for (const t of tracks) {
      const clips = (t.arrangement || []).map((c) => ({ s: c.start, e: c.start + c.length, name: c.name, index: c.index }));
      if (!clips.length) continue;
      endBeat = Math.max(endBeat, ...clips.map((c) => c.e));
      // a describe_set nem adja a klip mute-ját; a track info igen (arrangement_clips[].muted)
      let muted = null;
      try { const info = await bridge.send('get_track_info', { track_index: Number(t.address.split('/')[1]) }); muted = (info.arrangement_clips || []).map((c) => c.muted); } catch { /* nem kritikus */ }
      const active = clips.filter((c, i) => !(muted && muted[i]));
      const merged = [];
      for (const c of active.sort((x, y) => x.s - y.s)) {
        const last = merged[merged.length - 1];
        if (last && c.s <= last.e + 0.01) last.e = Math.max(last.e, c.e); else merged.push({ s: c.s, e: c.e });
      }
      per.push({ cim: t.address, nev: t.name, csoport: t.group ?? null, klip_osszesen: clips.length, nemitott_klip: muted ? muted.filter(Boolean).length : '?', szolo_szakaszok_utem: merged.map((m) => `${beatToBar(m.s, bpb)}–${beatToBar(m.e, bpb)}`), _m: merged });
    }
    const totalBars = Math.ceil(endBeat / bpb);
    const blocks = [];
    for (let b = 0; b < totalBars; b += block) {
      const s = b * bpb; const e = (b + block) * bpb;
      const names = per.filter((p) => p._m.some((m) => m.s < e && m.e > s)).map((p) => p.nev);
      blocks.push({ utem: `${b + 1}–${b + block}`, szolo_savok: names.length, nevek: names.length <= 14 ? names : `${names.slice(0, 14).join(', ')} …` });
    }
    return text({ osszes_utem: totalBars, tempo: r2(set.song.tempo), blokkok: blocks, savok: per.map(({ _m, ...r }) => r) });
  });

tool('midi_olvas',
  'MIDI-klip beolvasása és elemzése. Cím pl. "tracks/24/arrangement/3" (idővonal-klip) vagy "tracks/5/slots/2/clip". Megmutatja: hangok száma, hangmagasság-tartomány, ritmusrács-pontosság (16-od), a rácsról lecsúszott hangok, egységes elcsúszás, átfedések, ütemenkénti sűrűség.',
  { cim: { type: 'string' }, racs: { type: 'number', description: 'Ritmusrács negyedben (alap 0.25 = 16-od)' }, max_hang: { type: 'number', description: 'Legfeljebb ennyi nyers hang a válaszban (alap 60)' }, tolerancia: { type: 'number', description: 'Rács-tolerancia negyedben (alap 0.03)' } }, ['cim'],
  async (a) => text(await analyzeMidi(a.cim, a.racs || 0.25, a.tolerancia ?? 0.03, a.max_hang ?? 60)));

async function readNotes(address) {
  const r = await bridge.send('get_notes', { address, limit: 5000 });
  return r;
}
async function analyzeMidi(address, grid, tol, maxNotes) {
  const r = await readNotes(address);
  const notes = r.notes;
  const clip = r.clip || {};
  if (!notes.length) return { cim: address, hangok: 0, klip: clip };
  const dev = notes.map((n) => { const snapped = Math.round(n.start_time / grid) * grid; return { n, snapped, d: n.start_time - snapped }; });
  const off = dev.filter((x) => Math.abs(x.d) > tol);
  const med = [...dev.map((x) => x.d)].sort((x, y) => x - y)[Math.floor(dev.length / 2)];
  const pitches = notes.map((n) => n.pitch);
  const byBar = {};
  for (const n of notes) { const b = Math.floor(n.start_time / 4) + 1; byBar[b] = (byBar[b] || 0) + 1; }
  let overlaps = 0;
  const byPitch = {};
  for (const n of notes) (byPitch[n.pitch] ||= []).push(n);
  for (const list of Object.values(byPitch)) { list.sort((x, y) => x.start_time - y.start_time); for (let i = 1; i < list.length; i += 1) if (list[i].start_time < list[i - 1].start_time + list[i - 1].duration - 0.001) overlaps += 1; }
  return {
    cim: address, klip: clip,
    hangok: notes.length, hangmagassag: { min: Math.min(...pitches), max: Math.max(...pitches) },
    velocity: { min: Math.min(...notes.map((n) => n.velocity)), max: Math.max(...notes.map((n) => n.velocity)) },
    racs: { negyed: grid, tolerancia: tol, racson_van: notes.length - off.length, racson_kivul: off.length, racson_szazalek: Math.round(((notes.length - off.length) / notes.length) * 100) },
    egyseges_elcsuszas_negyed: Math.abs(med) > tol ? r2(med) : 0,
    elcsuszott_peldak: off.slice(0, 15).map((x) => ({ id: x.n.id, hang: x.n.pitch, kezdet: r2(x.n.start_time), javasolt: r2(x.snapped), elteres: r2(x.d) })),
    atfedo_azonos_magassagu_hangok: overlaps,
    hang_utemenkent: byBar,
    hangok_lista: notes.slice(0, maxNotes).map((n) => ({ id: n.id, p: n.pitch, t: r2(n.start_time), d: r2(n.duration), v: Math.round(n.velocity) })),
    megjegyzes: 'Az "elcsúszott" hang nem feltétlenül hiba (swing, humanizálás, szándékos hármas-érzet). A javítás előtt hallgassátok meg.'
  };
}

tool('midi_javit',
  'MIDI-hangok javítása egy klipben. Alapból csak ELŐNÉZET; az íráshoz vegrehajt:true kell. Műveletek: kvantal (rácshoz igazítás, erosseg 0–1), eltol (egységes csúsztatás negyedben), transzponal (félhangok), hangero (velocity szorzó). Minden írás visszavonható a visszavon eszközzel.',
  { cim: { type: 'string' }, muvelet: { type: 'string', enum: ['kvantal', 'eltol', 'transzponal', 'hangero'] }, racs: { type: 'number', description: 'kvantal: rács negyedben (alap 0.25)' }, erosseg: { type: 'number', description: 'kvantal: 0–1 (alap 1 = teljesen a rácsra)' }, csak_elcsuszottak: { type: 'boolean', description: 'kvantal: csak a tolerancián kívüli hangok (alap igaz)' }, tolerancia: { type: 'number' }, ertek: { type: 'number', description: 'eltol: negyed; transzponal: félhang; hangero: szorzó' }, vegrehajt: { type: 'boolean' } }, ['cim', 'muvelet'],
  async (a) => {
    const r = await readNotes(a.cim);
    const notes = r.notes;
    if (!notes.length) return text('A klipben nincsenek hangok.');
    const grid = a.racs || 0.25; const tol = a.tolerancia ?? 0.03; const strength = a.erosseg ?? 1;
    const changes = [];
    for (const n of notes) {
      let patch = null;
      if (a.muvelet === 'kvantal') {
        const snapped = Math.round(n.start_time / grid) * grid; const d = snapped - n.start_time;
        if ((a.csak_elcsuszottak ?? true) && Math.abs(d) <= tol) continue;
        if (Math.abs(d) < 1e-6) continue;
        patch = { start_time: n.start_time + d * strength };
      } else if (a.muvelet === 'eltol') {
        if (typeof a.ertek !== 'number') throw new Error('eltol: add meg az ertek-et (negyed)');
        patch = { start_time: n.start_time + a.ertek };
      } else if (a.muvelet === 'transzponal') {
        if (typeof a.ertek !== 'number') throw new Error('transzponal: add meg az ertek-et (félhang)');
        const p = n.pitch + Math.round(a.ertek); if (p < 0 || p > 127) continue; patch = { pitch: p };
      } else if (a.muvelet === 'hangero') {
        if (typeof a.ertek !== 'number') throw new Error('hangero: add meg az ertek-et (szorzó)');
        patch = { velocity: Math.min(127, Math.max(1, n.velocity * a.ertek)) };
      }
      if (patch) changes.push({ id: n.id, ...patch, _before: { start_time: n.start_time, pitch: n.pitch, velocity: n.velocity } });
    }
    const preview = changes.slice(0, 12).map((c) => ({ id: c.id, elotte: c._before, utana: Object.fromEntries(Object.entries(c).filter(([k]) => !['id', '_before'].includes(k))) }));
    if (!a.vegrehajt) return text({ elonezet: true, erintett_hangok: changes.length, osszes_hang: notes.length, peldak: preview, kovetkezo: 'Ha jó, hívd újra ugyanezekkel és vegrehajt:true-val.' });
    if (!changes.length) return text('Nincs mit módosítani.');
    for (let i = 0; i < changes.length; i += 200) {
      await bridge.send('edit_notes', { address: a.cim, action: 'modify', changes: changes.slice(i, i + 200).map(({ _before, ...c }) => c) });
    }
    pushUndo(`midi_javit ${a.muvelet} ${a.cim}`, changes.map((c) => ({ type: 'note_modify', address: a.cim, id: c.id, before: c._before })));
    return text({ kesz: true, modositott_hangok: changes.length, visszavonas: 'visszavon eszköz' });
  });

tool('hangero_allit',
  'Sáv hangerejének/panjának/mute/solo állítása. Egyszerre több sáv is. A hangerő dB-ben adható (−18,4 … +6). Automatizált hangerőt/pant nem írunk át, hacsak felulbiral:true (ez felülírja az automatizálást a Live-ban!). Nagy (>6 dB) változtatáshoz nagy_valtoztatas:true kell. Visszavonható.',
  { savok: { type: 'array', items: { type: 'object', properties: { sav: { type: 'string', description: 'cím (tracks/3) vagy név' }, hangero_db: { type: 'number' }, relativ_db: { type: 'number', description: 'a mostanihoz képest' }, pan: { type: 'number', description: '−1 … 1' }, mute: { type: 'boolean' }, solo: { type: 'boolean' } }, required: ['sav'] } }, felulbiral: { type: 'boolean' }, nagy_valtoztatas: { type: 'boolean' } }, ['savok'],
  async (a) => {
    const set = await bridge.send('describe_set', { include_clips: false, include_scenes: false });
    const aut = await automatedTracks().catch(() => []);
    const ops = []; const done = []; const skipped = [];
    for (const item of a.savok) {
      let t;
      try { [t] = findTracks(set, [item.sav]); } catch (e) { skipped.push({ sav: item.sav, ok: e.message }); continue; }
      const patch = {}; const before = {};
      let target = null;
      if (typeof item.hangero_db === 'number') target = item.hangero_db;
      if (typeof item.relativ_db === 'number') target = faderToDb(t.volume) + item.relativ_db;
      if (target != null) {
        if (isVolumeOrPanAutomated(aut, t, 'volume') && !a.felulbiral) { skipped.push({ sav: t.name, ok: 'a hangerő automatizált – nem írom át (felulbiral:true-val igen, de az felülírja az automatizálást)' }); continue; }
        const v = dbToFader(target);
        if (v == null) { skipped.push({ sav: t.name, ok: `${target} dB a táblázaton kívül van (−18,4 dB alatt nem állítok pontosan)` }); continue; }
        const delta = Math.abs(target - faderToDb(t.volume));
        if (delta > 6 && !a.nagy_valtoztatas) { skipped.push({ sav: t.name, ok: `${r2(delta)} dB változás: nagy_valtoztatas:true kell hozzá` }); continue; }
        before.volume = t.volume; patch.volume = Math.round(v * 10000) / 10000;
      }
      if (typeof item.pan === 'number') {
        if (isVolumeOrPanAutomated(aut, t, 'pan') && !a.felulbiral) { skipped.push({ sav: t.name, ok: 'a pan automatizált – nem írom át' }); continue; }
        before.panning = t.panning; patch.panning = Math.max(-1, Math.min(1, item.pan));
      }
      if (typeof item.mute === 'boolean') { before.mute = t.mute; patch.mute = item.mute; }
      if (typeof item.solo === 'boolean') { before.solo = t.solo; patch.solo = item.solo; }
      if (!Object.keys(patch).length) continue;
      await bridge.send('set_properties', { address: t.address, properties: patch });
      ops.push({ type: 'set_props', address: t.address, before });
      done.push({ sav: t.name, cim: t.address, uj: { ...(patch.volume != null ? { hangero_db: r2(faderToDb(patch.volume)) } : {}), ...(patch.panning != null ? { pan: patch.panning } : {}), ...(patch.mute != null ? { mute: patch.mute } : {}), ...(patch.solo != null ? { solo: patch.solo } : {}) }, regi: { ...(before.volume != null ? { hangero_db: r2(faderToDb(before.volume)) } : {}) } });
    }
    if (ops.length) pushUndo('hangero_allit', ops);
    return text({ beallitva: done, kihagyva: skipped, visszavonas: ops.length ? 'visszavon eszköz' : undefined });
  });

tool('visszavon', 'Az utolsó N módosítás-csomag (hangerő/MIDI) visszacsinálása.', { db: { type: 'number', description: 'Hány csomagot (alap 1)' } }, [],
  async (a) => {
    const list = readUndo(); const n = Math.min(a.db || 1, list.length);
    if (!n) return text('Nincs visszavonható módosítás.');
    const undone = [];
    for (let k = 0; k < n; k += 1) {
      const entry = list.pop();
      for (const op of [...entry.ops].reverse()) {
        if (op.type === 'set_props') await bridge.send('set_properties', { address: op.address, properties: op.before });
        if (op.type === 'notes_remove') await bridge.send('edit_notes', { address: op.address, action: 'remove', ids: op.ids });
        if (op.type === 'notes_add') await bridge.send('write_notes', { address: op.address, notes: op.notes });
        if (op.type === 'clip_muted') {
          const { arr } = await trackClips(op.track);
          const c = arr.find((x) => Math.abs(x.start - op.start) < EPS && x.name === op.name);
          if (c) await bridge.send('set_properties', { address: `tracks/${op.track}/arrangement/${c.index}`, properties: { muted: op.before } });
        }
        if (op.type === 'clip_delete_by_start') await deleteArrangementClip(op.track, op.name, op.start);
        if (op.type === 'clip_restore') await placeMidiClip(op.track, op.saved, op.saved.start);
        if (op.type === 'note_modify') await bridge.send('edit_notes', { address: op.address, action: 'modify', changes: [{ id: op.id, ...op.before }] });
      }
      undone.push(entry.label);
    }
    writeUndo(list);
    return text({ visszavonva: undone });
  });

tool('lejatszas', 'Lejátszás indítása/leállítása, opcionálisan adott ütemtől (1-től számolva).', { muvelet: { type: 'string', enum: ['indit', 'leallit'] }, utem: { type: 'number' } }, ['muvelet'],
  async (a) => {
    if (a.muvelet === 'leallit') { await bridge.send('stop_playback', {}); return text('Leállítva.'); }
    const set = await bridge.send('describe_set', { include_clips: false, include_scenes: false });
    await bridge.send('start_playback', {});
    if (typeof a.utem === 'number') { await new Promise((r) => setTimeout(r, 600)); await bridge.send('set_properties', { address: 'song', properties: { current_song_time: (a.utem - 1) * beatsPerBar(set) } }); }
    return text(`Elindítva${a.utem ? ` a(z) ${a.utem}. ütemtől` : ''}.`);
  });

tool('vizsgal', 'Csak olvasó megfigyelés lejátszás közben (sávmérők, fader-mozgás, mute, automatizálás): jelentést ad. Ha a lejátszás nem fut, a tol_utem előtt kell indítani (lejatszas eszköz).', { szerep: { type: 'string', description: 'A rész szerepe, pl. "lágy verze", "erős refrén"' }, tol_utem: { type: 'number' }, ig_utem: { type: 'number' }, max_masodperc: { type: 'number' } }, [],
  async (a) => {
    const check = await runCheck(bridge);
    if (!check.ok) return text('A kapcsolat nem működik – futtasd az ellenorzes.bat-ot.');
    const session = await observe(bridge, { role: a.szerep ?? '', fromBar: a.tol_utem, toBar: a.ig_utem, maxSeconds: a.max_masodperc ?? 40, waitSeconds: 60, intervalMs: 200, log: () => {} });
    const summary = summarize(session);
    const report = buildReport({ session, summary, check });
    const files = writeReport(report, path.join(ROOT, 'jelentesek'));
    return text(`${renderMarkdown(report)}\n\n(Mentve: ${files.mdPath})`);
  });

tool('meres', 'Valódi hangosságmérés a Main kimenetről (LUFS, true peak, RMS). FIGYELEM: ideiglenes audio sávot hoz létre és töröl a projektben (visszavonási lista bővül). A lejátszásnak futnia kell, vagy add meg a tol_utem-et és indítsd a lejatszas eszközzel.', { szerep: { type: 'string' }, utem: { type: 'number', description: 'Hány ütemet vegyen fel (alap 8)' }, tol_utem: { type: 'number' } }, [],
  async (a) => {
    const check = await runCheck(bridge);
    if (!check.ok) return text('A kapcsolat nem működik – futtasd az ellenorzes.bat-ot.');
    const result = await measure(bridge, { role: a.szerep ?? '', bars: a.utem ?? 8, fromBar: a.tol_utem, intervalMs: 200, waitSeconds: 60, log: () => {}, confirm: async () => true });
    const session = result.session ?? { project: { name: '', file_path: '' }, role: a.szerep ?? '', samples: [], meta: {} };
    const summary = result.summary ?? { findings: [], limits: [], window: null };
    const report = buildReport({ session: { ...session, role: a.szerep ?? session.role }, summary, check, measurement: result.measurement, sideEffects: result.sideEffects });
    const files = writeReport(report, path.join(ROOT, 'jelentesek'));
    return text(`${renderMarkdown(report)}\n\n(Mentve: ${files.mdPath})`);
  });

// ---------- idővonal-klipek (Arrangement) és MIDI-hangok szerkesztése ----------
const EPS = 0.01;
async function trackClips(trackIdx) {
  const info = await bridge.send('get_track_info', { track_index: trackIdx });
  const arr = (info.arrangement_clips || []).map((c, i) => ({ index: i, name: c.name, start: c.start_time, length: c.length, end: c.start_time + c.length, muted: c.muted, midi: c.is_midi_clip }));
  return { info, arr };
}
async function setupContext(savSel) {
  const set = await bridge.send('describe_set', { include_clips: false, include_scenes: false });
  const [t] = findTracks(set, [savSel]);
  if (!t.address.startsWith('tracks/')) throw new Error('Csak normál sávon működik.');
  return { set, t, ti: Number(t.address.split('/')[1]), bpb: beatsPerBar(set) };
}
function pickClip(arr, bar, bpb) {
  const beat = (bar - 1) * bpb;
  const hit = arr.filter((c) => c.start <= beat + EPS && c.end > beat + EPS);
  if (!hit.length) throw new Error(`Nincs klip a(z) ${bar}. ütemnél ezen a sávon.`);
  return hit[0];
}
async function snapshotMidiClip(ti, c) {
  const addr = `tracks/${ti}/arrangement/${c.index}`;
  const notes = (await bridge.send('get_notes', { address: addr, limit: 5000 })).notes.map(({ id, ...n }) => n);
  const p = (await bridge.send('get_properties', { address: addr, names: ['name', 'looping', 'loop_start', 'loop_end', 'start_marker', 'end_marker', 'muted', 'length'] })).properties;
  return { start: c.start, name: c.name, notes, props: p };
}
/** MIDI-klip tartalmát átmeneti Session-klipen át teszi az idővonalra a megadott pozícióra; az átmeneti klipet törli. */
async function placeMidiClip(ti, saved, destBeat) {
  const info = await bridge.send('get_track_info', { track_index: ti });
  const slotIdx = (info.clip_slots || []).findIndex((s) => !s.has_clip);
  if (slotIdx < 0) throw new Error('Nincs üres Session-slot ezen a sávon az átmeneti klipnek. Ürítsd ki az egyik slotot.');
  const slotClip = `tracks/${ti}/slots/${slotIdx}/clip`;
  const p = saved.props;
  await bridge.send('create_clip', { track_index: ti, clip_index: slotIdx, length: Math.max(0.25, p.length, p.loop_end || 0) });
  try {
    if (saved.notes.length) await bridge.send('write_notes', { address: slotClip, notes: saved.notes });
    await bridge.send('set_properties', { address: slotClip, properties: { looping: p.looping, loop_start: p.loop_start, loop_end: p.loop_end, start_marker: p.start_marker, end_marker: p.end_marker } });
    const placed = await bridge.send('clip_action', { address: slotClip, action: 'to_arrangement', time: destBeat });
    try { await bridge.send('set_properties', { address: placed.address, properties: { name: p.name, muted: p.muted } }); } catch { /* név/némítás nem kritikus */ }
    return placed;
  } finally {
    try {
      const nm = (await bridge.send('get_properties', { address: slotClip, names: ['name'] })).properties.name;
      await bridge.send('delete', { address: slotClip, expect: { name: nm } });
    } catch (e) { console.error('átmeneti klip törlése sikertelen:', e.message); }
  }
}
async function deleteArrangementClip(ti, name, start) {
  const { arr } = await trackClips(ti);
  const c = arr.find((x) => Math.abs(x.start - start) < EPS && x.name === name);
  if (!c) throw new Error('A törlendő klip már nincs ott.');
  await bridge.send('delete', { address: `tracks/${ti}/arrangement/${c.index}`, expect: { name } });
}

tool('klip_muvelet',
  'Idővonal (Arrangement) MIDI-klipek: masol (másolat a cel_utem-re), athelyez (másolás + az eredeti törlése), torol, nemit. Helyek ütemben (1-től); a klipet az ütemszámával jelöld ki (bármely ütem, ahol a klip van). Alapból csak ELŐNÉZET (vegrehajt:true kell). Ha a cél terület foglalt, megáll (felulir:true felülírja, a Live a fedett részt kitörli!). Audio-klipet nem tud másolni/mozgatni (API-korlát), csak némítani. Visszavonható (visszavon). Működéséhez a sávon kell egy üres Session-slot.',
  { muvelet: { type: 'string', enum: ['masol', 'athelyez', 'torol', 'nemit'] }, sav: { type: 'string' }, klip_utem: { type: 'number', description: 'Melyik klipet: az az ütem, ahol a klip van (1-től)' }, cel_utem: { type: 'number', description: 'masol/athelyez: hova (1-től)' }, ismetles: { type: 'number', description: 'masol: ennyi másolat egymás után (alap 1)' }, nemitva: { type: 'boolean', description: 'nemit: igaz = némít, hamis = némítás megszüntetése' }, felulir: { type: 'boolean' }, vegrehajt: { type: 'boolean' } }, ['muvelet', 'sav', 'klip_utem'],
  async (a) => {
    const { t, ti, bpb } = await setupContext(a.sav);
    const { arr } = await trackClips(ti);
    const src = pickClip(arr, a.klip_utem, bpb);
    const desc = { sav: t.name, klip: src.name, kezdet_utem: beatToBar(src.start, bpb), veg_utem: beatToBar(src.end, bpb), hossz_utem: r2(src.length / bpb), tipus: src.midi ? 'midi' : 'audio', nemitva: src.muted };
    if (a.muvelet === 'nemit') {
      const target = a.nemitva ?? true;
      if (!a.vegrehajt) return text({ elonezet: true, klip: desc, uj_nemitva: target });
      await bridge.send('set_properties', { address: `tracks/${ti}/arrangement/${src.index}`, properties: { muted: target } });
      pushUndo(`klip nemit ${t.name}`, [{ type: 'clip_muted', track: ti, name: src.name, start: src.start, before: src.muted }]);
      return text({ kesz: true, klip: desc, uj_nemitva: target });
    }
    if (a.muvelet === 'torol') {
      if (!a.vegrehajt) return text({ elonezet: true, torolni_fog: desc });
      if (!src.midi) throw new Error('Audio-klipet nem törlök, mert visszavonni nem tudnám (nincs tartalom-mentés). Töröld kézzel, vagy némítsd.');
      const saved = await snapshotMidiClip(ti, src);
      await deleteArrangementClip(ti, src.name, src.start);
      pushUndo(`klip torol ${t.name}`, [{ type: 'clip_restore', track: ti, saved }]);
      return text({ kesz: true, torolve: desc, visszavonas: 'visszavon' });
    }
    if (!src.midi) throw new Error('Audio-klipet az API nem tud másolni/mozgatni az idővonalon (csak MIDI-t). Kézzel, vagy .als-másolaton át lehetséges.');
    if (typeof a.cel_utem !== 'number') throw new Error('Add meg a cel_utem-et.');
    const times = Math.max(1, Math.round(a.ismetles || 1));
    const destBeat0 = (a.cel_utem - 1) * bpb;
    const plans = [];
    for (let k = 0; k < times; k += 1) plans.push({ s: destBeat0 + k * src.length, e: destBeat0 + (k + 1) * src.length });
    const others = arr.filter((c) => !(a.muvelet === 'athelyez' && c.index === src.index));
    const conflicts = plans.flatMap((pl) => others.filter((c) => c.start < pl.e - EPS && c.end > pl.s + EPS).map((c) => `${c.name} (${beatToBar(c.start, bpb)}–${beatToBar(c.end, bpb)}. ütem)`));
    const unique = [...new Set(conflicts)];
    const out = { elonezet: !a.vegrehajt, muvelet: a.muvelet, forras: desc, uj_helyek_utem: plans.map((pl) => `${beatToBar(pl.s, bpb)}–${beatToBar(pl.e, bpb)}`), foglalt_terulet: unique.length ? unique : 'nincs' };
    if (!a.vegrehajt) return text(out);
    if (unique.length && !a.felulir) return text({ ...out, elonezet: false, megallt: 'A cél terület foglalt. Válassz üres helyet, vagy felulir:true (a Live kitörli a fedett részt, és azt a visszavon nem hozza vissza).' });
    const saved = await snapshotMidiClip(ti, src);
    const ops = [];
    for (const pl of plans) {
      await placeMidiClip(ti, saved, pl.s);
      ops.push({ type: 'clip_delete_by_start', track: ti, name: saved.props.name, start: pl.s });
    }
    if (a.muvelet === 'athelyez') {
      await deleteArrangementClip(ti, src.name, src.start);
      ops.push({ type: 'clip_restore', track: ti, saved });
    }
    pushUndo(`klip ${a.muvelet} ${t.name}`, ops);
    return text({ ...out, elonezet: false, kesz: true, visszavonas: 'visszavon' });
  });

tool('midi_hangok',
  'MIDI-hangok hozzáadása, törlése, másolása klipek között. Alapból ELŐNÉZET (vegrehajt:true az íráshoz). Műveletek: hozzaad (hangok:[{p:hangmagasság 0–127, t:kezdet negyedben a klip elejétől, d:hossz negyedben, v:velocity}]), torol (idk, vagy tartomány: tol_negyed/ig_negyed és/vagy hangmagassag_min/max), masol (forrás klip tartományából a cel_cim klipbe, eltolas_negyed-del). Visszavonható.',
  { cim: { type: 'string', description: 'A klip címe (pl. tracks/24/arrangement/3)' }, muvelet: { type: 'string', enum: ['hozzaad', 'torol', 'masol'] }, hangok: { type: 'array', items: { type: 'object', properties: { p: { type: 'number' }, t: { type: 'number' }, d: { type: 'number' }, v: { type: 'number' } }, required: ['p', 't', 'd'] } }, idk: { type: 'array', items: { type: 'number' } }, tol_negyed: { type: 'number' }, ig_negyed: { type: 'number' }, hangmagassag_min: { type: 'number' }, hangmagassag_max: { type: 'number' }, cel_cim: { type: 'string' }, eltolas_negyed: { type: 'number' }, vegrehajt: { type: 'boolean' } }, ['cim', 'muvelet'],
  async (a) => {
    const inRange = (n) => (a.tol_negyed == null || n.start_time >= a.tol_negyed - 1e-6) && (a.ig_negyed == null || n.start_time < a.ig_negyed - 1e-6) && (a.hangmagassag_min == null || n.pitch >= a.hangmagassag_min) && (a.hangmagassag_max == null || n.pitch <= a.hangmagassag_max);
    const strip = ({ id, ...n }) => n;
    if (a.muvelet === 'hozzaad') {
      if (!Array.isArray(a.hangok) || !a.hangok.length) throw new Error('hangok: nem üres lista kell.');
      const notes = a.hangok.map((h) => ({ pitch: Math.round(h.p), start_time: h.t, duration: h.d, velocity: h.v ?? 100 }));
      if (!a.vegrehajt) return text({ elonezet: true, hozzaadna: notes.length, peldak: a.hangok.slice(0, 10) });
      const r = await bridge.send('write_notes', { address: a.cim, notes });
      pushUndo(`midi_hangok hozzaad ${a.cim}`, [{ type: 'notes_remove', address: a.cim, ids: r.ids }]);
      return text({ kesz: true, hozzaadva: r.written, visszavonas: 'visszavon' });
    }
    const all = (await readNotes(a.cim)).notes;
    if (a.muvelet === 'torol') {
      if (!a.idk && a.tol_negyed == null && a.ig_negyed == null && a.hangmagassag_min == null && a.hangmagassag_max == null) throw new Error('Add meg, mit töröljek (idk, vagy tol_negyed/ig_negyed/hangmagassag_*).');
      const victims = a.idk ? all.filter((n) => a.idk.includes(n.id)) : all.filter(inRange);
      if (!a.vegrehajt) return text({ elonezet: true, torolne: victims.length, osszes: all.length, peldak: victims.slice(0, 10).map((n) => ({ id: n.id, p: n.pitch, t: r2(n.start_time), d: r2(n.duration) })) });
      if (!victims.length) return text('Nincs a feltételnek megfelelő hang.');
      await bridge.send('edit_notes', { address: a.cim, action: 'remove', ids: victims.map((n) => n.id) });
      pushUndo(`midi_hangok torol ${a.cim}`, [{ type: 'notes_add', address: a.cim, notes: victims.map(strip) }]);
      return text({ kesz: true, torolve: victims.length, visszavonas: 'visszavon' });
    }
    if (a.muvelet === 'masol') {
      if (!a.cel_cim) throw new Error('Add meg a cel_cim-et.');
      const picked = all.filter(inRange).map((n) => ({ ...strip(n), start_time: n.start_time - (a.tol_negyed ?? 0) + (a.eltolas_negyed ?? 0) }));
      const bad = picked.filter((n) => n.start_time < 0);
      if (bad.length) throw new Error(`${bad.length} hang negatív kezdetű lenne – igazítsd az eltolas_negyed-et.`);
      if (!a.vegrehajt) return text({ elonezet: true, masolna: picked.length, cel: a.cel_cim, peldak: picked.slice(0, 8).map((n) => ({ p: n.pitch, t: r2(n.start_time), d: r2(n.duration) })), megjegyzes: 'A cél kezdete = eredeti kezdet − tol_negyed + eltolas_negyed.' });
      if (!picked.length) return text('Nincs a tartományban hang.');
      const r = await bridge.send('write_notes', { address: a.cel_cim, notes: picked });
      pushUndo(`midi_hangok masol ${a.cim} -> ${a.cel_cim}`, [{ type: 'notes_remove', address: a.cel_cim, ids: r.ids }]);
      return text({ kesz: true, masolva: r.written, visszavonas: 'visszavon' });
    }
    throw new Error('Ismeretlen művelet.');
  });

// ---------- MCP protokoll ----------
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'hangero', version: '0.2.0' }, instructions: 'Ableton Live hangerő- és arrangement-asszisztens. Kezdd az attekintes eszközzel. Írás előtt mondd el a felhasználónak, mit fogsz változtatni; minden módosítás visszavonható (visszavon). A halk rész nem hiba; ne egyenlítsd ki a lágy és erős részeket.' } });
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return undefined;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ fn, ...t }) => t) } });
  if (method === 'tools/call') {
    const t = TOOLS.find((x) => x.name === params?.name);
    if (!t) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Ismeretlen eszköz: ${params?.name}` } });
    try { return send({ jsonrpc: '2.0', id, result: await t.fn(params.arguments || {}) }); }
    catch (e) { return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `Hiba: ${e.message}` }] } }); }
  }
  if (id != null) return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Nem támogatott: ${method}` } });
  return undefined;
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('mcp.js')) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => { if (!line.trim()) return; let m; try { m = JSON.parse(line); } catch { return; } handle(m).catch((e) => console.error(e)); });
}
