import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeSamples, analyzeWavFile, readWav, writeWavFloat32 } from '../src/audio.js';

const sine = (freq, amp, seconds, sr, phase = 0) => {
  const out = new Float64Array(Math.round(seconds * sr));
  for (let n = 0; n < out.length; n += 1) out[n] = amp * Math.sin(2 * Math.PI * freq * (n / sr) + phase);
  return out;
};
const wavOf = (channels, sr) => ({ sampleRate: sr, bits: 32, isFloat: true, channels, frames: channels[0].length, duration: channels[0].length / sr });
const db = (a) => 20 * Math.log10(a);

test('EBU 3341: 1 kHz szinusz, sztereó, -23 dBFS csúcs -> -23 LUFS', () => {
  for (const sr of [44100, 48000]) {
    const s = sine(1000, 10 ** (-23 / 20), 12, sr);
    const r = analyzeSamples(wavOf([s, s], sr));
    assert.ok(Math.abs(r.integrated_lufs + 23) < 0.15, `integrált ${r.integrated_lufs} @${sr}`);
    assert.ok(Math.abs(r.short_term.max_lufs + 23) < 0.15, `short-term ${r.short_term.max_lufs}`);
    assert.ok(Math.abs(r.momentary_max_lufs + 23) < 0.15, `momentary ${r.momentary_max_lufs}`);
    assert.ok(Math.abs(r.sample_peak_dbfs + 23) < 0.05);
  }
});

test('a jel 10 dB-lel erősebb -> 10 LU-val hangosabb', () => {
  const a = sine(1000, 0.1, 8, 48000), b = sine(1000, 0.1 * 10 ** (10 / 20), 8, 48000);
  const la = analyzeSamples(wavOf([a, a], 48000)).integrated_lufs;
  const lb = analyzeSamples(wavOf([b, b], 48000)).integrated_lufs;
  assert.ok(Math.abs(lb - la - 10) < 0.05, `${lb - la}`);
});

test('mono jel: ugyanaz a hangosság, mint a sztereó fele teljesítménye (-3 LU)', () => {
  const s = sine(1000, 0.2, 8, 48000);
  const mono = analyzeSamples(wavOf([s], 48000)).integrated_lufs;
  const stereo = analyzeSamples(wavOf([s, s], 48000)).integrated_lufs;
  assert.ok(Math.abs(stereo - mono - 3.01) < 0.05, `${stereo - mono}`);
});

test('true peak: fs/4 szinusz 45 fokos fázissal, a mintacsúcs 0,707, a true peak ~1,0', () => {
  const sr = 48000;
  const s = sine(sr / 4, 1.0, 2, sr, Math.PI / 4);
  const r = analyzeSamples(wavOf([s, s], sr));
  assert.ok(Math.abs(r.sample_peak_dbfs - db(Math.SQRT1_2)) < 0.05, `minta ${r.sample_peak_dbfs}`);
  assert.ok(Math.abs(r.true_peak_dbtp - 0) < 0.25, `true peak ${r.true_peak_dbtp}`);
  assert.ok(r.true_peak_dbtp > r.sample_peak_dbfs + 2.5);
});

test('relatív kapu: a csendes szakasz nem húzza le az integrált értéket', () => {
  const sr = 48000;
  const loud = sine(1000, 0.1, 8, sr);
  const quiet = sine(1000, 0.1 * 10 ** (-30 / 20), 8, sr);
  const both = new Float64Array(loud.length + quiet.length);
  both.set(loud); both.set(quiet, loud.length);
  const only = analyzeSamples(wavOf([loud, loud], sr)).integrated_lufs;
  const mixed = analyzeSamples(wavOf([both, both], sr)).integrated_lufs;
  assert.ok(Math.abs(only - mixed) < 0.3, `${only} vs ${mixed}`);
});

test('néma felvétel nem kap hangosságot, hanem figyelmeztetést', () => {
  const z = new Float64Array(48000 * 3);
  const r = analyzeSamples(wavOf([z, z], 48000));
  assert.equal(r.silent, true);
  assert.equal(r.integrated_lufs, undefined);
  assert.match(r.notes[0], /néma/);
});

test('rövid felvétel: LUFS helyett magyarázat', () => {
  const s = sine(1000, 0.1, 0.2, 48000);
  const r = analyzeSamples(wavOf([s, s], 48000));
  assert.equal(r.integrated_lufs, null);
  assert.ok(r.notes.length >= 1);
});

test('WAV fájl visszaolvasása (float32) és AIFF elutasítása', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wav-'));
  const s = sine(1000, 0.5, 4, 48000);
  const file = path.join(dir, 'a.wav');
  writeWavFloat32(file, [s, s], 48000);
  const r = analyzeWavFile(file);
  assert.equal(r.format.channels, 2);
  assert.ok(Math.abs(r.sample_peak_dbfs - db(0.5)) < 0.01);
  assert.throws(() => readWav(Buffer.concat([Buffer.from('FORM'), Buffer.alloc(60)])), /AIFF/);
  assert.throws(() => readWav(Buffer.alloc(60)), /Nem WAV/);
});

test('16 és 24 bites PCM WAV beolvasása', () => {
  for (const bits of [16, 24]) {
    const frames = 4800, ch = 2, bytes = bits / 8;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + frames * ch * bytes, 4); header.write('WAVE', 8); header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(ch, 22); header.writeUInt32LE(48000, 24);
    header.writeUInt32LE(48000 * ch * bytes, 28); header.writeUInt16LE(ch * bytes, 32); header.writeUInt16LE(bits, 34);
    header.write('data', 36); header.writeUInt32LE(frames * ch * bytes, 40);
    const body = Buffer.alloc(frames * ch * bytes);
    const full = bits === 16 ? 32767 : 8388607;
    for (let n = 0; n < frames; n += 1) for (let c = 0; c < ch; c += 1) {
      const v = Math.round(0.5 * full * Math.sin((2 * Math.PI * 1000 * n) / 48000));
      if (bits === 16) body.writeInt16LE(v, (n * ch + c) * bytes); else body.writeIntLE(v, (n * ch + c) * bytes, 3);
    }
    const wav = readWav(Buffer.concat([header, body]));
    assert.equal(wav.frames, frames);
    assert.ok(Math.abs(analyzeSamples(wav).sample_peak_dbfs - db(0.5)) < 0.01, `${bits} bit`);
  }
});
