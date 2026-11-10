// WAV-fájl elemzése külső program (ffmpeg) nélkül: integrált / rövid távú / pillanatnyi LUFS
// (ITU-R BS.1770-4 K-súlyozás, EBU R128 kapuzás), mintacsúcs, true peak (4x túlmintavételezés), RMS.
// A pontosságot a test/audio.test.js ismert jelekkel ellenőrzi; élő Live-felvételen még nincs igazolva.
import fs from 'node:fs';

// ---------------------------------------------------------------- WAV beolvasás
export function readWav(buffer) {
  if (buffer.length < 44) throw new Error('A fájl túl rövid ahhoz, hogy WAV legyen.');
  const tag = buffer.toString('ascii', 0, 4);
  if (tag === 'FORM') throw new Error('Ez AIFF fájl. Állítsd a Live-ot WAV-ra (Preferences → Record, Warp & Launch → File Type: WAV), és mérj újra.');
  if (tag === 'RF64') throw new Error('RF64 fájl, ezt az eszköz nem támogatja.');
  if (tag !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Nem WAV fájl (hiányzik a RIFF/WAVE fejléc).');

  let fmt = null;
  let dataStart = -1;
  let dataLength = 0;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      let format = buffer.readUInt16LE(body);
      if (format === 0xfffe && size >= 26) format = buffer.readUInt16LE(body + 24);
      fmt = { format, channels: buffer.readUInt16LE(body + 2), sampleRate: buffer.readUInt32LE(body + 4), bits: buffer.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      dataStart = body;
      dataLength = Math.min(size, buffer.length - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!fmt) throw new Error('A WAV fájlból hiányzik az fmt blokk.');
  if (dataStart < 0) throw new Error('A WAV fájlból hiányzik az adatblokk.');
  const isFloat = fmt.format === 3;
  if (!(fmt.format === 1 || isFloat)) throw new Error(`Nem támogatott WAV formátum (kód: ${fmt.format}). PCM vagy float WAV kell.`);
  if (![16, 24, 32, 64].includes(fmt.bits) || (fmt.bits === 64 && !isFloat)) throw new Error(`Nem támogatott bitmélység: ${fmt.bits}.`);

  const bytes = fmt.bits / 8;
  const frames = Math.floor(dataLength / (bytes * fmt.channels));
  const channels = Array.from({ length: fmt.channels }, () => new Float64Array(frames));
  let p = dataStart;
  for (let n = 0; n < frames; n += 1) {
    for (let c = 0; c < fmt.channels; c += 1) {
      let v;
      if (isFloat) v = fmt.bits === 32 ? buffer.readFloatLE(p) : buffer.readDoubleLE(p);
      else if (fmt.bits === 16) v = buffer.readInt16LE(p) / 32768;
      else if (fmt.bits === 24) v = (buffer.readIntLE(p, 3)) / 8388608;
      else v = buffer.readInt32LE(p) / 2147483648;
      channels[c][n] = v;
      p += bytes;
    }
  }
  return { sampleRate: fmt.sampleRate, bits: fmt.bits, isFloat, channels, frames, duration: frames / fmt.sampleRate };
}

// ---------------------------------------------------------------- K-súlyozás
function kCoefficients(fs) {
  const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b: [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0],
    a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0]
  };
  const f1 = 38.13547087602444, Q1 = 0.5003270373238773;
  K = Math.tan((Math.PI * f1) / fs);
  a0 = 1 + K / Q1 + K * K;
  const highpass = { b: [1, -2, 1], a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q1 + K * K) / a0] };
  return [shelf, highpass];
}

function biquad(input, { b, a }) {
  const out = new Float64Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let n = 0; n < input.length; n += 1) {
    const x = input[n];
    const y = b[0] * x + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    out[n] = y;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
  }
  return out;
}

const channelWeight = (index, count) => (count >= 5 && index >= 3 ? 1.41 : 1.0);
const toDb = (power) => (power > 0 ? -0.691 + 10 * Math.log10(power) : null);
const ampToDb = (amp) => (amp > 0 ? 20 * Math.log10(amp) : null);

/** Súlyozott, K-szűrt teljesítmény előösszegzése: P[i] = sum_{n<i} sum_c G_c * y_c[n]^2 */
function weightedPrefix(wav) {
  const filters = kCoefficients(wav.sampleRate);
  const prefix = new Float64Array(wav.frames + 1);
  const count = wav.channels.length;
  for (let c = 0; c < count; c += 1) {
    const weight = channelWeight(c, count);
    let y = biquad(wav.channels[c], filters[0]);
    y = biquad(y, filters[1]);
    for (let n = 0; n < wav.frames; n += 1) prefix[n + 1] += weight * y[n] * y[n];
  }
  for (let n = 1; n <= wav.frames; n += 1) prefix[n] += prefix[n - 1];
  return prefix;
}

function windowPowers(prefix, frames, sampleRate, windowSeconds, stepSeconds) {
  const win = Math.round(windowSeconds * sampleRate);
  const step = Math.round(stepSeconds * sampleRate);
  const out = [];
  for (let start = 0; start + win <= frames; start += step) {
    out.push({ end: (start + win) / sampleRate, power: (prefix[start + win] - prefix[start]) / win });
  }
  return out;
}

// ---------------------------------------------------------------- true peak
function interpolationPhases() {
  const phases = [];
  for (let p = 1; p < 4; p += 1) {
    const d = p / 4;
    const taps = [];
    for (let m = -5; m <= 6; m += 1) {
      const t = d - m;
      const sinc = Math.sin(Math.PI * t) / (Math.PI * t);
      const window = 0.5 * (1 + Math.cos((Math.PI * t) / 6));
      taps.push(sinc * window);
    }
    const sum = taps.reduce((s, v) => s + v, 0);
    phases.push(taps.map((v) => v / sum));
  }
  return phases;
}

function truePeakOf(channel, phases) {
  const n = channel.length;
  let peak = 0;
  for (let i = 0; i < n; i += 1) {
    const a = Math.abs(channel[i]);
    if (a > peak) peak = a;
  }
  for (let i = 0; i < n; i += 1) {
    for (let p = 0; p < 3; p += 1) {
      const taps = phases[p];
      let sum = 0;
      for (let m = -5; m <= 6; m += 1) {
        const idx = i + m;
        if (idx >= 0 && idx < n) sum += channel[idx] * taps[m + 5];
      }
      const a = Math.abs(sum);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

// ---------------------------------------------------------------- elemzés
export function analyzeSamples(wav) {
  const result = {
    format: { sample_rate: wav.sampleRate, channels: wav.channels.length, bits: wav.bits, float: wav.isFloat, duration_seconds: round(wav.duration, 3) },
    notes: []
  };
  let samplePeak = 0;
  let squares = 0;
  for (const ch of wav.channels) {
    for (let n = 0; n < ch.length; n += 1) {
      const a = Math.abs(ch[n]);
      if (a > samplePeak) samplePeak = a;
      squares += ch[n] * ch[n];
    }
  }
  result.silent = samplePeak === 0;
  result.sample_peak_dbfs = round(ampToDb(samplePeak), 2);
  const total = wav.frames * wav.channels.length;
  result.rms_dbfs = round(total ? ampToDb(Math.sqrt(squares / total)) : null, 2);
  if (result.silent) {
    result.notes.push('A felvétel teljesen néma. Ez nem mérési eredmény: valószínűleg a Live nem az előtérben van, a hangmotor ki van kapcsolva, vagy nem szólt semmi a felvétel alatt.');
    return result;
  }
  const phases = interpolationPhases();
  const tp = Math.max(...wav.channels.map((ch) => truePeakOf(ch, phases)));
  result.true_peak_dbtp = round(ampToDb(tp), 2);

  const prefix = weightedPrefix(wav);
  const blocks = windowPowers(prefix, wav.frames, wav.sampleRate, 0.4, 0.1);
  if (blocks.length) {
    const absolute = blocks.filter((b) => toDb(b.power) !== null && toDb(b.power) > -70);
    if (absolute.length) {
      const relativeThreshold = toDb(absolute.reduce((s, b) => s + b.power, 0) / absolute.length) - 10;
      const gated = absolute.filter((b) => toDb(b.power) > relativeThreshold);
      result.integrated_lufs = round(gated.length ? toDb(gated.reduce((s, b) => s + b.power, 0) / gated.length) : null, 2);
    } else {
      result.integrated_lufs = null;
      result.notes.push('A jel -70 LUFS alatti, az integrált hangosság nem értelmezhető.');
    }
    result.momentary_max_lufs = round(Math.max(...blocks.map((b) => toDb(b.power) ?? -Infinity)), 2);
  } else {
    result.integrated_lufs = null;
    result.notes.push('A felvétel 0,4 másodpercnél rövidebb: LUFS nem számítható.');
  }
  const short = windowPowers(prefix, wav.frames, wav.sampleRate, 3, 0.5);
  if (short.length) {
    const values = short.map((w) => ({ t: round(w.end, 2), lufs: round(toDb(w.power), 2) }));
    const finite = values.filter((v) => v.lufs !== null);
    result.short_term = {
      max_lufs: finite.length ? Math.max(...finite.map((v) => v.lufs)) : null,
      min_lufs: finite.length ? Math.min(...finite.map((v) => v.lufs)) : null,
      series: values.filter((_, i) => i % 2 === 0) // másodpercenként
    };
  } else {
    result.short_term = null;
    result.notes.push('A felvétel 3 másodpercnél rövidebb: rövid távú (short-term) LUFS nem számítható.');
  }
  return result;
}

export function analyzeWavFile(path) {
  const buffer = fs.readFileSync(path);
  const wav = readWav(buffer);
  return { file: path, ...analyzeSamples(wav) };
}

const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

// Teszt- és mock-segéd: float32 WAV írása
export function writeWavFloat32(path, channels, sampleRate) {
  const frames = channels[0].length;
  const dataBytes = frames * channels.length * 4;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + dataBytes, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(channels.length, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * channels.length * 4, 28); header.writeUInt16LE(channels.length * 4, 32);
  header.writeUInt16LE(32, 34); header.write('data', 36); header.writeUInt32LE(dataBytes, 40);
  const body = Buffer.alloc(dataBytes);
  let p = 0;
  for (let n = 0; n < frames; n += 1) for (const ch of channels) { body.writeFloatLE(ch[n], p); p += 4; }
  fs.writeFileSync(path, Buffer.concat([header, body]));
}
