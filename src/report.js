// Jelentés: géppel feldolgozható JSON + embernek (és bármely AI-nak) szóló magyar összefoglaló.
import fs from 'node:fs';
import path from 'node:path';
import { slug, timestamp } from './time.js';

export const TOOL = {
  name: 'hangero-asszisztens',
  version: '0.1.0',
  upstream: { repo: 'https://github.com/whybothercoding/ableton-mcp-server', commit: '0a897bf48e032bdd31f36511701b2afaf655eabb', version: '3.0.0' }
};

export const AI_RULES = [
  'Szabályok az elemzéshez (ha AI vagy, tartsd be őket):',
  '- A halkabb zenei rész önmagában nem hiba; vedd figyelembe a megadott szerepet (pl. "lágy verze").',
  '- A teljes dal átlagos hangereje önmagában nem minősíti a mixet.',
  '- A legnagyobb mérő nem bizonyítja, hogy az adott sáv okozza a problémát; a csúcs forrását célzott méréssel kell megerősíteni.',
  '- A magas kimeneti csúcs nem automatikusan indok kompresszorra.',
  '- A "meres" nélküli mérőértékek a Live kalibrálatlan skáláján vannak, nem dBFS/RMS/LUFS.',
  '- A hiányzó adat nem csend. Válaszd külön: mért tény / feltételezés / javasolt ellenőrzés.',
  '- Ne ígérj professzionális mixet, és ne javasolj automatizált hangerő-átírást a felhasználó jóváhagyása nélkül.'
];

function hidePaths(measurement, includePath) {
  if (!measurement || includePath || !measurement.file) return measurement;
  const audio = measurement.audio ? { ...measurement.audio, file: measurement.audio.file?.split(/[\\/]/).pop() } : measurement.audio;
  return { ...measurement, file: measurement.file.split(/[\\/]/).pop(), audio };
}

export function buildReport({ session, summary, check, measurement = null, sideEffects = [], includePath = false, rawFile = null }) {
  const untested = [
    'A csak olvasó megfigyelés (vizsgal) egy élő Live 12.1 futáson működött; a hangmérés (meres) és az automatizálás-részletek még nem lett kipróbálva élőben.',
    'A felhasznált Remote Script (AbletonMCP 3.0.0) dokumentáltan Live 12.4-en fejlesztett; a 12.1-es működés nem igazolt.'
  ];
  if (measurement) untested.push('A belső felvétel (Resampling) és a fájlbeolvasás élő Live-ban nem igazolt; az eredményt vesd össze egy ellenőrző exporttal (lásd docs/TESZT-UTMUTATO.md).');
  return {
    schema: 'hangero-jelentes/1',
    created_at: new Date().toISOString(),
    tool: TOOL,
    project: { name: session.project.name || '(nincs elmentve)', ...(includePath ? { file_path: session.project.file_path } : {}) },
    live: check?.live ?? null,
    role: session.role || null,
    section: summary.window ? { start: summary.window.start, end: summary.window.end, start_beat: summary.window.start_beat, end_beat: summary.window.end_beat, bars: summary.window.bars, stop_reason: summary.window.stop_reason } : null,
    observation: summary,
    measurement: hidePaths(measurement, includePath),
    side_effects: sideEffects,
    not_tested_live: untested,
    ai_rules: AI_RULES,
    raw_file: rawFile
  };
}

const fmt = (v, d = 2) => (v == null ? '–' : typeof v === 'number' ? String(Math.round(v * 10 ** d) / 10 ** d).replace('.', ',') : v);

export function renderMarkdown(report) {
  const o = report.observation;
  const L = [];
  L.push(`# Hangerő-vizsgálat: ${report.project.name}`);
  L.push('', `*Készült: ${report.created_at} · ${report.tool.name} ${report.tool.version}*`, '');
  L.push('> **Fontos:** a csak olvasó megfigyelés élő Ableton 12.1-en egy futásban működött, a hangmérés még nem lett kipróbálva élőben. A mérőértékek a Live saját, nem kalibrált skáláján vannak, kivéve a "Hangmérés" szakaszt.', '');
  L.push('## Mit vizsgáltunk', '');
  L.push(`- **Projekt:** ${report.project.name}${report.project.file_path ? ` (${report.project.file_path})` : ''}`);
  L.push(`- **Live:** ${report.live ? `${report.live.version ?? '?'} (${report.live.variant ?? '?'})` : 'nem ismert'}`);
  L.push(`- **Zenerész szerepe:** ${report.role ?? '(nincs megadva)'}`);
  if (report.section) {
    L.push(`- **Szakasz:** ${report.section.start.text} → ${report.section.end.text} (${report.section.start_beat}–${report.section.end_beat} negyed, kb. ${report.section.bars} ütem)`);
    L.push(`- **Leállás oka:** ${report.section.stop_reason}`);
  }
  L.push('');

  const group = (type, title) => {
    const items = (o.findings || []).filter((f) => f.type === type);
    if (!items.length) return;
    L.push(`## ${title}`, '');
    for (const f of items) L.push(`- ${f.text}${f.check ? `\n  - *Ellenőrzés:* ${f.check}` : ''}`);
    L.push('');
  };
  group('tény', 'Mért tények');
  group('feltételezés', 'Feltételezések (nem bizonyítottak)');

  if (report.measurement) {
    const m = report.measurement;
    L.push('## Hangmérés (valódi felvétel a Main kimenetről)', '');
    if (m.error) {
      L.push(`- A mérés nem sikerült: ${m.error}`);
    } else {
      L.push(`- **Forrás:** ${m.source}`);
      L.push(`- **Felvett időtartomány:** ${m.range.start.text} → ${m.range.end.text} (${fmt(m.range.beats)} negyed, ${fmt(m.audio.format.duration_seconds)} mp fájlidő)`);
      L.push(`- **Integrált hangosság:** ${fmt(m.audio.integrated_lufs)} LUFS`);
      L.push(`- **Rövid távú (3 mp) maximum:** ${fmt(m.audio.short_term?.max_lufs)} LUFS · minimum: ${fmt(m.audio.short_term?.min_lufs)} LUFS`);
      L.push(`- **Pillanatnyi (400 ms) maximum:** ${fmt(m.audio.momentary_max_lufs)} LUFS`);
      L.push(`- **True peak:** ${fmt(m.audio.true_peak_dbtp)} dBTP · **mintacsúcs:** ${fmt(m.audio.sample_peak_dbfs)} dBFS · **RMS:** ${fmt(m.audio.rms_dbfs)} dBFS`);
      L.push(`- **Felvételi fájl:** ${m.file} (a projekt Samples/Recorded mappájában; a mérés nem törli, ha nem kell, töröld kézzel)`);
      for (const n of m.audio.notes ?? []) L.push(`- ⚠ ${n}`);
      L.push('', '> A fenti számokat egy ugyanerről a részről kézzel exportált WAV-on futtatott `hangero elemez <fajl.wav>` eredményével lehet ellenőrizni.');
    }
    L.push('');
  }

  if (o.tracks) {
    L.push('## Sávok a szakaszban', '');
    L.push('| Sáv | Típus | Csoport | Mérő csúcs | Mérő átlag | Szóló arány | Fader (eleje → vége) | Mozgott |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const t of o.tracks) {
      const m = t.meter.available ? [fmt(t.meter.peak), fmt(t.meter.mean), fmt(t.meter.active_share, 2)] : ['n/a', 'n/a', 'n/a'];
      const f = t.fader ? `${t.fader.first_display ?? fmt(t.fader.first, 3)} → ${t.fader.last_display ?? fmt(t.fader.last, 3)}` : '–';
      L.push(`| ${t.name} | ${t.kind} | ${t.group ?? ''} | ${m[0]} | ${m[1]} | ${m[2]} | ${f} | ${t.fader?.moved ? 'igen' : 'nem'} |`);
    }
    L.push('', '*Mérő értékek: Live-egység (0,85 = fader 0 dB jelölés), nem kalibrált. A return sávok mérője nem elérhető.*', '');
  }
  if (o.main?.per_bar?.length) {
    L.push('## Main mérő ütemenként (Live-egység)', '', '| Ütem | Átlag | Csúcs | Minta |', '|---|---|---|---|');
    for (const b of o.main.per_bar) L.push(`| ${b.bar} | ${fmt(b.mean)} | ${fmt(b.peak)} | ${b.samples} |`);
    L.push('');
  }
  if (report.side_effects.length) {
    L.push('## Mellékhatások', '');
    for (const s of report.side_effects) L.push(`- ${s}`);
    L.push('');
  }
  L.push('## Korlátok', '');
  for (const s of [...o.limits, ...report.not_tested_live]) L.push(`- ${s}`);
  L.push('', '## AI-nak szóló szabályok', '');
  for (const r of report.ai_rules) L.push(r);
  L.push('');
  return L.join('\n');
}

export function writeReport(report, dir, { csv = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const base = `jelentes_${timestamp()}_${slug(report.role)}`;
  const jsonPath = path.join(dir, `${base}.json`);
  const mdPath = path.join(dir, `${base}.md`);
  let csvPath = null;
  if (csv) {
    csvPath = path.join(dir, `${base}_nyers.csv`);
    fs.writeFileSync(csvPath, csv);
    report.raw_file = path.basename(csvPath);
  }
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, renderMarkdown(report));
  return { jsonPath, mdPath, csvPath };
}

export function samplesToCsv(session) {
  const addresses = Object.keys(session.meta);
  const head = ['ms', 'beat', 'tempo', ...addresses.flatMap((a) => [`${session.meta[a].name}|${a}|meterL`, 'meterR', 'fader', 'mute', 'muted_via_solo', 'solo'].map((h, i) => (i === 0 ? h : `${session.meta[a].name}|${a}|${h}`)))];
  const rows = session.samples.map((s) => [s.ms, s.beat, s.tempo, ...addresses.flatMap((a) => s.tracks[a] ?? [null, null, null, null, null, null])].join(','));
  return [head.map((h) => `"${h.replace(/"/g, '""')}"`).join(','), ...rows].join('\n');
}
