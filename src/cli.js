#!/usr/bin/env node
// Parancssori felület: hangero <parancs> [kapcsolók]
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Bridge } from './bridge.js';
import { runCheck, renderCheck } from './check.js';
import { observe } from './observe.js';
import { summarize } from './analysis.js';
import { buildReport, renderMarkdown, samplesToCsv, writeReport, TOOL } from './report.js';
import { measure, planText, recover } from './measure.js';
import { analyzeWavFile } from './audio.js';
import { candidates, install } from './install.js';
import { compareReports } from './compare.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const HELP = `Hangerő-asszisztens ${TOOL.version} (Ableton Live-hoz)

Használat:  hangero <parancs> [kapcsolók]

Parancsok:
  telepit          A Remote Script bemásolása az Ableton User Library-be (egyszer kell, utána Live újraindítás)
  ellenoriz        Kapcsolat, Live-verzió, képességek ellenőrzése (csak olvas)
  vizsgal          Egy zenerész megfigyelése lejátszás közben, jelentés készítése (csak olvas)
  meres            Valódi hangmérés a Main kimenetről: LUFS, true peak (ideiglenes sávot hoz létre!)
  elemez <fajl>    Egy WAV fájl LUFS / true peak elemzése (ellenőrző exporthoz, Ableton nélkül is megy)
  osszehasonlit <elotte.json> <utana.json>   Két jelentés összevetése
  helyreallit      Félbemaradt mérés után az ideiglenes sáv és az arm állapotok helyreállítása
  sugo             Ez a súgó

vizsgal / meres kapcsolók:
  --szerep "lágy verze"   A rész szerepe (pl. "erős refrén")
  --tol-utem 49           Innen kezdve naplóz/mér (opcionális; enélkül ott, ahol épp a lejátszás tart)
  --ig-utem 57            (vizsgal) eddig naplóz
  --utem 8                (meres) ennyi ütemet vesz fel (alapérték 8)
  --max-masodperc 60      (vizsgal) legfeljebb ennyi másodpercig naplóz
  --kozonkent 200         mintavételi köz ezredmásodpercben (alapérték 200)
  --ki jelentesek         ide menti a jelentést
  --nyers                 a nyers mintákat is menti CSV-be
  --utvonal               a projekt teljes útvonalát is beleírja a jelentésbe (alapból csak a nevet)
  --igen                  (meres) megerősítés kérdés nélkül
Általános: --port 9877  --host 127.0.0.1  --json (csak JSON a képernyőre)
`;

export function parseArgs(argv) {
  const out = { _: [] };
  const valued = new Set(['szerep', 'tol-utem', 'ig-utem', 'utem', 'max-masodperc', 'kozonkent', 'ki', 'port', 'host', 'konyvtar']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (valued.has(key)) {
        if (i + 1 >= argv.length) throw new Error(`A(z) --${key} kapcsolóhoz érték kell.`);
        out[key] = argv[++i];
      } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

const num = (v, name) => {
  if (v == null) return null;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n)) throw new Error(`A(z) --${name} értéke szám legyen.`);
  return n;
};

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim().toLowerCase()); }));
}

function makeBridge(args) {
  return new Bridge({ host: args.host, port: args.port ? Number(args.port) : 9877 });
}

function installSigint() {
  const controller = new AbortController();
  let count = 0;
  process.on('SIGINT', () => {
    count += 1;
    if (count === 1) { console.log('\nMegszakítás kérve, rendet rakok…'); controller.abort(); } else process.exit(130);
  });
  return controller;
}

function printSummary(report) {
  const o = report.observation;
  console.log('');
  for (const type of ['tény', 'feltételezés']) {
    const items = (o.findings || []).filter((f) => f.type === type);
    if (!items.length) continue;
    console.log(type === 'tény' ? 'MÉRT TÉNYEK' : 'FELTÉTELEZÉSEK (nem bizonyítottak)');
    for (const f of items) console.log(`  - ${f.text}${f.check ? `\n      ellenőrzés: ${f.check}` : ''}`);
    console.log('');
  }
  if (report.measurement && !report.measurement.error) {
    const a = report.measurement.audio;
    console.log('HANGMÉRÉS (valódi felvétel)');
    console.log(`  Integrált: ${a.integrated_lufs ?? '–'} LUFS | rövid távú max: ${a.short_term?.max_lufs ?? '–'} LUFS | true peak: ${a.true_peak_dbtp ?? '–'} dBTP | RMS: ${a.rms_dbfs ?? '–'} dBFS`);
    for (const note of a.notes ?? []) console.log(`  ! ${note}`);
    console.log('');
  } else if (report.measurement?.error) {
    console.log(`A HANGMÉRÉS NEM SIKERÜLT: ${report.measurement.error}\n`);
  }
}

export async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0] ?? 'sugo';

  switch (command) {
    case 'sugo':
    case 'help':
      console.log(HELP);
      return 0;

    case 'telepit': {
      const list = candidates();
      let lib = args.konyvtar;
      if (!lib) {
        const found = list.find((c) => fs.existsSync(c.path));
        if (!found) {
          console.log('Nem találom az Ableton User Library mappát. Nézd meg az Abletonban (Preferences → Library → User Library), és add meg:\n  hangero telepit --konyvtar "C:\\...\\User Library"');
          return 1;
        }
        lib = found.path;
        console.log(`User Library (${found.source}): ${lib}`);
      }
      const result = install({ libraryPath: lib, dryRun: Boolean(args.proba), force: Boolean(args.biztos) });
      console.log(args.proba ? `Próbafutás: ${result.files} fájlt másolnék ide: ${result.target}` : `Kész: ${result.files} fájl bemásolva ide: ${result.target} (ellenőrizve).`);
      console.log('Következő lépés: indítsd újra az Ableton Live-ot, majd Preferences → Link, Tempo & MIDI → Control Surface: AbletonMCP, Input és Output: None.');
      return 0;
    }

    case 'ellenoriz': {
      const result = await runCheck(makeBridge(args));
      console.log(args.json ? JSON.stringify(result, null, 2) : renderCheck(result));
      return result.ok ? 0 : 1;
    }

    case 'vizsgal': {
      const bridge = makeBridge(args);
      const check = await runCheck(bridge);
      if (!check.ok) { console.log(renderCheck(check)); return 1; }
      console.log(`Live ${check.live?.version ?? '?'} · Remote Script ${check.script.version}`);
      const controller = installSigint();
      const session = await observe(bridge, {
        role: args.szerep ?? '', fromBar: num(args['tol-utem'], 'tol-utem'), toBar: num(args['ig-utem'], 'ig-utem'),
        maxSeconds: num(args['max-masodperc'], 'max-masodperc') ?? 60, intervalMs: num(args.kozonkent, 'kozonkent') ?? 200,
        signal: controller.signal, log: (m) => console.log(m)
      });
      const summary = summarize(session);
      const report = buildReport({ session, summary, check, includePath: Boolean(args.utvonal) });
      const files = writeReport(report, args.ki ?? path.join(ROOT, 'jelentesek'), { csv: args.nyers ? samplesToCsv(session) : null });
      if (args.json) console.log(JSON.stringify(report, null, 2)); else printSummary(report);
      console.log(`Jelentés (embernek): ${files.mdPath}\nJelentés (AI-nak, JSON): ${files.jsonPath}${files.csvPath ? `\nNyers minták: ${files.csvPath}` : ''}`);
      return summary.empty ? 1 : 0;
    }

    case 'meres': {
      const bridge = makeBridge(args);
      const check = await runCheck(bridge);
      if (!check.ok) { console.log(renderCheck(check)); return 1; }
      const controller = installSigint();
      const result = await measure(bridge, {
        role: args.szerep ?? '', bars: num(args.utem, 'utem') ?? 8, fromBar: num(args['tol-utem'], 'tol-utem'),
        intervalMs: num(args.kozonkent, 'kozonkent') ?? 200, signal: controller.signal, log: (m) => console.log(m),
        confirm: async (plan) => {
          console.log(`\n${planText(plan)}\n`);
          if (args.igen) return true;
          return ['i', 'igen', 'y', 'yes'].includes(await ask('Mehet? (i/n): '));
        }
      });
      const session = result.session ?? { project: { name: '', file_path: '' }, role: args.szerep ?? '', samples: [], meta: {} };
      const summary = result.summary ?? { findings: [], limits: [], window: null };
      const report = buildReport({ session: { ...session, role: args.szerep ?? session.role }, summary, check, measurement: result.measurement, sideEffects: result.sideEffects, includePath: Boolean(args.utvonal) });
      const files = writeReport(report, args.ki ?? path.join(ROOT, 'jelentesek'), { csv: args.nyers && session.samples.length ? samplesToCsv(session) : null });
      if (args.json) console.log(JSON.stringify(report, null, 2)); else printSummary(report);
      console.log('MELLÉKHATÁSOK');
      for (const s of result.sideEffects) console.log(`  - ${s}`);
      console.log(`\nJelentés (embernek): ${files.mdPath}\nJelentés (AI-nak, JSON): ${files.jsonPath}`);
      return result.measurement?.error || result.problems.some((p) => p.startsWith('VISSZAÁLLÍTÁSI')) ? 1 : 0;
    }

    case 'elemez': {
      const file = args._[1];
      if (!file) { console.log('Add meg a WAV fájl útvonalát: hangero elemez "C:\\\\export.wav"'); return 2; }
      const r = analyzeWavFile(file);
      if (args.json) { console.log(JSON.stringify(r, null, 2)); return 0; }
      console.log(`Fájl: ${file}\nFormátum: ${r.format.sample_rate} Hz, ${r.format.channels} csatorna, ${r.format.bits} bit, ${r.format.duration_seconds} mp`);
      console.log(`Integrált: ${r.integrated_lufs ?? '–'} LUFS\nRövid távú max: ${r.short_term?.max_lufs ?? '–'} LUFS (min ${r.short_term?.min_lufs ?? '–'})\nPillanatnyi max: ${r.momentary_max_lufs ?? '–'} LUFS\nTrue peak: ${r.true_peak_dbtp ?? '–'} dBTP\nMintacsúcs: ${r.sample_peak_dbfs ?? '–'} dBFS\nRMS: ${r.rms_dbfs ?? '–'} dBFS`);
      for (const n of r.notes) console.log(`! ${n}`);
      return 0;
    }

    case 'osszehasonlit': {
      const [, a, b] = args._;
      if (!a || !b) { console.log('Használat: hangero osszehasonlit elotte.json utana.json'); return 2; }
      console.log(compareReports(JSON.parse(fs.readFileSync(a, 'utf8')), JSON.parse(fs.readFileSync(b, 'utf8'))));
      return 0;
    }

    case 'helyreallit': {
      const result = await recover(makeBridge(args), { assumeYes: Boolean(args.igen) });
      for (const l of result.lines) console.log(l);
      return 0;
    }

    default:
      console.log(`Ismeretlen parancs: ${command}\n\n${HELP}`);
      return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`\nHIBA: ${error.message}`);
      process.exit(1);
    }
  );
}
