// Megfigyelés: a lejátszás közben időbélyeggel naplózza a projektállapotot és a Live mérőit.
// CSAK OLVAS. Egyetlen paramétert, automatizálást, transportot vagy kijelölést sem ír.
import { BridgeError } from './bridge.js';
import { barToBeats } from './time.js';
import { structuralFingerprint } from './fingerprint.js';

export const SONG_NAMES = [
  'tempo', 'signature_numerator', 'signature_denominator', 'current_song_time', 'is_playing',
  'song_length', 'loop', 'loop_start', 'loop_length', 'record_mode', 'arrangement_overdub', 'back_to_arranger'
];

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readSongProps(bridge) {
  const result = await bridge.send('get_properties', { address: 'song', names: SONG_NAMES });
  return result.properties;
}

/** Projekt- és automatizálás-állapot a megfigyelés előtt/után. */
export async function readState(bridge) {
  const [set, automation, song, ids] = await Promise.all([
    bridge.send('describe_set', { include_clips: false, include_scenes: false }),
    bridge.send('get_automation', {}),
    readSongProps(bridge),
    bridge.send('get_properties', { address: 'song', names: ['name', 'file_path'] })
  ]);
  return { set, automation, song, project: { name: ids.properties.name || '', file_path: ids.properties.file_path || '' } };
}

function summarizeAutomation(automation) {
  const automated = automation.automated || [];
  return {
    automated_count: automation.automated_count ?? automated.length,
    overridden_count: automation.overridden_count ?? 0,
    overridden: automated.filter((a) => a.state === 'overridden').map((a) => ({ track: a.track, parameter: a.name, device: a.device })),
    automated: automated.map((a) => ({ track: a.track, parameter: a.name, device: a.device, state: a.state })),
    truncated: Boolean(automation.truncated),
    clips_with_envelopes: (automation.clips_with_envelopes || []).length
  };
}

/**
 * @param {import('./bridge.js').Bridge} bridge
 * @param {object} o  role, intervalMs, maxSeconds, waitSeconds, fromBar, toBar, signal, log, now, sleep, onSample
 */
export async function observe(bridge, o = {}) {
  const opt = {
    role: '', intervalMs: 200, maxSeconds: 60, waitSeconds: 90, fromBar: null, toBar: null,
    signal: undefined, log: () => {}, now: () => performance.now(), sleep: sleepDefault, onSample: null, ...o
  };
  const aborted = () => opt.signal?.aborted === true;

  const before = await readState(bridge);
  const warnings = [];
  const sig0 = { num: before.song.signature_numerator, den: before.song.signature_denominator };
  const fromBeat = opt.fromBar != null ? barToBeats(opt.fromBar, sig0.num, sig0.den) : null;
  const toBeat = opt.toBar != null ? barToBeats(opt.toBar, sig0.num, sig0.den) : null;
  if (fromBeat != null && toBeat != null && toBeat <= fromBeat) throw new Error('A --ig-utem értéke legyen nagyobb, mint a --tol-utem.');

  // Várakozás a lejátszásra (és a kért ütem elérésére)
  const waitStart = opt.now();
  let announced = false;
  let first;
  for (;;) {
    if (aborted()) return abortedSession(opt, before, warnings);
    first = await bridge.send('audio_snapshot', {});
    const beat = first.transport.current_song_time;
    const inRange = (fromBeat == null || beat >= fromBeat - 1e-6) && (toBeat == null || beat < toBeat);
    if (first.transport.is_playing && inRange) break;
    if (!announced) {
      opt.log(
        fromBeat != null
          ? `Várom a lejátszást. Indítsd el az Ableton lejátszását a(z) ${opt.fromBar}. ütem előtt; ${opt.fromBar}. ütemnél kezdem a naplózást.`
          : 'Várom a lejátszást. Indítsd el a lejátszást az Abletonban (szóköz).'
      );
      announced = true;
    }
    if ((opt.now() - waitStart) / 1000 > opt.waitSeconds) {
      throw new Error(`A megadott ${opt.waitSeconds} mp alatt nem indult el a lejátszás a kért helyen.`);
    }
    await opt.sleep(250);
  }

  const meta = {};
  const faderInfo = {};
  const samples = [];
  const signatureSamples = [];
  const gaps = [];
  let consecutiveFailures = 0;
  let stopReason = 'ismeretlen';
  let tick = 0;
  let snapshot = first;
  const t0 = opt.now();
  opt.log('Naplózás indul. Leállítás: állítsd le a lejátszást az Abletonban, vagy nyomj Ctrl+C-t.');

  for (;;) {
    const tickStart = opt.now();
    const ms = tickStart - t0;

    if (tick > 0) {
      try {
        snapshot = await bridge.send('audio_snapshot', {});
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        gaps.push({ ms: Math.round(ms), error: error.message });
        if (consecutiveFailures >= 5) {
          stopReason = 'a kapcsolat megszakadt';
          warnings.push(`A kapcsolat ${consecutiveFailures} egymás utáni lekérdezésnél hibázott, a naplózás leállt: ${error.message}`);
          break;
        }
        await opt.sleep(opt.intervalMs);
        continue;
      }
    }

    const transport = snapshot.transport;
    if (!transport.is_playing) {
      stopReason = 'a lejátszás leállt';
      break;
    }
    if (toBeat != null && transport.current_song_time >= toBeat) {
      stopReason = `elértük a(z) ${opt.toBar}. ütemet`;
      break;
    }

    if (tick % 10 === 0) {
      try {
        const props = await readSongProps(bridge);
        signatureSamples.push({ ms: Math.round(ms), num: props.signature_numerator, den: props.signature_denominator, tempo: props.tempo, loop: props.loop });
      } catch {
        /* nem kritikus */
      }
    }

    const tracks = {};
    for (const row of snapshot.tracks) {
      if (row.name === 'HANGERO MERES') continue; // a mérés ideiglenes sávja (SCRATCH_NAME, measure.js) nem része a projektnek
      tracks[row.address] = [
        row.meter?.left ?? 0, row.meter?.right ?? 0, row.fader ?? null,
        row.mute ? 1 : 0, row.silenced_by_solo ? 1 : 0, row.solo ? 1 : 0
      ];
      if (!meta[row.address]) {
        meta[row.address] = { name: row.name, kind: row.kind, output: row.output ?? null };
        faderInfo[row.address] = { first: row.fader, firstDisplay: row.fader_display, min: row.fader, minDisplay: row.fader_display, max: row.fader, maxDisplay: row.fader_display };
      }
      const info = faderInfo[row.address];
      if (row.fader != null) {
        if (row.fader < info.min) { info.min = row.fader; info.minDisplay = row.fader_display; }
        if (row.fader > info.max) { info.max = row.fader; info.maxDisplay = row.fader_display; }
        info.last = row.fader;
        info.lastDisplay = row.fader_display;
      }
      const output = JSON.stringify(row.output ?? null);
      if (meta[row.address].outputNow !== undefined && meta[row.address].outputNow !== output) meta[row.address].outputChanged = true;
      meta[row.address].outputNow = output;
    }
    const sample = { ms: Math.round(ms), beat: transport.current_song_time, tempo: transport.tempo, tracks };
    samples.push(sample);
    opt.onSample?.(sample);

    if (aborted()) { stopReason = 'megszakítva'; break; }
    if (ms / 1000 >= opt.maxSeconds) { stopReason = `elértük a ${opt.maxSeconds} mp-es maximumot`; break; }
    tick += 1;
    const spent = opt.now() - tickStart;
    await opt.sleep(Math.max(0, opt.intervalMs - spent));
  }

  const after = await readState(bridge).catch((error) => {
    warnings.push(`A záró állapot nem olvasható: ${error.message}`);
    return null;
  });

  return {
    schema: 'hangero-megfigyeles/1',
    role: opt.role,
    started_at: new Date().toISOString(),
    options: { intervalMs: opt.intervalMs, maxSeconds: opt.maxSeconds, fromBar: opt.fromBar, toBar: opt.toBar },
    project: before.project,
    structure: before.set,
    song_before: before.song,
    song_after: after?.song ?? null,
    automation_before: summarizeAutomation(before.automation),
    automation_after: after ? summarizeAutomation(after.automation) : null,
    fingerprint_before: structuralFingerprint(before.set),
    fingerprint_after: after ? structuralFingerprint(after.set) : null,
    meta,
    faderInfo,
    samples,
    signatureSamples,
    gaps,
    stopReason,
    warnings
  };
}

function abortedSession(opt, before, warnings) {
  return {
    schema: 'hangero-megfigyeles/1', role: opt.role, started_at: new Date().toISOString(), options: {}, project: before.project,
    structure: before.set, song_before: before.song, song_after: null, automation_before: summarizeAutomation(before.automation),
    automation_after: null, fingerprint_before: structuralFingerprint(before.set), fingerprint_after: null, meta: {}, faderInfo: {},
    samples: [], signatureSamples: [], gaps: [], stopReason: 'megszakítva a várakozás közben', warnings
  };
}

export { BridgeError };
