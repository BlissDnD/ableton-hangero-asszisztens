// Idő- és pozíciószámítás. A Live a lejátszási helyet negyedhangokban (beat) adja.
// Fontos: a Live API-ja az idővonalon lévő tempó- és ütemmutató-váltásokat nem adja ki,
// csak az éppen érvényes értéket. Ezért a mintavételezett értékekből dolgozunk.

export const barLengthBeats = (numerator = 4, denominator = 4) => (numerator * 4) / denominator;

export function beatsToPosition(beats, numerator = 4, denominator = 4) {
  const barLength = barLengthBeats(numerator, denominator);
  const unit = 4 / denominator; // egy ütésegység hossza negyedhangban
  const bar = Math.floor(beats / barLength + 1e-9) + 1;
  const inBar = beats - (bar - 1) * barLength;
  const beat = Math.floor(inBar / unit + 1e-9) + 1;
  const fraction = Math.round((inBar / unit - (beat - 1)) * 1000) / 1000;
  return { bar, beat, fraction, text: `${bar}. ütem ${beat}. ütés${fraction > 0 ? ` (+${String(fraction).replace('.', ',')})` : ''}` };
}

export const barToBeats = (bar, numerator = 4, denominator = 4) => (bar - 1) * barLengthBeats(numerator, denominator);

export function formatSeconds(seconds) {
  if (!Number.isFinite(seconds)) return '?';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}

export const round = (value, digits = 3) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null);

export const slug = (text) =>
  String(text || 'nincs-szerep')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'nincs-szerep';

export function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}
