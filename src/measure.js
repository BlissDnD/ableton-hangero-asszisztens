// "meres": rövid belső felvétel a Main kimenetről, majd valódi hangosságmérés (LUFS, true peak).
//
// NEM tisztán olvasó művelet. Ami változik, amíg fut:
//   1. létrejön egy ideiglenes audio sáv "HANGERO MERES" néven (a végén törlődik),
//   2. ennek bemenete Resampling, monitorozása OFF, és felvételre (arm) van állítva,
//   3. a Live exkluzív arm módja miatt más sávok arm állapota átmenetileg változhat (visszaállítjuk),
//   4. a Live kijelölt sávja a létrehozáskor átugorhat (visszaállítjuk),
//   5. a projekt Samples/Recorded mappájában egy WAV fájl marad (nem töröljük),
//   6. a Live Visszavonás (Ctrl+Z) listájában megjelennek az ideiglenes sáv lépései.
// A hangerőparamétereket, az automatizálást és a transportot NEM módosítjuk.
import fs from 'node:fs';
import { analyzeWavFile } from './audio.js';
import { observe } from './observe.js';
import { summarize } from './analysis.js';
import { clearJournal, readJournal, writeJournal } from './journal.js';
import { REQUIRED_MEASURE } from './check.js';
import { barToBeats, beatsToPosition, round } from './time.js';
import { structuralFingerprint } from './fingerprint.js';

export const SCRATCH_NAME = 'HANGERO MERES';
const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const SIDE_EFFECT_TEXTS = [
  'Ideiglenes audio sáv jött létre "HANGERO MERES" néven, majd törlődött.',
  'A felvétel WAV fájlja a projekt Samples/Recorded mappájában maradt (nem töröljük automatikusan).',
  'A Live Visszavonás (Ctrl+Z) listájában megjelentek az ideiglenes sáv létrehozásának/törlésének lépései. A mérés után ne használd közvetlenül a Ctrl+Z-t, mert az visszahozhatja az ideiglenes sávot.',
  'A projekt "módosított" jelölést kaphat a Live-ban (a sáv létrehozása/törlése miatt), de a tartalma ugyanaz.'
];

export function planText(o) {
  return [
    'A hangmérés EZT fogja csinálni:',
    `  1. Létrehoz egy ideiglenes audio sávot "${SCRATCH_NAME}" néven (Resampling bemenet, monitor OFF, arm).`,
    `  2. Felveszi a Main kimenetet ${o.beats} negyed hosszan (${o.bars} ütem) a lejátszás közben, a Live egy üres Session slotjába.`,
    '  3. A végén törli az ideiglenes sávot, és visszaállítja az arm állapotokat és a kijelölt sávot.',
    '  A hangerőkhöz, az automatizáláshoz és a lejátszási helyzethez NEM nyúl.',
    '  Mellékhatások: a WAV fájl a Samples/Recorded mappában marad; a Ctrl+Z lista bővül; a projekt "módosított" jelölést kaphat.',
    '  Fontos: a Live ablaka legyen az előtérben, a lejátszás fusson, és ne nyúlj a projekthez a mérés alatt.'
  ].join('\n');
}

async function playhead(bridge) {
  const r = await bridge.send('get_properties', { address: 'song', names: ['current_song_time', 'is_playing', 'tempo', 'signature_numerator', 'signature_denominator'] });
  return r.properties;
}

export async function measure(bridge, o = {}) {
  const opt = { role: '', bars: 8, fromBar: null, waitSeconds: 90, confirm: async () => true, log: () => {}, signal: undefined, sleep: sleepDefault, intervalMs: 200, ...o };
  const sideEffects = [];

  // ---------- előkészítés
  const info = await bridge.send('get_script_info');
  const caps = new Set(info.capabilities || []);
  const missing = REQUIRED_MEASURE.filter((c) => !caps.has(c));
  if (missing.length) throw new Error(`A hangméréshez hiányzó Remote Script parancsok: ${missing.join(', ')}.`);
  if (readJournal()?.status && readJournal().status !== 'done') {
    throw new Error('Egy korábbi mérés félbemaradt. Futtasd előbb: hangero helyreallit');
  }
  let song = await playhead(bridge);
  if (song.record_mode) throw new Error('Az Arrangement felvétel gomb be van kapcsolva. Kapcsold ki a mérés előtt.');
  const barBeats = (song.signature_numerator * 4) / song.signature_denominator;
  const beats = opt.bars * barBeats;
  if (!(beats >= 4 && beats <= 128)) throw new Error('A mérés 4 és 128 negyed közötti hosszú lehet (--utem 1…).');

  if (!(await opt.confirm({ beats, bars: opt.bars }))) throw new Error('A mérést megszakítottad, semmi sem változott.');

  const before = await bridge.send('describe_set', { include_clips: false, include_scenes: false });
  const viewBefore = await bridge.send('get_properties', { address: 'view', names: ['selected_track'] }).catch(() => null);
  const selectedBefore = viewBefore?.properties?.selected_track ?? null;
  const armedBefore = before.tracks.filter((t) => t.arm).map((t) => ({ address: t.address, name: t.name }));

  // várakozás a lejátszásra / a kezdő ütemre
  const fromBeat = opt.fromBar != null ? barToBeats(opt.fromBar, song.signature_numerator, song.signature_denominator) : null;
  const waitStart = Date.now();
  let announced = false;
  for (;;) {
    if (opt.signal?.aborted) throw new Error('Megszakítva a várakozás közben, semmi sem változott.');
    song = await playhead(bridge);
    const lead = song.tempo / 60 * 0.08; // 80 ms előretartás
    if (song.is_playing && (fromBeat == null || (song.current_song_time >= fromBeat - lead && song.current_song_time < fromBeat + barBeats))) break;
    if (!announced) {
      opt.log(fromBeat != null ? `Várom, hogy a lejátszás elérje a(z) ${opt.fromBar}. ütemet. Indítsd el a lejátszást néhány ütemmel előtte.` : 'Várom a lejátszást. Indítsd el az Abletonban (szóköz).');
      announced = true;
    }
    if ((Date.now() - waitStart) / 1000 > opt.waitSeconds) throw new Error(`${opt.waitSeconds} mp alatt nem indult el a lejátszás a kért helyen, semmi sem változott.`);
    await opt.sleep(40);
  }

  // ---------- változtatások (mindig a finally takarít)
  const state = { scratch: null, slot: null };
  const journal = { status: 'started', scratch_name: SCRATCH_NAME, scratch_address: null, armed_before: armedBefore, selected_track_before: selectedBefore, fingerprint_before: structuralFingerprint(before.set ?? before), started_at: new Date().toISOString() };
  writeJournal(journal);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opt.signal?.addEventListener('abort', onAbort);
  let observation = null;
  let measurement = null;
  const problems = [];

  try {
    const created = await bridge.send('create', { kind: 'audio_track', name: SCRATCH_NAME });
    state.scratch = created.address;
    journal.scratch_address = created.address;
    writeJournal(journal);
    state.slot = `${state.scratch}/slots/0`;

    await bridge.send('set_properties', { address: state.scratch, properties: { current_monitoring_state: 'OFF' } });
    await bridge.send('routing', { address: state.scratch, direction: 'input', action: 'set', type: 'Resampling', allow_feedback: true });
    await bridge.send('set_properties', { address: state.scratch, properties: { arm: true } });

    // megfigyelés a háttérben: ebből lesz a "ugyanakkor naplózott sávállapot"
    const recordSeconds = (beats * 60) / song.tempo;
    const observed = observe(bridge, {
      role: opt.role, intervalMs: opt.intervalMs, maxSeconds: recordSeconds + 25, waitSeconds: 5,
      signal: controller.signal, log: () => {}, sleep: opt.sleep
    }).catch((error) => { problems.push(`A háttérmegfigyelés hibázott: ${error.message}`); return null; });

    const before1 = await playhead(bridge);
    await bridge.send('launch', { address: state.slot, record_length: beats, quantization: 'q_no_q' });
    const after1 = await playhead(bridge);
    const startBeat = (before1.current_song_time + after1.current_song_time) / 2;
    const startUncertainty = Math.abs(after1.current_song_time - before1.current_song_time) / 2;
    opt.log(`Felvétel fut (${opt.bars} ütem)…`);

    // A felvétel végét a lejátszófej előrehaladásából és az is_recording jelzésből ismerjük fel (nem falióra alapján,
    // így tempóváltásnál sem csúszik el). A falióra csak végső biztonsági időkorlát.
    const deadline = Date.now() + ((beats * 60) / Math.max(song.tempo, 20)) * 1500 + 20000;
    let seenRecording = false;
    let endBeat = startBeat + beats;
    for (;;) {
      if (opt.signal?.aborted) throw new Error('A mérést megszakítottad (Ctrl+C). Az ideiglenes sávot törlöm.');
      const clip = await bridge.send('get_properties', { address: `${state.slot}/clip`, names: ['is_recording'] }).catch(() => null);
      const now = await playhead(bridge);
      const recording = clip ? Boolean(clip.properties.is_recording) : null;
      if (recording) seenRecording = true;
      if (clip && recording === false && (seenRecording || now.current_song_time >= startBeat + beats + 0.25)) break;
      if (!now.is_playing) {
        problems.push('A lejátszás a felvétel közben leállt: a felvétel rövidebb a tervezettnél, a mérés nem teljes.');
        endBeat = now.current_song_time;
        break;
      }
      if (Date.now() > deadline) throw new Error('A felvétel nem fejeződött be a tervezett idő után sem (időkorlát).');
      await opt.sleep(100);
    }

    const fileInfo = await bridge.send('get_properties', { address: `${state.slot}/clip`, names: ['file_path'] });
    const file = fileInfo.properties.file_path;
    controller.abort(); // a megfigyelés leáll
    observation = await observed;

    measurement = { source: 'Main kimenet (Resampling, post-fader)', file, startBeat, endBeat, startUncertainty, sig: { num: song.signature_numerator, den: song.signature_denominator }, tempo: song.tempo };
  } catch (error) {
    measurement = { error: error.message };
    if (!opt.signal?.aborted) problems.push(error.message);
  } finally {
    opt.signal?.removeEventListener('abort', onAbort);
    controller.abort();
    // ---------- takarítás
    const cleanup = async (label, fn, critical = true) => {
      try { await fn(); } catch (error) { problems.push(critical ? `VISSZAÁLLÍTÁSI HIBA (${label}): ${error.message}` : `Megjegyzés (${label}): ${error.message}`); }
    };
    if (state.scratch) {
      await cleanup('arm kikapcsolása', () => bridge.send('set_properties', { address: state.scratch, properties: { arm: false } }));
      await cleanup('ideiglenes sáv törlése', () => bridge.send('delete', { address: state.scratch, expect: { name: SCRATCH_NAME } }));
    }
    for (const t of armedBefore) {
      await cleanup(`arm visszaállítása: ${t.name}`, () => bridge.send('set_properties', { address: t.address, properties: { arm: true }, expect: { name: t.name } }));
    }
    if (selectedBefore) await cleanup('kijelölt sáv visszaállítása', () => bridge.send('set_properties', { address: 'view', properties: { selected_track: selectedBefore } }), false);
    let after = null;
    await cleanup('ellenőrző leolvasás', async () => { after = await bridge.send('describe_set', { include_clips: false, include_scenes: false }); });
    const restored = after ? structuralFingerprint(after) === journal.fingerprint_before : null;
    if (restored === false) problems.push('A projekt ujjlenyomata a mérés után eltér a mérés előttitől. Nézd át a sávokat, és futtasd: hangero helyreallit');
    const leftover = after ? after.tracks.filter((t) => t.name === SCRATCH_NAME).length : 0;
    if (leftover) problems.push(`Az ideiglenes sáv ("${SCRATCH_NAME}") még megvan. Futtasd: hangero helyreallit`);
    if (problems.some((p) => p.startsWith('VISSZAÁLLÍTÁSI') || leftover || restored === false)) {
      writeJournal({ ...journal, status: 'incomplete', problems });
    } else {
      clearJournal();
    }
    sideEffects.push(...SIDE_EFFECT_TEXTS);
    if (armedBefore.length) sideEffects.push(`Az arm állapot visszaállítva ezekre: ${armedBefore.map((t) => t.name).join(', ')}.`);
    sideEffects.push(restored === true ? 'Ellenőrzés: a projekt szerkezeti ujjlenyomata a mérés előtt és után azonos.' : restored === false ? 'Ellenőrzés: a projekt ujjlenyomata ELTÉR.' : 'Ellenőrzés: az utólagos leolvasás nem sikerült.');
    for (const p of problems) sideEffects.push(`Probléma: ${p}`);
  }

  // ---------- elemzés a Live-tól függetlenül (fájlból)
  let result = { measurement, session: observation, summary: null, sideEffects, problems };
  if (measurement && !measurement.error) {
    try {
      if (!fs.existsSync(measurement.file)) throw new Error(`A felvételi fájl nem található: ${measurement.file}. Ha a Live másik gépen/könyvtárban ment, add meg kézzel: hangero elemez <fajl.wav>`);
      const audio = analyzeWavFile(measurement.file);
      const { startBeat, endBeat, sig, tempo } = measurement;
      const approxTempo = tempo;
      const barLen = (sig.num * 4) / sig.den;
      const byBar = new Map();
      for (const w of audio.short_term?.series ?? []) {
        const beat = startBeat + (w.t * approxTempo) / 60;
        const bar = Math.floor(beat / barLen + 1e-9) + 1;
        if (w.lufs != null) byBar.set(bar, Math.max(byBar.get(bar) ?? -Infinity, w.lufs));
      }
      result.measurement = {
        source: measurement.source, file: measurement.file,
        range: {
          start: beatsToPosition(startBeat, sig.num, sig.den), end: beatsToPosition(endBeat, sig.num, sig.den),
          start_beat: round(startBeat), end_beat: round(endBeat), beats: round(endBeat - startBeat), start_uncertainty_beats: round(measurement.startUncertainty, 3)
        },
        audio,
        short_term_by_bar_approx: [...byBar.entries()].map(([bar, lufs]) => ({ bar, max_short_term_lufs: lufs })),
        note: 'A felvétel kezdőpontja a lejátszófej két leolvasásának átlaga (a bizonytalanság a start_uncertainty_beats). Az ütemekhez rendelés közelítő, állandó tempót feltételez.'
      };
      if (audio.silent) problems.push('A felvétel néma, a mérés nem használható (lásd a jegyzetet).');
    } catch (error) {
      result.measurement = { error: error.message };
      problems.push(error.message);
    }
  }

  if (observation && result.measurement && !result.measurement.error) {
    const { start_beat: s, end_beat: e } = result.measurement.range;
    const sliced = { ...observation, stopReason: 'a felvétel véget ért', samples: observation.samples.filter((x) => x.beat >= s - 0.01 && x.beat <= e + 0.01) };
    result.session = sliced;
    result.summary = summarize(sliced);
  } else if (observation) {
    result.summary = summarize(observation);
  }
  return result;
}

/** Félbemaradt mérés helyreállítása a napló és az ideiglenes sáv neve alapján. */
export async function recover(bridge, { log = () => {}, assumeYes = false } = {}) {
  const journal = readJournal();
  const lines = [];
  const set = await bridge.send('describe_set', { include_clips: false, include_scenes: false });
  const scratch = set.tracks.filter((t) => t.name === SCRATCH_NAME);
  if (!journal && !scratch.length) return { changed: false, lines: ['Nincs mit helyreállítani: nincs napló és nincs ideiglenes sáv.'] };
  if (!journal && scratch.length && !assumeYes) {
    return { changed: false, needsConfirm: true, lines: [`Találtam "${SCRATCH_NAME}" nevű sávot napló nélkül. Ha az az eszköz ideiglenes sávja, futtasd újra --igen kapcsolóval a törléséhez.`] };
  }
  for (const t of scratch) {
    try { await bridge.send('set_properties', { address: t.address, properties: { arm: false } }); } catch { /* nem kritikus */ }
    await bridge.send('delete', { address: t.address, expect: { name: SCRATCH_NAME } });
    lines.push(`Törölve az ideiglenes sáv: ${t.address}`);
  }
  for (const t of journal?.armed_before ?? []) {
    try {
      await bridge.send('set_properties', { address: t.address, properties: { arm: true }, expect: { name: t.name } });
      lines.push(`Arm visszaállítva: ${t.name}`);
    } catch (error) { lines.push(`Az arm nem állítható vissza (${t.name}): ${error.message}`); }
  }
  if (journal?.selected_track_before) {
    try { await bridge.send('set_properties', { address: 'view', properties: { selected_track: journal.selected_track_before } }); lines.push('Kijelölt sáv visszaállítva.'); } catch { /* nem kritikus */ }
  }
  const after = await bridge.send('describe_set', { include_clips: false, include_scenes: false });
  const same = journal?.fingerprint_before ? structuralFingerprint(after) === journal.fingerprint_before : null;
  lines.push(same === true ? 'Ellenőrzés: a projekt ujjlenyomata megegyezik a mérés előttivel.' : same === false ? 'Ellenőrzés: az ujjlenyomat még eltér (pl. mentetlen szerkesztés miatt is lehet). Nézd át a sávokat.' : 'Ellenőrzés: nincs összehasonlítási alap.');
  if (!after.tracks.some((t) => t.name === SCRATCH_NAME)) clearJournal();
  lines.push('A Samples/Recorded mappában maradt WAV fájlokat kézzel törölheted.');
  return { changed: true, lines };
}
