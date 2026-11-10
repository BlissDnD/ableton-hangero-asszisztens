// Napló a mérés közbeni változtatásokról, hogy megszakadás után is helyre lehessen állítani.
// A napló fájlban él (nem a Live-ban), ezért a Live vagy ez a program összeomlása után is megvan.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const journalDir = () => process.env.HANGERO_HOME || path.join(os.homedir(), '.hangero-asszisztens');
export const journalPath = () => path.join(journalDir(), 'journal.json');

export function readJournal() {
  try {
    return JSON.parse(fs.readFileSync(journalPath(), 'utf8'));
  } catch {
    return null;
  }
}

export function writeJournal(entry) {
  fs.mkdirSync(journalDir(), { recursive: true });
  fs.writeFileSync(journalPath(), JSON.stringify({ ...entry, updated_at: new Date().toISOString() }, null, 2));
}

export function clearJournal() {
  try {
    fs.unlinkSync(journalPath());
  } catch {
    /* nincs mit törölni */
  }
}
