// SZIMULÁLT Live-bridge a tesztekhez. Nem Ableton! A valódi Remote Script protokollját és a dokumentációból
// ismert válaszformákat utánozza (nyers JSON kérés, {"status":...} válasz), így az eszköz logikája tesztelhető.
// Amit itt "működik", az csak azt bizonyítja, hogy az eszköz helyesen beszél a dokumentált protokollal.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeWavFloat32 } from '../src/audio.js';

export class MockLive {
  constructor({ speed = 8, bpm = 120, exclusiveArm = true, overridden = false, startBeat = 40, version = '12.1.10' } = {}) {
    this.speed = speed;
    this.bpm = bpm;
    this.exclusiveArm = exclusiveArm;
    this.version = version;
    this.playing = false;
    this.beatAtPlay = startBeat;
    this.realAtPlay = 0;
    this.selectedTrack = 'tracks/2';
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mocklive-'));
    this.commandLog = [];
    this.hooks = {};
    this.rec = null;
    this.signature = [4, 4];
    this.overridden = overridden;
    this.tracks = [
      this.mk('Drums', 'group', null),
      this.mk('Kick', 'audio', 'Drums'),
      this.mk('Bass', 'midi', null, { arm: true }),
      this.mk('Lead', 'midi', null),
      this.mk('Pad 2', 'midi', null, { mute: true })
    ];
    this.returns = [{ name: 'A-Reverb', kind: 'return', vol: 0.7, mute: false, solo: false, devices: ['Reverb'] }];
    this.master = { name: 'Master', kind: 'master', vol: 0.85, devices: ['Limiter'] };
    this.undoSteps = 0;
  }

  mk(name, kind, group, extra = {}) {
    return { name, kind, group, vol: 0.85, pan: 0, mute: false, solo: false, arm: false, devices: ['EQ Eight'], monitoring: 'AUTO', input: 'Ext. In', ...extra };
  }

  // ---------- idő és hangadatok
  get beat() {
    if (!this.playing) return this.beatAtPlay;
    return this.beatAtPlay + ((performance.now() - this.realAtPlay) / 1000) * (this.bpm / 60) * this.speed;
  }
  play(beat) { if (beat != null) this.beatAtPlay = beat; this.realAtPlay = performance.now(); this.playing = true; }
  stop() { this.beatAtPlay = this.beat; this.playing = false; }
  section(beat) { return beat >= 32 ? 'strong' : 'soft'; }
  faderOf(index, beat) { // a Bass (2. sáv) faderét automatizáljuk
    const t = this.tracks[index];
    if (t.name === 'Bass' && !this.overridden) return beat < 48 ? 0.85 : Math.max(0.65, 0.85 - (beat - 48) * 0.0125);
    return t.vol;
  }
  levelOf(index, beat) {
    const t = this.tracks[index];
    if (t.scratch || t.mute || t.name === 'Drums') return 0;
    const base = this.section(beat) === 'strong' ? 0.55 : 0.25;
    const pulse = 0.6 + 0.4 * Math.abs(Math.sin(beat * Math.PI));
    return Math.min(1, base * pulse * (this.faderOf(index, beat) / 0.85));
  }
  masterLevel(beat) {
    const sum = this.tracks.reduce((s, _, i) => s + this.levelOf(i, beat), 0);
    return Math.min(1, sum * 0.45);
  }

  // ---------- parancsok
  fingerprint() { // az upstreamhez hasonlóan a hangerőt IS tartalmazza -> automatizáláskor változik
    const b = this.beat;
    return crypto.createHash('sha1').update(JSON.stringify({ t: this.tracks.map((t, i) => [t.name, t.arm, t.devices, this.faderOf(i, b)]), r: this.returns.length })).digest('hex').slice(0, 12);
  }
  trackSummary(t, i, kind) {
    return { address: `tracks/${i}`, name: t.name, kind: kind ?? t.kind, mute: t.mute, solo: t.solo, volume: this.faderOf(i, this.beat), panning: 0, devices: t.devices, arm: t.arm, group: t.group, hash: 'x' };
  }
  describe() {
    return {
      fingerprint: this.fingerprint(),
      song: { tempo: this.bpm, is_playing: this.playing },
      cue_points: [{ address: 'cue_points/0', name: 'Verse', time: 32 }],
      tracks: this.tracks.map((t, i) => this.trackSummary(t, i)),
      returns: this.returns.map((t, i) => ({ address: `returns/${i}`, name: t.name, kind: 'return', mute: false, solo: false, volume: t.vol, panning: 0, devices: t.devices })),
      master: { address: 'master', name: 'Master', kind: 'master', volume: 0.85, devices: this.master.devices }
    };
  }
  songProps() {
    return { name: 'Mock_Projekt', file_path: 'C:\\Users\\teszt\\Mock_Projekt.als', tempo: this.bpm, signature_numerator: this.signature[0], signature_denominator: this.signature[1],
      current_song_time: this.beat, is_playing: this.playing, song_length: 256, loop: false, loop_start: 0, loop_length: 16, record_mode: false,
      arrangement_overdub: false, back_to_arranger: false, exclusive_arm: this.exclusiveArm };
  }
  snapshot() {
    const b = this.beat;
    const row = (address, name, kind, level, fader, t) => ({
      address, name, kind, meter: { left: level, right: level }, playing_clip: null, mute: Boolean(t?.mute), silenced_by_solo: false, solo: Boolean(t?.solo),
      fader, fader_display: `${(20 * Math.log10(Math.max(fader, 1e-4) / 0.85)).toFixed(1)} dB`, output: { type: 'Master', channel: '' }, device_count: 1, audible: true
    });
    const rows = this.tracks.map((t, i) => row(`tracks/${i}`, t.name, t.kind, this.levelOf(i, b), this.faderOf(i, b), t));
    rows.push(...this.returns.map((t, i) => row(`returns/${i}`, t.name, 'return', 0, t.vol, t)));
    rows.push(row('master', 'Master', 'master', this.masterLevel(b), 0.85, this.master));
    return { scope: 'song', transport: { is_playing: this.playing, tempo: this.bpm, current_song_time: b }, cpu: {}, someone_is_soloed: false, audible: [], tracks: rows, notes: [], meters: 'Live units' };
  }
  automation() {
    const bass = { address: 'tracks/2/mixer/volume', name: 'Track Volume', device: 'Mixer', track: 'tracks/2', state: this.overridden ? 'overridden' : 'playing' };
    return { scope: 'song', parameters_scanned: 40, automated_count: 1, overridden_count: this.overridden ? 1 : 0, automated: [bass], clips_with_envelopes: [], truncated: false, song_has_overridden_automation: this.overridden };
  }
  resolveTrack(address) {
    const m = /^tracks\/(\d+)/.exec(address ?? '');
    if (!m || !this.tracks[+m[1]]) throw this.err('NOT_FOUND', `Nincs ilyen cím: ${address}`);
    return [this.tracks[+m[1]], +m[1]];
  }
  err(code, message) { const e = new Error(message); e.code = code; return e; }

  finishRecording() {
    const r = this.rec;
    if (!r || r.file) return;
    const seconds = (r.beats * 60) / this.bpm;
    const sr = 48000;
    const n = Math.round(seconds * sr);
    const a = r.amplitude ?? 0.2;
    const ch = new Float64Array(n);
    for (let i = 0; i < n; i += 1) ch[i] = a * Math.sin(2 * Math.PI * 1000 * (i / sr));
    const dir = path.join(this.dir, 'Samples', 'Recorded');
    fs.mkdirSync(dir, { recursive: true });
    r.file = path.join(dir, `HANGERO MERES ${Date.now()}.wav`);
    writeWavFloat32(r.file, [ch, ch], sr);
  }

  handle(type, p) {
    this.commandLog.push(type);
    this.hooks[type]?.(p);
    switch (type) {
      case 'get_script_info':
        return { script_version: '3.0.0-mock', build_id: 'mock', capabilities: ['get_script_info', 'get_capabilities', 'describe_set', 'get_properties', 'set_properties', 'audio_snapshot', 'get_automation', 'create', 'routing', 'launch', 'delete', 'transport', 'introspect_api'], gates: {} };
      case 'get_capabilities':
        return { script: { version: '3.0.0-mock' }, live: { version: this.version, build: 'mock', variant: 'Suite', edition: 'Suite', unavailable_features: [] }, features: { max_for_live: false }, commands: [], gates: {} };
      case 'describe_set': return this.describe();
      case 'audio_snapshot': return this.snapshot();
      case 'get_automation': return this.automation();
      case 'introspect_api': return { classes: { Track: { methods: ['duplicate_clip_to_arrangement', 'delete_clip'] } } };
      case 'get_properties': {
        if (p.address === 'song') {
          const all = this.songProps();
          return { address: 'song', kind: 'song', properties: Object.fromEntries((p.names ?? Object.keys(all)).map((n) => [n, all[n]])) };
        }
        if (p.address === 'view') return { address: 'view', kind: 'view', properties: { selected_track: this.selectedTrack } };
        const clip = /^(tracks\/\d+)\/slots\/0\/clip$/.exec(p.address ?? '');
        if (clip) {
          if (!this.rec) throw this.err('NOT_FOUND', 'Nincs klip');
          const done = this.beat >= this.rec.startBeat + this.rec.beats || !this.playing;
          if (done) this.finishRecording();
          const all = { is_recording: !done, file_path: done ? this.rec.file : '' };
          return { address: p.address, kind: 'clip', properties: Object.fromEntries(p.names.map((n) => [n, all[n]])) };
        }
        throw this.err('NOT_FOUND', `get_properties: ismeretlen cím ${p.address}`);
      }
      case 'create': {
        this.tracks.push(this.mk(p.name, 'audio', null, { scratch: true }));
        this.selectedTrack = `tracks/${this.tracks.length - 1}`; // a Live kijelöli az új sávot
        this.undoSteps += 1;
        return { address: `tracks/${this.tracks.length - 1}`, name: p.name };
      }
      case 'set_properties': {
        if (p.address === 'view') { this.selectedTrack = p.properties.selected_track; return { ok: true }; }
        const [t, i] = this.resolveTrack(p.address);
        if (p.expect?.name && p.expect.name !== t.name) throw this.err('GUARD_FAILED', 'A név nem egyezik');
        for (const [k, v] of Object.entries(p.properties)) {
          if (k === 'arm') {
            if (v && this.exclusiveArm) this.tracks.forEach((o) => { o.arm = false; });
            t.arm = v;
          } else if (k === 'current_monitoring_state') t.monitoring = v;
          else throw this.err('NOT_FOUND', `Ismeretlen tulajdonság: ${k}`);
        }
        return { address: p.address, index: i };
      }
      case 'routing': {
        const [t] = this.resolveTrack(p.address);
        t.input = p.type;
        return { type: { display_name: p.type } };
      }
      case 'launch': {
        const [t] = this.resolveTrack(p.address);
        if (p.record_length) {
          if (!t.arm) throw this.err('GUARD_FAILED', 'A sáv nincs felvételre állítva');
          this.rec = { startBeat: this.beat, beats: p.record_length, file: null, amplitude: this.recAmplitude };
        }
        return { ok: true };
      }
      case 'delete': {
        const [t, i] = this.resolveTrack(p.address);
        if (p.expect?.name !== t.name) throw this.err('GUARD_FAILED', 'A név nem egyezik');
        this.tracks.splice(i, 1);
        this.undoSteps += 1;
        if (this.selectedTrack === `tracks/${i}`) this.selectedTrack = `tracks/${Math.max(0, i - 1)}`;
        return { deleted: p.address };
      }
      case 'transport':
        if (p.action === 'stop') this.stop(); else if (p.action === 'play') this.play();
        return { is_playing: this.playing };
      default:
        throw this.err('UNKNOWN_COMMAND', `Ismeretlen parancs: ${type}`);
    }
  }

  async listen(port = 0) {
    this.server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let req;
        try { req = JSON.parse(buffer); } catch { return; }
        buffer = '';
        let response;
        try {
          response = { status: 'success', result: this.handle(req.type, req.params ?? {}) };
        } catch (e) {
          if (e.drop) { socket.destroy(); return; }
          response = { status: 'error', code: e.code ?? 'INTERNAL_ERROR', message: e.message };
        }
        socket.end(JSON.stringify(response));
      });
      socket.on('error', () => {});
    });
    await new Promise((resolve) => this.server.listen(port, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    return this.port;
  }

  async close() {
    await new Promise((resolve) => this.server.close(resolve));
    this.server.closeAllConnections?.();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
