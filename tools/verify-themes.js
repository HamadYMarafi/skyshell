/* Theme-surface consistency + contrast gate.
 *
 * index.html carries the SAME theme list in six hand-maintained surfaces:
 *   THEME_ORDER · THEMES (xterm palettes) · THEME_BG · the <head> FOUC-guard
 *   valid-list + bg map · the Settings chips · the [data-theme] CSS blocks.
 * This checker fails the gate whenever any surface drifts.
 *
 * Known-by-design: "mocha" is the bare :root default, so it legitimately has
 * no [data-theme="mocha"] CSS block. Every other surface must carry all 15.
 *
 * Usage: node tools/verify-themes.js [path/to/index.html]   (exit 1 on drift)
 */
const fs = require('fs');
const path = require('path');
const s = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');

function extractLiteral(afterRegex) {
  const m = afterRegex.exec(s);
  if (!m) throw new Error('marker not found: ' + afterRegex);
  let i = m.index + m[0].length - 1; // points at { or [
  const open = s[i], close = open === '{' ? '}' : ']';
  let depth = 0, j = i, inStr = null;
  for (; j < s.length; j++) {
    const c = s[j];
    if (inStr) { if (c === '\\') j++; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'") inStr = c;
    else if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) { j++; break; } }
  }
  return eval('(' + s.slice(i, j) + ')');
}

const THEMES = extractLiteral(/var THEMES\s*=\s*\{/);
const THEME_ORDER = extractLiteral(/var THEME_ORDER\s*=\s*\[/);
const THEME_BG = extractLiteral(/var THEME_BG\s*=\s*\{/);
const guardValid = extractLiteral(/localStorage\.getItem\("term\.theme"\)[\s\S]{0,80}?if \(\[/);
const guardBg = extractLiteral(/var bg = \{/);

const chipNames = [...new Set([...s.matchAll(/data-theme-name="(\w+)"/g)].map(m => m[1]))];
const cssNames = [...new Set([...s.matchAll(/\[data-theme="?(\w+)"?\]/g)].map(m => m[1]))];

const ref = [...THEME_ORDER].sort().join(',');
const refNoDefault = THEME_ORDER.filter(t => t !== 'mocha').sort().join(','); // :root IS mocha
let ok = true;

const sets = {
  THEMES_keys: [Object.keys(THEMES), ref],
  THEME_BG_keys: [Object.keys(THEME_BG), ref],
  guard_valid: [guardValid, ref],
  guard_bg_keys: [Object.keys(guardBg), ref],
  settings_chips: [chipNames, ref],
  css_blocks: [cssNames, cssNames.includes('mocha') ? ref : refNoDefault],
};
for (const [name, [arr, want]] of Object.entries(sets)) {
  const v = [...new Set(arr)].sort().join(',');
  const match = v === want;
  if (!match) ok = false;
  console.log((match ? 'OK  ' : 'FAIL') + ' ' + name + ' (' + new Set(arr).size + ')' + (match ? '' : ' -> ' + v));
}

for (const t of THEME_ORDER) {
  const a = guardBg[t], b = THEME_BG[t], c = (THEMES[t] || {}).background;
  if (!(a === b && b === c)) { ok = false; console.log('BG MISMATCH ' + t + ': guard=' + a + ' THEME_BG=' + b + ' xterm=' + c); }
}

function lum(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(f, bg) { const [a, b] = [lum(f), lum(bg)].sort((x, y) => y - x); return (a + 0.05) / (b + 0.05); }
let worst = ['-', 99];
for (const t of THEME_ORDER) {
  const r = ratio(THEMES[t].foreground, THEMES[t].background);
  if (r < worst[1]) worst = [t, r];
  if (r < 4.5) { ok = false; console.log('CONTRAST FAIL ' + t + ': ' + r.toFixed(2)); }
}
console.log('themes: ' + THEME_ORDER.length + ' · worst contrast: ' + worst[0] + ' ' + worst[1].toFixed(2) + ':1');
if (!ok) { console.error('THEME GATE: DRIFT FOUND'); process.exit(1); }
console.log('THEME GATE: CONSISTENT');
