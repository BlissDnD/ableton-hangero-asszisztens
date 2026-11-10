// "osszehasonlit": két jelentés (módosítás előtt és után) összevetése ugyanazon a részen.
const n = (v, d = 2) => (v == null ? '–' : String(Math.round(v * 10 ** d) / 10 ** d).replace('.', ','));
const diff = (a, b, d = 2) => (a == null || b == null ? '–' : `${b - a >= 0 ? '+' : ''}${n(b - a, d)}`);

export function compareReports(a, b) {
  const lines = [];
  const A = a.observation, B = b.observation;
  lines.push(`ELŐTTE: ${a.created_at} · szerep: ${a.role ?? '–'} · ${a.section?.start?.text ?? '?'} → ${a.section?.end?.text ?? '?'}`);
  lines.push(`UTÁNA:  ${b.created_at} · szerep: ${b.role ?? '–'} · ${b.section?.start?.text ?? '?'} → ${b.section?.end?.text ?? '?'}`, '');
  const warnings = [];
  if (a.section && b.section && Math.abs(a.section.start_beat - b.section.start_beat) > 1) warnings.push('A két jelentés kezdőpontja több mint 1 negyeddel eltér: lehet, hogy nem ugyanazt a részt hasonlítod.');
  if (a.section && b.section && Math.abs(a.section.bars - b.section.bars) > 0.25) warnings.push('A két szakasz hossza eltér.');
  if ((a.role ?? '') !== (b.role ?? '')) warnings.push('A megadott szerep eltér.');
  if (a.project?.name !== b.project?.name) warnings.push('A projekt neve eltér.');
  for (const w of warnings) lines.push(`FIGYELEM: ${w}`);
  if (warnings.length) lines.push('');

  if (a.measurement?.audio && b.measurement?.audio) {
    const x = a.measurement.audio, y = b.measurement.audio;
    lines.push('Valódi hangmérés (előtte → utána, különbség):');
    lines.push(`  Integrált: ${n(x.integrated_lufs)} → ${n(y.integrated_lufs)} LUFS (${diff(x.integrated_lufs, y.integrated_lufs)} LU)`);
    lines.push(`  Rövid távú max: ${n(x.short_term?.max_lufs)} → ${n(y.short_term?.max_lufs)} LUFS (${diff(x.short_term?.max_lufs, y.short_term?.max_lufs)} LU)`);
    lines.push(`  True peak: ${n(x.true_peak_dbtp)} → ${n(y.true_peak_dbtp)} dBTP (${diff(x.true_peak_dbtp, y.true_peak_dbtp)} dB)`);
    lines.push('');
  } else {
    lines.push('Valódi hangmérés nincs mindkét jelentésben, csak a Live mérői hasonlíthatók (kalibrálatlan).', '');
  }
  if (A?.main && B?.main) {
    lines.push(`Main mérő (Live-egység): átlag ${n(A.main.mean)} → ${n(B.main.mean)} (${diff(A.main.mean, B.main.mean)}), csúcs ${n(A.main.peak)} → ${n(B.main.peak)} (${diff(A.main.peak, B.main.peak)})`, '');
  }
  if (A?.tracks && B?.tracks) {
    lines.push('Sávonkénti változás:');
    let any = false;
    for (const tb of B.tracks) {
      const ta = A.tracks.find((t) => t.address === tb.address && t.name === tb.name);
      if (!ta) { lines.push(`  ${tb.name}: új/átnevezett sáv`); any = true; continue; }
      const parts = [];
      if (ta.meter.available && tb.meter.available && Math.abs(tb.meter.mean - ta.meter.mean) >= 0.01) parts.push(`mérő átlag ${n(ta.meter.mean)} → ${n(tb.meter.mean)}`);
      if (ta.fader && tb.fader && (ta.fader.first_display !== tb.fader.first_display || ta.fader.last_display !== tb.fader.last_display)) {
        parts.push(`fader ${ta.fader.first_display} → ${ta.fader.last_display} helyett ${tb.fader.first_display} → ${tb.fader.last_display}`);
      }
      if (parts.length) { lines.push(`  ${tb.name}: ${parts.join('; ')}`); any = true; }
    }
    if (!any) lines.push('  nincs érdemi különbség a sávokban');
  }
  lines.push('', 'Megjegyzés: ez leírja, mi változott, de azt nem mondja meg, hogy jobb lett-e. Az ítélet a te füled és a szerepe a résznek.');
  return lines.join('\n');
}
