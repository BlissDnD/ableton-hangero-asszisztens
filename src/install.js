// "telepit": az AbletonMCP Remote Script bemásolása a Live User Library "Remote Scripts" mappájába.
// Windowson a Library.cfg-ből próbálja kitalálni a User Library helyét; ha nem megy, a --konyvtar kapcsoló kell.
// A Library.cfg szerkezetére építő rész élő Windows-gépen még nem lett kipróbálva.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const VENDOR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'AbletonMCP');

export const isDir = (p) => {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
};

const decodeXml = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

export function libraryFromCfg(text) {
  const found = [];
  for (const match of text.matchAll(/Value="([^"]+)"/g)) {
    const value = decodeXml(match[1]).replace(/[\\/]+$/, '');
    if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/')) found.push(value);
  }
  return found;
}

// A Library.cfg gyakran a User Library ALATTI fájlra/mappára mutat (pl. ...\User Library\Templates\x.als):
// mindig a "User Library" mappáig vágjuk vissza az útvonalat.
export function normalizeLibrary(p) {
  const m = /^(.*?[\\/]User Library)(?:[\\/].*)?$/i.exec(p);
  return m ? m[1] : p;
}

export function candidates({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const list = [];
  if (env.ABLETON_USER_LIBRARY) list.push({ path: env.ABLETON_USER_LIBRARY, source: 'ABLETON_USER_LIBRARY környezeti változó' });
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const root = path.join(appData, 'Ableton');
    if (isDir(root)) {
      const versions = fs.readdirSync(root).filter((n) => /^Live \d/.test(n)).sort().reverse();
      for (const v of versions) {
        const cfg = path.join(root, v, 'Preferences', 'Library.cfg');
        if (fs.existsSync(cfg)) {
          for (const p of libraryFromCfg(fs.readFileSync(cfg, 'utf8'))) {
            if (/user library/i.test(p)) {
              const lib = normalizeLibrary(p);
              if (!list.some((c) => c.path === lib)) list.push({ path: lib, source: `${v} / Library.cfg` });
            }
          }
        }
      }
    }
    list.push({ path: path.join(home, 'Documents', 'Ableton', 'User Library'), source: 'alapértelmezett hely' });
  } else if (platform === 'darwin') {
    list.push({ path: path.join(home, 'Music', 'Ableton', 'User Library'), source: 'alapértelmezett hely' });
  } else {
    list.push({ path: path.join(home, 'Documents', 'Ableton', 'User Library'), source: 'alapértelmezett hely' });
  }
  return list;
}

function filesOf(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '__pycache__') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full); else out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

export function looksLikeUserLibrary(p) {
  return /user library/i.test(path.basename(p)) || ['Presets', 'Defaults', 'Samples', 'Remote Scripts'].some((n) => isDir(path.join(p, n)));
}

export function install({ libraryPath, dryRun = false, force = false, vendorDir = VENDOR_DIR } = {}) {
  if (!libraryPath) throw new Error('Nincs User Library útvonal.');
  if (!isDir(libraryPath)) throw new Error(`A mappa nem létezik: ${libraryPath}`);
  if (!force && !looksLikeUserLibrary(libraryPath)) {
    throw new Error(`Ez a mappa nem hasonlít Ableton User Library-re: ${libraryPath}. Ha biztos vagy benne, add hozzá a --biztos kapcsolót.`);
  }
  const target = path.join(libraryPath, 'Remote Scripts', 'AbletonMCP');
  const files = filesOf(vendorDir);
  const result = { target, files: files.length, dryRun, replaced: isDir(target) };
  if (dryRun) return result;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (isDir(target)) fs.rmSync(target, { recursive: true, force: true }); // csak az AbletonMCP mappa
  fs.cpSync(vendorDir, target, { recursive: true, filter: (src) => !src.includes('__pycache__') });
  const bad = files.filter((f) => !fs.existsSync(path.join(target, f)) || sha(path.join(target, f)) !== sha(path.join(vendorDir, f)));
  if (bad.length) throw new Error(`A másolás után eltérő/hiányzó fájlok: ${bad.join(', ')}`);
  return { ...result, verified: true };
}
