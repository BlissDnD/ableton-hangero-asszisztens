// "ellenoriz": kapcsolat, tényleges Live-verzió, képességek, hiányzó adatok. Csak olvas.
import { BridgeError } from './bridge.js';

export const REQUIRED_OBSERVE = ['get_script_info', 'get_capabilities', 'describe_set', 'get_properties', 'audio_snapshot', 'get_automation'];
export const REQUIRED_MEASURE = ['create', 'set_properties', 'routing', 'launch', 'get_properties', 'delete', 'describe_set'];

export function parseLiveVersion(text) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text || ''));
  if (!match) return null;
  return { major: +match[1], minor: +match[2], patch: +(match[3] ?? 0), text: match[0] };
}

const add = (checks, status, name, text) => checks.push({ status, name, text });

export async function runCheck(bridge) {
  const checks = [];
  const result = { checks, live: null, script: null, ok: false };

  let info;
  try {
    info = await bridge.send('get_script_info');
  } catch (error) {
    const hint =
      error instanceof BridgeError && error.code === 'REFUSED'
        ? 'Az Ableton nem fut, vagy az AbletonMCP nincs bekapcsolva a Control Surface listában (Preferences → Link, Tempo & MIDI). Lásd: docs/TELEPITES.md.'
        : error.message;
    add(checks, 'hiba', 'Kapcsolat', `Nincs kapcsolat a Remote Scripttel. ${hint}`);
    return result;
  }
  add(checks, 'ok', 'Kapcsolat', `Él a kapcsolat. Remote Script verzió: ${info.script_version}, build: ${info.build_id ?? 'ismeretlen'}.`);
  result.script = { version: info.script_version, build_id: info.build_id ?? null };

  const capabilities = new Set(info.capabilities || []);
  const missingObserve = REQUIRED_OBSERVE.filter((c) => !capabilities.has(c));
  const missingMeasure = REQUIRED_MEASURE.filter((c) => !capabilities.has(c));
  add(
    checks,
    missingObserve.length ? 'hiba' : 'ok',
    'Megfigyelés képességei',
    missingObserve.length ? `Hiányzó parancsok: ${missingObserve.join(', ')}. Valószínűleg részleges vagy régi a telepített Remote Script: futtasd újra a telepitest, és indítsd újra a Livet.` : 'Minden szükséges olvasó parancs elérhető.'
  );
  add(
    checks,
    missingMeasure.length ? 'figyelmeztetés' : 'ok',
    'Mérés képességei',
    missingMeasure.length ? `A hangmérés nem lesz elérhető, hiányzik: ${missingMeasure.join(', ')}.` : 'A hangméréshez szükséges parancsok elérhetők (működésük élőben még nem igazolt).'
  );

  // Tényleges Live-verzió
  let caps = null;
  try {
    caps = await bridge.send('get_capabilities');
  } catch (error) {
    add(checks, 'hiba', 'Live-verzió', `A verzió lekérdezése nem sikerült: ${error.message}`);
  }
  if (caps) {
    const version = parseLiveVersion(caps.live?.version);
    result.live = { version: caps.live?.version ?? null, build: caps.live?.build ?? null, variant: caps.live?.variant ?? null, edition: caps.live?.edition ?? null };
    if (!version) {
      add(checks, 'figyelmeztetés', 'Live-verzió', `A verzió nem értelmezhető: "${caps.live?.version}".`);
    } else if (version.major < 12) {
      add(checks, 'hiba', 'Live-verzió', `Live ${version.text} fut. A Remote Script Live 12-t vagy újabbat igényel.`);
    } else if (version.major === 12 && version.minor < 4) {
      add(
        checks,
        'figyelmeztetés',
        'Live-verzió',
        `Live ${version.text} fut. A felhasznált Remote Script dokumentáció szerint 12.4-en fejlesztett, ezen a verzión nem igazolt. Ha valami hibázik, ezt a sort add meg a hibajelentésben.`
      );
    } else {
      add(checks, 'ok', 'Live-verzió', `Live ${version.text} fut.`);
    }
    add(checks, 'info', 'Kiadás', `Változat: ${caps.live?.variant ?? '?'}. Max for Live elérhető: ${caps.features?.max_for_live ? 'igen' : 'nem'} (ehhez az eszközhöz nem kell).`);
    if (caps.live?.unavailable_features?.length) {
      add(checks, 'info', 'Nem elérhető Live-funkciók', caps.live.unavailable_features.join(', '));
    }
  }

  // Projekt
  try {
    const song = await bridge.send('get_properties', { address: 'song', names: ['name', 'tempo', 'signature_numerator', 'signature_denominator', 'is_playing', 'record_mode', 'exclusive_arm'] });
    const p = song.properties;
    result.song = p;
    add(checks, 'info', 'Projekt', `Név: ${p.name || '(nincs elmentve)'}; tempó: ${p.tempo}; ütemmutató: ${p.signature_numerator}/${p.signature_denominator}; lejátszás: ${p.is_playing ? 'fut' : 'áll'}.`);
    if (p.record_mode) add(checks, 'figyelmeztetés', 'Felvétel', 'Az Arrangement felvétel gomb be van kapcsolva. A mérés előtt kapcsold ki.');
    if (p.exclusive_arm) add(checks, 'info', 'Exkluzív arm', 'Az "exclusive arm" be van kapcsolva: a mérés az ideiglenes sáv felvételre állításakor átmenetileg kikapcsolhat más sávokat. Az eszköz ezt visszaállítja.');
  } catch (error) {
    add(checks, 'hiba', 'Projekt', `A projekt alapadatai nem olvashatók: ${error.message}`);
  }

  try {
    const set = await bridge.send('describe_set', { include_clips: false, include_scenes: false });
    const groups = set.tracks.filter((t) => t.kind === 'group').length;
    add(checks, 'info', 'Szerkezet', `${set.tracks.length} sáv (ebből ${groups} csoport), ${set.returns.length} return, Main. Locator (cue point): ${set.cue_points.length} db.`);
    result.structure = { tracks: set.tracks.length, groups, returns: set.returns.length, cue_points: set.cue_points.length };
  } catch (error) {
    add(checks, 'hiba', 'Szerkezet', `A sávlista nem olvasható: ${error.message}`);
  }

  try {
    const auto = await bridge.send('get_automation', {});
    add(
      checks,
      auto.overridden_count ? 'figyelmeztetés' : 'ok',
      'Automatizálás',
      `${auto.automated_count} automatizált paraméter, ebből felülbírálva: ${auto.overridden_count}.` +
        (auto.overridden_count ? ' A felülbírált paramétereket a Live-ban a "Re-Enable Automation" gombbal lehet visszakapcsolni; a vizsgálat nem nyúl hozzájuk.' : '')
    );
  } catch (error) {
    add(checks, 'figyelmeztetés', 'Automatizálás', `Az automatizálás-áttekintés nem olvasható: ${error.message}`);
  }

  // Arrangement-klip mozgatás lehetősége (csak tájékoztatás a későbbi fejlesztéshez)
  if (capabilities.has('introspect_api')) {
    try {
      const api = await bridge.send('introspect_api', { module: 'Live.Track' });
      const text = JSON.stringify(api);
      const copy = text.includes('duplicate_clip_to_arrangement');
      add(checks, 'info', 'Klip-másolás az idővonalra', copy ? 'A Live API-ban megvan a duplicate_clip_to_arrangement, a későbbi "klip áthelyezése" funkció ezen a verzión megvalósítható lehet.' : 'A duplicate_clip_to_arrangement nem látszik ezen a verzión: a klipek áthelyezése valószínűleg nem megoldható.');
      result.arrangement_copy = copy;
    } catch {
      add(checks, 'info', 'Klip-másolás az idővonalra', 'Nem sikerült megállapítani (nem baj, az MVP-hez nem kell).');
    }
  }

  add(checks, 'info', 'Ismert korlátok', 'A return sávok mérőjét a Live API nem adja ki (0-t mutat). A tempó- és ütemmutató-váltások az idővonalról nem olvashatók, csak az aktuális érték.');
  result.ok = !checks.some((c) => c.status === 'hiba');
  return result;
}

export function renderCheck(result) {
  const icon = { ok: '[OK]  ', figyelmeztetés: '[FIGY] ', hiba: '[HIBA]', info: '[info]' };
  const lines = result.checks.map((c) => `${icon[c.status] ?? '[?]   '} ${c.name}: ${c.text}`);
  lines.push('', result.ok ? 'Eredmény: a kapcsolat használható.' : 'Eredmény: javítandó hiba van, lásd fent.');
  return lines.join('\n');
}
