// Végigtesztelés SZIMULÁLT Live ellen. Ez nem igazolja a valódi Ableton működését.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.js';
import { runCheck, renderCheck } from '../src/check.js';
import { observe } from '../src/observe.js';
import { summarize } from '../src/analysis.js';
import { measure, recover, SCRATCH_NAME } from '../src/measure.js';
import { buildReport, renderMarkdown, writeReport, samplesToCsv } from '../src/report.js';
import { readJournal } from '../src/journal.js';
import { compareReports } from '../src/compare.js';
import { install, candidates, libraryFromCfg } from '../src/install.js';
import { parseArgs, main } from '../src/cli.js';
import { MockLive } from '../testkit/mock-live.js';

process.env.HANGERO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hangero-home-'));
const WRITES = ['set_properties', 'create', 'launch', 'delete', 'routing', 'transport'];

async function withMock(options, fn) {
  const mock = new MockLive(options);
  const port = await mock.listen();
  const bridge = new Bridge({ host: '127.0.0.1', port, timeoutMs: 3000 });
  try { await fn(mock, bridge); } finally { mock.stop(); await mock.close(); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('ellenoriz: kapcsolat, verzió, képességek (12.1 -> figyelmeztetés a nem igazolt verzióra)', async () => {
  await withMock({}, async (mock, bridge) => {
    const r = await runCheck(bridge);
    assert.equal(r.ok, true);
    assert.equal(r.live.version, '12.1.10');
    const v = r.checks.find((c) => c.name === 'Live-verzió');
    assert.equal(v.status, 'figyelmeztetés');
    assert.match(renderCheck(r), /12\.1\.10/);
    assert.ok(r.arrangement_copy === true);
    assert.deepEqual(mock.commandLog.filter((c) => WRITES.includes(c)), [], 'az ellenőrzés nem írhat');
  });
});

test('ellenoriz: nincs kapcsolat -> érthető hibaüzenet', async () => {
  const r = await runCheck(new Bridge({ host: '127.0.0.1', port: 1, timeoutMs: 500 }));
  assert.equal(r.ok, false);
  assert.match(r.checks[0].text, /nincs bekapcsolva|Control Surface/);
});

test('ellenoriz: Live 11 -> hiba', async () => {
  await withMock({ version: '11.3.4' }, async (_m, bridge) => {
    const r = await runCheck(bridge);
    assert.equal(r.ok, false);
  });
});

test('vizsgal: csak olvas, követi az automatizált fader változását, projekt változatlan', async () => {
  await withMock({}, async (mock, bridge) => {
    mock.play(40);
    const session = await observe(bridge, { role: 'lágy verze', intervalMs: 40, maxSeconds: 2, waitSeconds: 2 });
    const summary = summarize(session);
    assert.deepEqual(mock.commandLog.filter((c) => WRITES.includes(c)), [], 'a megfigyelés nem írhat');
    const bass = summary.tracks.find((t) => t.name === 'Bass');
    assert.equal(bass.fader.moved, true);
    assert.ok(bass.fader.last < bass.fader.first, 'a basszus fader lefelé automatizált');
    assert.ok(bass.fader.first_display.includes('dB'));
    assert.equal(summary.automation.newly_overridden.length, 0, 'az automatizálást nem bíráltuk felül');
    assert.equal(summary.project_unchanged, true, 'a szerkezeti ujjlenyomat nem változhat, hiába mozog az automatizált fader');
    assert.ok(summary.tracks.find((t) => t.name === 'Pad 2').muted_whole_time);
    assert.equal(summary.tracks.find((t) => t.name === 'A-Reverb').meter.available, false, 'a return mérője n/a, nem csend');
    assert.ok(summary.main.peak > 0);
    assert.ok(summary.sampling.count >= 10);
    assert.ok(summary.findings.some((f) => f.type === 'feltételezés' && /lágy verze/.test(f.text)));
    assert.ok(summary.window.start_beat >= 40 && summary.window.end_beat > summary.window.start_beat);
    assert.equal(summary.window.start.bar, 11);
    assert.equal(mock.rec, null);
  });
});

test('vizsgal: a lejátszás leállása után lezár; ütemtartomány szerint indul és áll meg', async () => {
  await withMock({}, async (mock, bridge) => {
    mock.play(40);
    setTimeout(() => mock.stop(), 500);
    const s1 = await observe(bridge, { intervalMs: 40, maxSeconds: 5, waitSeconds: 2 });
    assert.match(s1.stopReason, /leállt/);

    mock.play(40);
    const s2 = await observe(bridge, { intervalMs: 30, maxSeconds: 5, waitSeconds: 3, fromBar: 13, toBar: 15 });
    const sum = summarize(s2);
    assert.ok(sum.window.start_beat >= 48 - 1e-6 && sum.window.start_beat < 49.5, `start ${sum.window.start_beat}`);
    assert.ok(sum.window.end_beat <= 56 + 1e-6, `end ${sum.window.end_beat}`);
    assert.match(s2.stopReason, /15\. ütem/);
  });
});

test('vizsgal: ha nem indul el a lejátszás, érthető hiba, és semmi nem változik', async () => {
  await withMock({}, async (mock, bridge) => {
    await assert.rejects(observe(bridge, { waitSeconds: 0.4 }), /nem indult el/);
    assert.deepEqual(mock.commandLog.filter((c) => WRITES.includes(c)), []);
  });
});

test('vizsgal: felülbírált automatizálást jelez, de nem nyúl hozzá', async () => {
  await withMock({ overridden: true }, async (mock, bridge) => {
    mock.play(50);
    const session = await observe(bridge, { intervalMs: 50, maxSeconds: 0.6, waitSeconds: 2 });
    const summary = summarize(session);
    assert.equal(summary.automation.overridden_before.length, 1);
    assert.ok(summary.findings.some((f) => /Felülbírált automatizálás/.test(f.text) && /Re-Enable/.test(f.check)));
    assert.deepEqual(mock.commandLog.filter((c) => WRITES.includes(c)), []);
  });
});

test('vizsgal: minden mérő 0 -> nem csendként, hanem háttérben futó Live gyanújaként jelenik meg', async () => {
  await withMock({}, async (mock, bridge) => {
    mock.levelOf = () => 0;
    mock.masterLevel = () => 0;
    mock.play(40);
    const summary = summarize(await observe(bridge, { intervalMs: 50, maxSeconds: 0.5, waitSeconds: 2 }));
    assert.ok(summary.findings.some((f) => /Minden mérő végig 0/.test(f.text) && /előtér/.test(f.check)));
  });
});

test('meres: sikeres futás, mérés, teljes helyreállítás, csak a megengedett írások', async () => {
  await withMock({}, async (mock, bridge) => {
    mock.recAmplitude = 0.2;
    mock.play(40);
    const writes = [];
    mock.hooks.set_properties = (p) => writes.push(p);
    const stateBefore = JSON.stringify(mock.tracks.map((t) => [t.name, t.arm, t.mute, t.vol, t.monitoring, t.input]));
    const result = await measure(bridge, { role: 'erős refrén', bars: 4, intervalMs: 40, waitSeconds: 2 });

    assert.ok(!result.measurement.error, result.measurement.error);
    const a = result.measurement.audio;
    assert.ok(Math.abs(a.integrated_lufs - -13.98) < 0.3, `integrált ${a.integrated_lufs}`);
    assert.ok(Math.abs(a.sample_peak_dbfs - -13.98) < 0.1);
    assert.equal(result.measurement.range.beats > 15.5 && result.measurement.range.beats < 16.6, true, `${result.measurement.range.beats}`);
    assert.ok(fs.existsSync(result.measurement.file), 'a felvétel fájl megmarad');

    // csak ezek az írások engedélyezettek, hangerő soha
    for (const w of writes) assert.ok(Object.keys(w.properties).every((k) => ['arm', 'current_monitoring_state', 'selected_track'].includes(k)), JSON.stringify(w));
    assert.ok(!mock.tracks.some((t) => t.name === SCRATCH_NAME), 'az ideiglenes sáv törölve');
    assert.equal(JSON.stringify(mock.tracks.map((t) => [t.name, t.arm, t.mute, t.vol, t.monitoring, t.input])), stateBefore, 'minden sávállapot visszaállt (arm is)');
    assert.equal(mock.selectedTrack, 'tracks/2');
    assert.equal(readJournal(), null, 'sikeres futás után nincs függő napló');
    assert.deepEqual(result.problems, []);
    assert.ok(result.sideEffects.some((s) => /Ctrl\+Z/.test(s)) && result.sideEffects.some((s) => /ujjlenyomata a mérés előtt és után azonos/.test(s)));

    // összekapcsolás az ugyanakkor naplózott sávállapotokkal
    assert.ok(result.summary.tracks.find((t) => t.name === 'Bass').fader.moved, 'a felvétel alatti basszus-automatizálás látszik');
    assert.ok(result.summary.window.start_beat >= result.measurement.range.start_beat - 0.5);
    assert.ok(result.summary.window.end_beat <= result.measurement.range.end_beat + 0.5);

    const report = buildReport({ session: result.session, summary: result.summary, check: await runCheck(bridge), measurement: result.measurement, sideEffects: result.sideEffects });
    const md = renderMarkdown(report);
    assert.ok(!JSON.stringify(report).includes(path.dirname(result.measurement.file)), 'a teljes útvonal nincs a jelentésben');
    assert.ok(!md.includes(path.dirname(result.measurement.file)));
    assert.match(md, /Hangmérés/);
    assert.match(md, /LUFS/);
    assert.match(md, /Mellékhatások/);
    assert.match(md, /Live 12\.1-gyel még nem lett kipróbálva|nem lett kipróbálva/);
  });
});

test('meres: megszakítás (Ctrl+C) közben is rendet rak', async () => {
  await withMock({}, async (mock, bridge) => {
    mock.play(40);
    const controller = new AbortController();
    mock.hooks.launch = () => setTimeout(() => controller.abort(), 100);
    const stateBefore = JSON.stringify(mock.tracks.map((t) => [t.name, t.arm, t.monitoring, t.input]));
    const result = await measure(bridge, { bars: 4, intervalMs: 40, signal: controller.signal });
    assert.ok(result.measurement.error);
    assert.ok(!mock.tracks.some((t) => t.name === SCRATCH_NAME));
    assert.equal(JSON.stringify(mock.tracks.map((t) => [t.name, t.arm, t.monitoring, t.input])), stateBefore);
    assert.equal(readJournal(), null);
  });
});

test('meres: nem erősíti meg a felhasználó -> semmi nem változik', async () => {
  await withMock({}, async (mock, bridge) => {
    mock.play(40);
    await assert.rejects(measure(bridge, { bars: 2, confirm: async () => false }), /megszakítottad/);
    assert.deepEqual(mock.commandLog.filter((c) => WRITES.includes(c)), []);
  });
});

test('meres: a törlés hibázik -> napló marad, helyreallit rendbe teszi', async () => {
  await withMock({}, async (mock, bridge) => {
    mock.recAmplitude = 0.1;
    mock.play(40);
    let failures = 1;
    mock.hooks.delete = () => { if (failures-- > 0) { const e = new Error('szimulált hiba'); e.code = 'LIVE_ERROR'; throw e; } };
    const result = await measure(bridge, { bars: 2, intervalMs: 40 });
    assert.ok(result.problems.some((p) => p.startsWith('VISSZAÁLLÍTÁSI')));
    assert.ok(mock.tracks.some((t) => t.name === SCRATCH_NAME), 'a sáv bennmaradt');
    assert.equal(readJournal().status, 'incomplete');

    // újabb mérés nem indulhat félbemaradt után
    await assert.rejects(measure(bridge, { bars: 2 }), /helyreallit/);

    const fixed = await recover(bridge);
    assert.equal(fixed.changed, true);
    assert.ok(!mock.tracks.some((t) => t.name === SCRATCH_NAME));
    assert.equal(mock.tracks[2].arm, true, 'a basszus arm állapota visszaállt');
    assert.equal(readJournal(), null);
    assert.ok(fixed.lines.some((l) => /ujjlenyomata megegyezik/.test(l)));
  });
});

test('helyreallit: nincs mit helyreállítani; napló nélküli sáv csak megerősítéssel törlődik', async () => {
  await withMock({}, async (mock, bridge) => {
    assert.equal((await recover(bridge)).changed, false);
    mock.tracks.push(mock.mk(SCRATCH_NAME, 'audio', null, { scratch: true }));
    const ask = await recover(bridge);
    assert.equal(ask.needsConfirm, true);
    assert.ok(mock.tracks.some((t) => t.name === SCRATCH_NAME));
    await recover(bridge, { assumeYes: true });
    assert.ok(!mock.tracks.some((t) => t.name === SCRATCH_NAME));
  });
});

test('jelentés: alapból nincs benne a teljes útvonal; íródik JSON, MD és CSV', async () => {
  await withMock({}, async (mock, bridge) => {
    mock.play(40);
    const session = await observe(bridge, { role: 'erős refrén', intervalMs: 40, maxSeconds: 0.6, waitSeconds: 2 });
    const summary = summarize(session);
    const report = buildReport({ session, summary, check: await runCheck(bridge) });
    assert.equal(report.project.file_path, undefined);
    assert.ok(!JSON.stringify(report).includes('teszt\\\\Mock'));
    const withPath = buildReport({ session, summary, check: null, includePath: true });
    assert.ok(withPath.project.file_path.includes('Mock_Projekt'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-'));
    const files = writeReport(report, dir, { csv: samplesToCsv(session) });
    assert.ok(fs.existsSync(files.jsonPath) && fs.existsSync(files.mdPath) && fs.existsSync(files.csvPath));
    const parsed = JSON.parse(fs.readFileSync(files.jsonPath, 'utf8'));
    assert.equal(parsed.schema, 'hangero-jelentes/1');
    assert.ok(parsed.ai_rules.length > 3 && parsed.not_tested_live.length >= 2);
    const md = fs.readFileSync(files.mdPath, 'utf8');
    assert.match(md, /Mért tények/);
    assert.match(md, /Feltételezések/);
    assert.match(md, /Korlátok/);
    assert.match(md, /halkabb zenei rész önmagában nem hiba/);
    assert.equal(parsed.observation.tracks.length, 7); // 5 sáv + 1 return + Main
  });
});

test('osszehasonlit: figyelmeztet, ha nem ugyanaz a rész', () => {
  const mk = (start, lufs, role) => ({ created_at: 'x', role, project: { name: 'P' }, section: { start: { text: 'a' }, end: { text: 'b' }, start_beat: start, bars: 8 },
    measurement: { audio: { integrated_lufs: lufs, true_peak_dbtp: -2, short_term: { max_lufs: lufs + 1 } } }, observation: { main: { mean: 0.3, peak: 0.6 }, tracks: [] } });
  const same = compareReports(mk(40, -16.9, 'erős refrén'), mk(40, -15.6, 'erős refrén'));
  assert.match(same, /\+1,3 LU/);
  assert.doesNotMatch(same, /FIGYELEM/);
  const diff = compareReports(mk(40, -16.9, 'erős refrén'), mk(80, -15.6, 'lágy verze'));
  assert.match(diff, /nem ugyanazt a részt/);
  assert.match(diff, /szerep eltér/);
});

test('telepit: User Library felismerés, másolás, ellenőrzés, védelem rossz mappa ellen', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-'));
  const lib = path.join(root, 'Ableton', 'User Library');
  fs.mkdirSync(lib, { recursive: true });
  const dry = install({ libraryPath: lib, dryRun: true });
  assert.ok(dry.files > 20 && !fs.existsSync(dry.target));
  const done = install({ libraryPath: lib });
  assert.equal(done.verified, true);
  assert.ok(fs.existsSync(path.join(lib, 'Remote Scripts', 'AbletonMCP', '__init__.py')));
  fs.writeFileSync(path.join(lib, 'Remote Scripts', 'AbletonMCP', 'regi.txt'), 'x');
  install({ libraryPath: lib });
  assert.ok(!fs.existsSync(path.join(lib, 'Remote Scripts', 'AbletonMCP', 'regi.txt')), 'a régi fájlok eltűnnek');
  const random = path.join(root, 'valami');
  fs.mkdirSync(random);
  assert.throws(() => install({ libraryPath: random }), /nem hasonlít/);
  assert.throws(() => install({ libraryPath: path.join(root, 'nincs') }), /nem létezik/);
  assert.deepEqual(libraryFromCfg('<A Value="D:\\Zene\\User Library\\"/><B Value="12"/><C Value="x"/>'), ['D:\\Zene\\User Library']);
  assert.ok(candidates({ env: { ABLETON_USER_LIBRARY: 'Q:\\X' }, platform: 'win32', home: root })[0].path === 'Q:\\X');
});

test('CLI: kapcsolók feldolgozása és súgó', async () => {
  assert.deepEqual(parseArgs(['vizsgal', '--szerep', 'lágy verze', '--nyers', '--tol-utem', '49']), { _: ['vizsgal'], szerep: 'lágy verze', nyers: true, 'tol-utem': '49' });
  assert.throws(() => parseArgs(['vizsgal', '--szerep']), /érték kell/);
  assert.equal(await main(['sugo']), 0);
  assert.equal(await main(['nincsilyen']), 2);
});

test('CLI vizsgal végigfuttatva a szimulált Live ellen', async () => {
  await withMock({}, async (mock) => {
    mock.play(40);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
    const code = await main(['vizsgal', '--port', String(mock.port), '--szerep', 'lágy verze', '--max-masodperc', '1', '--kozonkent', '50', '--ki', out, '--nyers']);
    assert.equal(code, 0);
    assert.equal(fs.readdirSync(out).length, 3);
  });
});

test('hosszabb, élőhöz közeli futás: ritka hibák nem állítják meg a naplózást', async () => {
  await withMock({}, async (mock, bridge) => {
    mock.play(40);
    let n = 0;
    mock.hooks.audio_snapshot = () => { n += 1; if (n === 6 || n === 7) { const e = new Error('szimulált szakadás'); e.drop = true; throw e; } };
    const session = await observe(bridge, { intervalMs: 40, maxSeconds: 1, waitSeconds: 2 });
    assert.equal(session.gaps.length, 2);
    assert.ok(session.samples.length > 8);
    assert.ok(summarize(session).findings.some((f) => /2 lekérdezés hibázott/.test(f.text)));
  });
});
