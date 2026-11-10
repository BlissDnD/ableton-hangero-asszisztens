// A naplózott megfigyelésből összegzés és "tény / feltételezés / ellenőrzés" bontású megállapítások.
// Szándékosan NEM minősíti a mixet: a halk rész nem hiba, az átlag nem ítélet, a legnagyobb mérő nem bizonyíték.
import { beatsToPosition, round } from './time.js';

const ACTIVE_LEVEL = 0.01; // Live-egység; efölött a sávot "szólónak" tekintjük a mérő szerint
const ZERO_DB_MARK = 0.85; // a Live fadereken ez a 0 dB jelölés, a mérőskála NEM kalibrált dBFS

const max = (a) => a.reduce((m, v) => (v > m ? v : m), -Infinity);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const percentile = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

export function roleHint(role) {
  const r = String(role || '').toLowerCase();
  if (/lágy|lagy|halk|csendes|soft|quiet|intro|bridge|break/.test(r)) return 'soft';
  if (/erős|eros|hangos|refrén|refren|chorus|drop|loud|build/.test(r)) return 'strong';
  return 'unknown';
}

export function summarize(session) {
  const samples = session.samples;
  const findings = [];
  const limits = [
    'A mérőértékek a Live saját (nem kalibrált) skáláján vannak: a 0,85 a fader 0 dB jelölése, nem dBFS, RMS vagy LUFS. Valódi hangosság a "meres" lépésből jön.',
    'A mérő a lekérdezés pillanatában olvasott érték. Két lekérdezés között rövid csúcsok kimaradhatnak.',
    'A return sávok mérőjét a Live API nem adja ki (0-t mutat), erről nincs adat. A hiányzó adat nem csend.',
    'Az idővonalon lévő tempó- és ütemmutató-váltások az API-ból nem olvashatók; a mintavételezett aktuális értékeket használjuk.'
  ];
  const summary = { limits, findings };

  if (!samples.length) {
    summary.empty = true;
    findings.push({ type: 'tény', text: `Nem készült mintavétel (${session.stopReason}).` });
    return summary;
  }

  // --- ablak
  const sig = lastSignature(session);
  const startBeat = samples[0].beat;
  const endBeat = samples[samples.length - 1].beat;
  const tempos = samples.map((s) => s.tempo);
  const signatures = uniqueSignatures(session);
  const wallSeconds = (samples[samples.length - 1].ms - samples[0].ms) / 1000;
  const tempoChanged = max(tempos) - Math.min(...tempos) > 0.01;
  const projectSeconds = tempoChanged ? integrateSeconds(samples) : ((endBeat - startBeat) * 60) / (tempos[0] || 120);
  summary.window = {
    start_beat: round(startBeat), end_beat: round(endBeat),
    start: beatsToPosition(startBeat, sig.num, sig.den), end: beatsToPosition(endBeat, sig.num, sig.den),
    beats: round(endBeat - startBeat),
    bars: round((endBeat - startBeat) / ((sig.num * 4) / sig.den), 2),
    wall_seconds: round(wallSeconds, 1),
    project_seconds_estimate: round(projectSeconds, 1),
    tempo_min: round(Math.min(...tempos), 2), tempo_max: round(max(tempos), 2), tempo_changed: tempoChanged,
    signatures, signature_changed: signatures.length > 1,
    stop_reason: session.stopReason
  };

  // --- mintavétel minősége
  const intervals = [];
  for (let i = 1; i < samples.length; i += 1) intervals.push(samples[i].ms - samples[i - 1].ms);
  summary.sampling = {
    count: samples.length,
    interval_mean_ms: round(mean(intervals), 0), interval_p95_ms: round(percentile(intervals, 0.95), 0), interval_max_ms: round(intervals.length ? max(intervals) : 0, 0),
    failed_requests: session.gaps.length
  };

  // --- sávok
  const tracks = [];
  const addresses = Object.keys(session.meta);
  const groupOf = groupLookup(session.structure);
  for (const address of addresses) {
    const meta = session.meta[address];
    const isReturn = meta.kind === 'return';
    const levels = samples.map((s) => Math.max(s.tracks[address]?.[0] ?? 0, s.tracks[address]?.[1] ?? 0));
    const faders = samples.map((s) => s.tracks[address]?.[2]).filter((v) => v != null);
    const fi = session.faderInfo[address] || {};
    const mutes = samples.map((s) => s.tracks[address]?.[3] ?? 0);
    const solos = samples.map((s) => s.tracks[address]?.[5] ?? 0);
    const silenced = samples.map((s) => s.tracks[address]?.[4] ?? 0);
    const faderRange = faders.length ? max(faders) - Math.min(...faders) : 0;
    tracks.push({
      address, name: meta.name, kind: meta.kind, group: groupOf[address] ?? null,
      meter: isReturn
        ? { available: false, note: 'a Live API a return mérőjét nem adja ki' }
        : { available: true, peak: round(max(levels)), mean: round(mean(levels)), active_share: round(levels.filter((v) => v > ACTIVE_LEVEL).length / levels.length, 3) },
      fader: faders.length
        ? {
            first: round(fi.first, 4), last: round(fi.last, 4), min: round(fi.min, 4), max: round(fi.max, 4),
            first_display: fi.firstDisplay ?? null, last_display: fi.lastDisplay ?? null, min_display: fi.minDisplay ?? null, max_display: fi.maxDisplay ?? null,
            moved: faderRange > 0.002
          }
        : null,
      mute_changed: new Set(mutes).size > 1, muted_whole_time: mutes.every((v) => v === 1),
      solo_changed: new Set(solos).size > 1, silenced_by_solo_whole_time: silenced.every((v) => v === 1),
      output: meta.output, output_changed: Boolean(meta.outputChanged)
    });
  }
  summary.tracks = tracks;

  // --- Main
  const mainLevels = samples.map((s) => Math.max(s.tracks.master?.[0] ?? 0, s.tracks.master?.[1] ?? 0));
  const mainPeak = max(mainLevels);
  const mainPeakIndex = mainLevels.indexOf(mainPeak);
  summary.main = {
    peak: round(mainPeak), mean: round(mean(mainLevels)), p95: round(percentile(mainLevels, 0.95)),
    peak_at: beatsToPosition(samples[mainPeakIndex].beat, sig.num, sig.den), peak_at_beat: round(samples[mainPeakIndex].beat),
    per_bar: perBar(samples, mainLevels, sig)
  };

  // --- automatizálás és szerkezet
  const before = session.automation_before;
  const after = session.automation_after;
  summary.automation = {
    automated_count: before.automated_count,
    overridden_before: before.overridden,
    overridden_after: after?.overridden ?? null,
    newly_overridden: after ? after.overridden.filter((a) => !before.overridden.some((b) => b.track === a.track && b.parameter === a.parameter && b.device === a.device)) : null
  };
  summary.project_unchanged = session.fingerprint_after == null ? null : session.fingerprint_after === session.fingerprint_before;

  // ---------------- megállapítások ----------------
  const winText = `${summary.window.start.text} → ${summary.window.end.text}`;
  findings.push({
    type: 'tény',
    text: `Megfigyelt szakasz: ${winText} (${summary.window.beats} negyed, kb. ${summary.window.bars} ütem, ${summary.window.wall_seconds} mp valós idő). Tempó: ${summary.window.tempo_min}${tempoChanged ? `–${summary.window.tempo_max}` : ''} BPM. Leállás oka: ${session.stopReason}.`
  });
  if (summary.window.signature_changed) {
    findings.push({ type: 'tény', text: `Az ütemmutató a megfigyelés alatt változott (${signatures.map((s) => `${s.num}/${s.den}`).join(' → ')}); az ütem/ütés pozíciók a változás után közelítők.` });
  }
  findings.push({
    type: 'tény',
    text: `${samples.length} mintavétel, átlagosan ${summary.sampling.interval_mean_ms} ms közökkel (legnagyobb rés ${summary.sampling.interval_max_ms} ms).` + (session.gaps.length ? ` ${session.gaps.length} lekérdezés hibázott.` : '')
  });
  if (summary.sampling.interval_mean_ms > 400) {
    findings.push({ type: 'feltételezés', text: 'A mintavétel ritka (400 ms fölötti átlag), ezért rövid csúcsok valószínűleg kimaradtak.', check: 'Zárj be más programokat, vagy állíts kisebb --kozonkent értéket.' });
  }

  const everyMeterZero = tracks.filter((t) => t.meter.available).every((t) => t.meter.peak === 0);
  if (everyMeterZero) {
    findings.push({
      type: 'feltételezés',
      text: 'Minden mérő végig 0-t mutatott lejátszás közben. Ez nem csend: a Live háttérben nem frissíti a mérőket, vagy a hangmotor ki van kapcsolva.',
      check: 'Hozd előtérbe az Ableton ablakát, és ellenőrizd a hangkimenetet (Preferences → Audio), majd ismételd meg.'
    });
  } else {
    findings.push({
      type: 'tény',
      text: `A Main mérője a szakaszban legfeljebb ${summary.main.peak}, átlagosan ${summary.main.mean} volt (Live-egység, nem kalibrált), a csúcs ${summary.main.peak_at.text} környékén.`
    });
    if (mainPeak > ZERO_DB_MARK) {
      findings.push({
        type: 'feltételezés',
        text: `A Main mérője a 0,85-ös (0 dB fader-jelölés) fölé ment, ami lehet 0 dBFS fölötti jel, de a skála kalibrálatlan, ezért ez nem bizonyított.`,
        check: 'A "meres" lépés true peak értéke eldönti. A magas csúcs önmagában nem ok kompresszorra.'
      });
    }
    // csúcs forrása: csak gyanú
    const top = peakSuspects(samples, mainLevels, tracks);
    if (top.length) {
      findings.push({
        type: 'feltételezés',
        text: `A Main legmagasabb mérési pontjain a leghangosabban mért sávok: ${top.map((t) => `${t.name} (${t.mean_level})`).join(', ')}. Ez korreláció, nem bizonyíték, hogy ők okozzák a csúcsot.`,
        check: 'Célzott méréssel erősítsd meg (kiválasztott sáv/csoport mérése a későbbi funkciók között szerepel), vagy némítsd/szólózd kézzel és mérd újra.'
      });
    }
  }

  const movers = tracks.filter((t) => t.fader?.moved);
  if (movers.length) {
    findings.push({
      type: 'tény',
      text: `Mozgó fader (automatizálás vagy kézi mozgatás) a szakaszban: ${movers.map((t) => `${t.name}: ${t.fader.first_display} → ${t.fader.last_display} (min ${t.fader.min_display}, max ${t.fader.max_display})`).join('; ')}.`
    });
  } else {
    findings.push({ type: 'tény', text: 'Egy sáv faderje sem mozdult a szakaszban.' });
  }
  const muted = tracks.filter((t) => t.muted_whole_time).map((t) => t.name);
  if (muted.length) findings.push({ type: 'tény', text: `Végig némítva (mute) volt: ${muted.join(', ')}. Ha szándékos, nincs teendő.` });
  const toggled = tracks.filter((t) => t.mute_changed || t.solo_changed).map((t) => t.name);
  if (toggled.length) findings.push({ type: 'tény', text: `Mute/solo állapot változott közben: ${toggled.join(', ')}.` });
  const rerouted = tracks.filter((t) => t.output_changed).map((t) => t.name);
  if (rerouted.length) findings.push({ type: 'tény', text: `A kimeneti routing változott közben: ${rerouted.join(', ')}.` });

  const overriddenNow = after?.overridden ?? before.overridden;
  if (overriddenNow.length) {
    findings.push({
      type: 'tény',
      text: `Felülbírált automatizálás (a paraméter nem követi a görbét): ${overriddenNow.slice(0, 12).map((o) => `${o.track} – ${o.parameter}`).join('; ')}${overriddenNow.length > 12 ? ` … (+${overriddenNow.length - 12})` : ''}.`,
      check: 'Ha nem szándékos, a Live-ban a "Re-Enable Automation" gombbal visszakapcsolható. Ez az eszköz nem nyúl hozzá.'
    });
  }
  if (summary.project_unchanged === true) {
    findings.push({ type: 'tény', text: 'A projekt szerkezeti ujjlenyomata a megfigyelés előtt és után azonos, tehát ezalatt nem változott a sávok, eszközök, routing vagy hangjegyek szerkezete.' });
  } else if (summary.project_unchanged === false) {
    findings.push({ type: 'tény', text: 'A projekt szerkezete a megfigyelés alatt megváltozott (ujjlenyomat eltér). Az eszköz nem ír, tehát ezt te vagy az Ableton okozta.' });
  }

  // --- szerep
  const hint = roleHint(session.role);
  if (hint === 'soft') {
    findings.push({ type: 'feltételezés', text: `Megadott szerep: "${session.role}". Lágyabb résznél az alacsonyabb szint elvárt, a halkabb hangzás önmagában nem hiba.`, check: 'Csak a saját szándékodhoz képest értelmezd: a "meres" LUFS értékét hasonlítsd az erős részhez.' });
  } else if (hint === 'strong') {
    findings.push({ type: 'feltételezés', text: `Megadott szerep: "${session.role}". Erős résznél az elvárás, hogy érezhetően hangosabb/energikusabb legyen a lágy részeknél, de az eltérés mértéke zenei döntés.`, check: 'Mérd meg ugyanígy a szomszédos lágy részt, és hasonlítsd össze a hangosságukat (nem a tökéletes egyezés a cél).' });
  } else if (session.role) {
    findings.push({ type: 'tény', text: `Megadott szerep: "${session.role}".` });
  } else {
    findings.push({ type: 'feltételezés', text: 'Nincs megadva a rész szerepe (--szerep), ezért nem tudjuk, a szint szándékos-e.', check: 'Add meg, pl. --szerep "lágy verze".' });
  }

  return summary;
}

function lastSignature(session) {
  const last = session.signatureSamples[session.signatureSamples.length - 1];
  return last ? { num: last.num, den: last.den } : { num: session.song_before.signature_numerator, den: session.song_before.signature_denominator };
}

function uniqueSignatures(session) {
  const seen = [];
  const all = [{ num: session.song_before.signature_numerator, den: session.song_before.signature_denominator }, ...session.signatureSamples];
  for (const s of all) if (!seen.some((x) => x.num === s.num && x.den === s.den)) seen.push({ num: s.num, den: s.den });
  return seen;
}

function integrateSeconds(samples) {
  let total = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const beats = samples[i].beat - samples[i - 1].beat;
    if (beats > 0) total += (beats * 60) / ((samples[i].tempo + samples[i - 1].tempo) / 2);
  }
  return total;
}

function groupLookup(structure) {
  const out = {};
  for (const t of structure.tracks ?? []) if (t.group) out[t.address] = t.group;
  return out;
}

function perBar(samples, levels, sig) {
  const barBeats = (sig.num * 4) / sig.den;
  const bars = new Map();
  samples.forEach((s, i) => {
    const bar = Math.floor(s.beat / barBeats + 1e-9) + 1;
    if (!bars.has(bar)) bars.set(bar, []);
    bars.get(bar).push(levels[i]);
  });
  return [...bars.entries()].map(([bar, v]) => ({ bar, mean: round(mean(v)), peak: round(max(v)), samples: v.length }));
}

function peakSuspects(samples, mainLevels, tracks) {
  const idx = mainLevels.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, Math.max(3, Math.ceil(samples.length * 0.05))).map((x) => x[1]);
  const candidates = tracks.filter((t) => t.meter.available && t.address !== 'master' && t.kind !== 'group');
  const scored = candidates.map((t) => ({
    name: t.name,
    level: mean(idx.map((i) => Math.max(samples[i].tracks[t.address]?.[0] ?? 0, samples[i].tracks[t.address]?.[1] ?? 0)))
  }));
  return scored.filter((s) => s.level > ACTIVE_LEVEL).sort((a, b) => b.level - a.level).slice(0, 3).map((s) => ({ name: s.name, mean_level: round(s.level, 2) }));
}
