/* app.js — UI for the matrix calculator (needs symbolic.js + core.js) */
(() => {
'use strict';
const K = window.MatrixCore;
const SY = window.Symbolic;
const { Expr, display, toInput } = SY;
const MAX_DIM = 12;

/* ------------------------------------------------------------------ state */
const state = {
  A: { rows: 3, cols: 3, cells: [] },
  B: { rows: 3, cols: 3, cells: [] },
  target: 'A',
  proj: 'AB',        // 'AB': project the vector A onto B · 'BA': the reverse
  mode: 'frac',
  precision: 4,
  assignSrc: '',
  assign: {},        // name -> Expr
  assignNum: {},     // name -> number
};
const $ = (sel, el = document) => el.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};

/* ------------------------------------------------------------ formatting */
const opts = () => ({ mode: state.mode, precision: state.precision });
const minus = (s) => s.replace(/-/g, '−');
function fmtDec(x) {
  if (!isFinite(x)) return String(x);
  if (Math.abs(x) < 0.5 * 10 ** -state.precision) x = 0;
  let s = Number.isInteger(x) ? String(x) : x.toFixed(state.precision).replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return minus(s);
}
function fmtComplex(z) {
  const eps = 0.5 * 10 ** -state.precision;
  const re = Math.abs(z.re) < eps ? 0 : z.re, im = Math.abs(z.im) < eps ? 0 : z.im;
  if (im === 0) return fmtDec(re);
  const imS = Math.abs(im) === 1 ? '' : fmtDec(Math.abs(im));
  if (re === 0) return (im < 0 ? '−' : '') + imS + 'i';
  return `${fmtDec(re)} ${im < 0 ? '−' : '+'} ${imS}i`;
}
const isComplex = (x) => x && typeof x === 'object' && 're' in x;
const fmtCell = (x) => (isComplex(x) ? fmtComplex(x) : display(x, opts()));
const isZeroCell = (x) => (isComplex(x) ? Math.abs(x.re) < 1e-12 && Math.abs(x.im) < 1e-12 : x.isZero());

// numeric value of an Expr under the current variable assignments, or null
function approxOf(e) {
  if (isComplex(e)) return e;
  const parts = e.splitImag();
  if (!parts) return null;
  const re = parts[0].evalNum(state.assignNum), im = parts[1].evalNum(state.assignNum);
  if (re === null || im === null) return null;
  return { re, im };
}
// "≈ 1.4142" when the exact form is not already a plain number
function approxNote(e) {
  if (isComplex(e)) return null;
  if (e.constVal() !== null && state.mode === 'dec') return null;
  const a = approxOf(e);
  if (a === null) return null;
  if (e.constVal() !== null) {
    const c = e.constVal();
    if (c.isInteger() || state.mode === 'dec') return null;
    if (c.d <= 1000n) return null;   // ordinary fractions read fine as they are
  }
  return `≈ ${fmtComplex(a)}`;
}

/* -------------------------------------------------------------- rendering */
function matrixEl(M, o = {}) {
  const table = el('table');
  const pivotSet = new Set((o.pivots || []).map(([r, c]) => `${r},${c}`));
  M.forEach((row, i) => {
    const tr = el('tr');
    row.forEach((x, j) => {
      const td = el('td', {}, fmtCell(x));
      if (o.aug !== undefined && j === o.aug) td.classList.add('aug');
      if (pivotSet.has(`${i},${j}`)) td.classList.add('pivot');
      else if (isZeroCell(x)) td.classList.add('zero');
      tr.append(td);
    });
    table.append(tr);
  });
  const wrap = el('div', { class: 'matwrap' }, el('div', { class: 'mat' }, table));
  if (o.caption) wrap.append(el('div', { class: 'cap' }, o.caption));
  const sendable = o.sendable && M.length && M[0].length && !isComplex(M[0][0]) && M.length <= MAX_DIM && M[0].length <= MAX_DIM;
  if (sendable) {
    wrap.append(el('div', { class: 'send' },
      el('button', { class: 'small', onclick: () => loadMatrix('A', M) }, '→ A'),
      el('button', { class: 'small', onclick: () => loadMatrix('B', M) }, '→ B')));
  }
  return wrap;
}
const colVec = (v, o) => matrixEl(v.map((x) => [x]), o);
function vectorList(vs, o = {}) {
  if (!vs.length) return el('span', { class: 'trivial' }, '{ 0 }  (only the zero vector)');
  return el('div', { class: 'vecs' }, vs.map((v, i) => colVec(v, Object.assign({ caption: o.name ? `${o.name}${i + 1}` : undefined }, o))));
}
const row = (...items) => el('div', { class: 'row' }, ...items);
const opSym = (s) => el('span', { class: 'op' }, s);
const scalarEl = (e) => {
  const n = approxNote(e);
  return el('span', {}, el('span', { class: 'big' }, fmtCell(e)), n ? el('span', { class: 'note approx' }, ' ' + n) : null);
};

// an expression used as a row-operation factor, bracketed when it is a sum
function factorStr(e) {
  const s = fmtCell(e);
  return /[+\s]/.test(s.trim()) && !/^−?[\d/.]+$/.test(s) ? `(${s})` : s;
}
function stepDesc(op) {
  if (op.kind === 'swap') return `R${op.i + 1} ↔ R${op.j + 1}`;
  if (op.kind === 'scale') return `R${op.i + 1} ← ${factorStr(op.factor)} · R${op.i + 1}`;
  const f = op.factor;
  const neg = !isComplex(f) && f.constVal() !== null && f.constVal().sign() < 0;
  return neg ? `R${op.i + 1} ← R${op.i + 1} + ${factorStr(f.neg())} · R${op.j + 1}`
             : `R${op.i + 1} ← R${op.i + 1} − ${factorStr(f)} · R${op.j + 1}`;
}
function stepsDetails(steps, o = {}, label = 'Show row operations') {
  if (!steps || !steps.length) return el('p', { class: 'note' }, 'No row operations were needed.');
  return el('details', {}, el('summary', {}, `${label} (${steps.length})`),
    el('div', { class: 'steps' }, steps.map((s, i) =>
      el('div', { class: 'step' }, el('div', { class: 'desc' }, `${i + 1}. ${stepDesc(s)}`), matrixEl(s.matrix, o)))));
}
const pivotCells = (pivots) => pivots.map((c, r) => [r, c]);

// "Valid wherever x ≠ 0 and x − 1 ≠ 0" — pivots had to be assumed nonzero
function assumptionNote(list) {
  if (!list || !list.length) return null;
  const parts = list.map((e) => `${fmtCell(e)} ≠ 0`);
  return el('p', { class: 'note assume' }, el('span', { class: 'label' }, 'Assumes:'),
    parts.join('  and  '), ' — a pivot was taken to be nonzero, so the result is the generic case.');
}

// projection needs a divisor (v·v, a Gram pivot …) that symbolic input could make vanish
function nonzeroNote(list, what) {
  if (!list || !list.length) return null;
  return el('p', { class: 'note assume' }, el('span', { class: 'label' }, 'Assumes:'),
    list.map((e) => `${fmtCell(e)} ≠ 0`).join('  and  '), ` — ${what} must be nonzero for the formula to apply; otherwise the result is the generic case.`);
}
// a 1×n "vector" has a one-dimensional column space, which is rarely what was meant
function singleRowNote(M, name) {
  if (M.length !== 1 || M[0].length < 2) return null;
  return el('p', { class: 'note assume' }, el('span', { class: 'label' }, 'Note:'),
    `${name} is a single row, so its column space is ℝ¹. To project onto the line spanned by it, enter it as an n×1 column (or use “onto a vector”).`);
}

// the construction P = B (BᵀB)⁻¹ Bᵀ, one stage at a time
function projectionSteps(r, M, name) {
  if (r.k === 0) return el('p', { class: 'note' }, `${name} has no nonzero column, so there are no steps: P is the zero matrix.`);
  const k = r.k;
  const stage = (n, title, hint, ...body) => el('div', { class: 'subspace' },
    el('h3', {}, `Step ${n}: ${title}`), hint ? el('p', { class: 'note' }, hint) : null, ...body);
  const inv = r.Ginv;
  return el('div', { class: 'projsteps' },
    stage(1, 'find an independent set of columns',
      `Row-reduce ${name}; the pivot columns (${r.pivots.map((c) => c + 1).join(', ')}) of the original matrix are linearly independent and span the same space.`,
      row(matrixEl(M, { caption: name }), opSym('→'), matrixEl(r.R, { caption: `rref(${name})`, pivots: pivotCells(r.pivots) })),
      stepsDetails(r.rrefSteps)),
    stage(2, 'collect them into B',
      `B holds columns ${r.pivots.map((c) => c + 1).join(', ')} of ${name}, so its columns are a basis of the space (${r.m}×${k}).`,
      row(matrixEl(r.B, { caption: 'B' }), opSym('→ transpose →'), matrixEl(r.Bt, { caption: 'Bᵀ' }))),
    stage(3, 'form the Gram matrix  BᵀB',
      `Every entry is a dot product of two basis vectors (${k}×${k}).`,
      row(matrixEl(r.Bt, { caption: 'Bᵀ' }), opSym('×'), matrixEl(r.B, { caption: 'B' }), opSym('='), matrixEl(r.G, { caption: 'BᵀB' }))),
    stage(4, 'invert it with Gauss–Jordan',
      'Row-reduce [BᵀB | I] to [I | (BᵀB)⁻¹].',
      row(matrixEl(inv.augmented, { aug: k, caption: '[BᵀB | I]' }), opSym('→'), matrixEl(inv.reduced, { aug: k, caption: '[I | (BᵀB)⁻¹]' })),
      row(el('span', { class: 'label' }, '(BᵀB)⁻¹ ='), matrixEl(inv.inverse)),
      stepsDetails(inv.steps, { aug: k })),
    stage(5, 'multiply  B (BᵀB)⁻¹',
      null,
      row(matrixEl(r.B, { caption: 'B' }), opSym('×'), matrixEl(inv.inverse, { caption: '(BᵀB)⁻¹' }), opSym('='), matrixEl(r.BGinv, { caption: 'B (BᵀB)⁻¹' }))),
    stage(6, 'multiply by Bᵀ to get P',
      null,
      row(matrixEl(r.BGinv, { caption: 'B (BᵀB)⁻¹' }), opSym('×'), matrixEl(r.Bt, { caption: 'Bᵀ' }), opSym('='), matrixEl(r.P, { caption: 'P', sendable: true }))));
}

/* ------------------------------------------------------------ input grids */
function buildPanel(name) {
  const panel = $(`#panel-${name}`);
  const st = state[name];
  panel.innerHTML = '';
  const rowsIn = el('input', { type: 'number', min: 1, max: MAX_DIM, value: st.rows });
  const colsIn = el('input', { type: 'number', min: 1, max: MAX_DIM, value: st.cols });
  const onDim = () => {
    const r = clampDim(rowsIn.value), c = clampDim(colsIn.value);
    rowsIn.value = r; colsIn.value = c;
    resize(name, r, c);
    renderGrid(name);
  };
  rowsIn.addEventListener('change', onDim);
  colsIn.addEventListener('change', onDim);
  panel.append(
    el('div', { class: 'head' },
      el('h2', {}, `Matrix ${name}`),
      el('div', { class: 'dims' }, rowsIn, '×', colsIn),
      el('div', { class: 'varnote', id: `vars-${name}` })),
    el('div', { class: 'grid-wrap' }, el('div', { class: 'grid' })),
    el('div', { class: 'tools' },
      el('button', { class: 'small', onclick: () => fill(name, (i, j) => (i === j ? '1' : '0')) }, 'Identity'),
      el('button', { class: 'small', onclick: () => fill(name, () => '0') }, 'Zeros'),
      el('button', { class: 'small', onclick: () => fill(name, () => String(Math.floor(Math.random() * 19) - 9)) }, 'Random'),
      el('button', { class: 'small', onclick: () => fill(name, () => '') }, 'Clear'),
      el('button', { class: 'small', onclick: () => { try { loadMatrix(name, K.transpose(readMatrix(name))); } catch (e) { showError(e.message); } } }, 'Transpose in place'),
      el('button', { class: 'small', onclick: () => { try { loadMatrix(name === 'A' ? 'B' : 'A', readMatrix(name)); } catch (e) { showError(e.message); } } }, `Copy to ${name === 'A' ? 'B' : 'A'}`),
      el('button', { class: 'small', onclick: () => substituteInto(name) }, 'Substitute'),
      el('button', { class: 'small', onclick: () => pasteDialog(name) }, 'Paste…')));
  renderGrid(name);
}
const clampDim = (v) => Math.min(MAX_DIM, Math.max(1, parseInt(v, 10) || 1));
function resize(name, r, c) {
  const st = state[name];
  st.cells = Array.from({ length: r }, (_, i) => Array.from({ length: c }, (_, j) => (st.cells[i] && st.cells[i][j] !== undefined ? st.cells[i][j] : '0')));
  st.rows = r; st.cols = c;
}
const cellWidth = (v) => `${Math.min(220, Math.max(64, String(v).length * 8.6 + 20))}px`;
function renderGrid(name) {
  const st = state[name];
  const grid = $(`#panel-${name} .grid`);
  grid.innerHTML = '';
  grid.style.gridTemplateColumns = `repeat(${st.cols}, auto)`;
  for (let i = 0; i < st.rows; i++) for (let j = 0; j < st.cols; j++) {
    const inp = el('input', { type: 'text', value: st.cells[i][j], 'aria-label': `${name}[${i + 1},${j + 1}]`, spellcheck: 'false' });
    inp.style.width = cellWidth(st.cells[i][j]);
    inp.addEventListener('input', () => {
      st.cells[i][j] = inp.value;
      inp.style.width = cellWidth(inp.value);
      try { Expr.parse(inp.value); inp.classList.remove('bad'); inp.title = ''; }
      catch (e) { inp.classList.add('bad'); inp.title = e.message; }
      updateVarNote(name);
    });
    inp.addEventListener('focus', () => inp.select());
    inp.addEventListener('paste', (ev) => {
      const text = (ev.clipboardData || window.clipboardData).getData('text');
      if (/[\n;]/.test(text.trim()) || text.trim().split(/[\s,]+/).length > 1) { ev.preventDefault(); loadFromText(name, text); }
    });
    inp.addEventListener('keydown', (ev) => {
      const map = { ArrowUp: [-1, 0], ArrowDown: [1, 0], Enter: [1, 0] };
      if (!(ev.key in map)) return;
      const [di, dj] = map[ev.key];
      const ni = i + di, nj = j + dj;
      if (ni < 0 || ni >= st.rows || nj < 0 || nj >= st.cols) return;
      ev.preventDefault();
      grid.children[ni * st.cols + nj].focus();
    });
    grid.append(inp);
  }
  updateVarNote(name);
}
function updateVarNote(name) {
  const box = $(`#vars-${name}`);
  if (!box) return;
  let vars = [];
  try { vars = K.matrixVars(readMatrix(name)); } catch { box.textContent = ''; return; }
  box.textContent = vars.length ? `symbols: ${vars.map(SY.displayName).join(', ')}` : '';
}
function fill(name, fn) {
  const st = state[name];
  st.cells = st.cells.map((r, i) => r.map((_, j) => fn(i, j)));
  renderGrid(name);
}
function loadMatrix(name, M) {
  const st = state[name];
  st.rows = M.length; st.cols = M[0].length;
  st.cells = M.map((r) => r.map((x) => toInput(x)));
  const panel = $(`#panel-${name}`);
  const [ri, ci] = panel.querySelectorAll('.dims input');
  ri.value = st.rows; ci.value = st.cols;
  renderGrid(name);
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
// drop a wrapping [ … ] or ( … ), but never the closing paren of something like sin(x)
function stripOuter(line) {
  const l = line.trim();
  const close = { '[': ']', '(': ')' }[l[0]];
  if (!close || l[l.length - 1] !== close) return l;
  const inner = l.slice(1, -1);
  let depth = 0;
  for (const ch of inner) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') { depth--; if (depth < 0) return l; }
  }
  return depth === 0 ? inner : l;
}
function loadFromText(name, text) {
  const rows = text.trim().split(/\r?\n|;/).map((l) => l.trim()).filter(Boolean)
    .map((l) => stripOuter(l).split(/[\s,]+|\|/).filter(Boolean));
  if (!rows.length) return;
  const c = Math.max(...rows.map((r) => r.length));
  if (rows.length > MAX_DIM || c > MAX_DIM) { showError(`Pasted matrix is ${rows.length}×${c}; the maximum is ${MAX_DIM}×${MAX_DIM}`); return; }
  state[name].rows = rows.length; state[name].cols = c;
  state[name].cells = rows.map((r) => Array.from({ length: c }, (_, j) => (r[j] !== undefined ? r[j] : '0')));
  const [ri, ci] = $(`#panel-${name}`).querySelectorAll('.dims input');
  ri.value = rows.length; ci.value = c;
  renderGrid(name);
}
function pasteDialog(name) {
  const text = window.prompt(`Paste matrix ${name}: one row per line (or separated by ";"), entries separated by spaces, commas or "|".\nExample:\ncos(t)  -sin(t)\nsin(t)   cos(t)`);
  if (text) loadFromText(name, text);
}
function readMatrix(name) {
  try { return K.parseMatrix(state[name].cells); }
  catch (e) { throw new Error(`Matrix ${name}: ${e.message}`); }
}
function substituteInto(name) {
  try {
    readAssignments();
    if (!Object.keys(state.assign).length) { showError('No variable values set — type something like  x = 2, theta = pi/4  in the Variables box first.'); return; }
    loadMatrix(name, K.substMatrix(readMatrix(name), state.assign));
  } catch (e) { showError(e.message); }
}

/* --------------------------------------------------------------- results */
const results = $('#results');
function card(title, ...children) {
  const c = el('div', { class: 'card' }, el('h2', {}, title), ...children);
  results.prepend(c);
  c.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return c;
}
function showError(msg) { results.prepend(el('div', { class: 'card error' }, el('h2', {}, 'Error'), el('p', {}, msg))); }

/* ------------------------------------------------------------ operations */
const sup = (k) => String(k).replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d]);
const charPolyString = (coefs) => {
  let out = '';
  const n = coefs.length - 1;
  coefs.forEach((c, i) => {
    const k = n - i;
    if (c.isZero()) return;
    const s = fmtCell(c);
    const neg = s.startsWith('−');
    const mag = neg ? s.slice(1) : s;
    const needs = /[+\s−]/.test(mag);
    const body = k === 0 ? (needs ? `(${mag})` : mag)
      : `${mag === '1' ? '' : (needs ? `(${mag})` : mag)}λ${k === 1 ? '' : sup(k)}`;
    out += out === '' ? (neg ? '−' + body : body) : (neg ? ` − ${body}` : ` + ${body}`);
  });
  return out || '0';
};

const ops = {
  mul() { const A = readMatrix('A'), B = readMatrix('B'); const P = K.mul(A, B);
    card('A × B', row(matrixEl(A, { caption: 'A' }), opSym('×'), matrixEl(B, { caption: 'B' }), opSym('='),
      matrixEl(P, { caption: `A × B  (${P.length}×${P[0].length})`, sendable: true }))); },
  mulBA() { const A = readMatrix('A'), B = readMatrix('B'); const P = K.mul(B, A);
    card('B × A', row(matrixEl(B, { caption: 'B' }), opSym('×'), matrixEl(A, { caption: 'A' }), opSym('='),
      matrixEl(P, { caption: `B × A  (${P.length}×${P[0].length})`, sendable: true }))); },
  add() { const A = readMatrix('A'), B = readMatrix('B');
    card('A + B', row(matrixEl(A), opSym('+'), matrixEl(B), opSym('='), matrixEl(K.add(A, B), { sendable: true }))); },
  sub() { const A = readMatrix('A'), B = readMatrix('B');
    card('A − B', row(matrixEl(A), opSym('−'), matrixEl(B), opSym('='), matrixEl(K.sub(A, B), { sendable: true }))); },

  dot() {
    const u = K.asVector(readMatrix('A')), v = K.asVector(readMatrix('B'));
    const d = K.dot(u, v);
    const nu = K.dot(u, u), nv = K.dot(v, v);
    const terms = u.map((x, i) => `(${fmtCell(x)})(${fmtCell(v[i])})`).join(' + ');
    const extra = [];
    if (!nu.isZero() && !nv.isZero()) {
      extra.push(el('p', {}, el('span', { class: 'label' }, '‖u‖ ='), el('span', { class: 'math' }, fmtCell(K.norm(u))), '   ',
        el('span', { class: 'label' }, '‖v‖ ='), el('span', { class: 'math' }, fmtCell(K.norm(v)))));
      const dn = d.evalNum(state.assignNum), a = nu.evalNum(state.assignNum), b = nv.evalNum(state.assignNum);
      if (dn !== null && a !== null && b !== null && a > 0 && b > 0) {
        const ang = Math.acos(Math.max(-1, Math.min(1, dn / Math.sqrt(a * b)))) * 180 / Math.PI;
        extra.push(el('p', {}, el('span', { class: 'label' }, 'Angle between u and v:'), el('span', { class: 'math' }, `${fmtDec(ang)}°`)));
      }
      if (d.isZero()) extra.push(el('p', {}, el('span', { class: 'badge ok' }, 'orthogonal'), ' u · v = 0 for every value of the symbols.'));
    }
    card('Dot product  u · v',
      row(colVec(u, { caption: 'u' }), opSym('·'), colVec(v, { caption: 'v' }), opSym('='), scalarEl(d)),
      el('p', { class: 'math note' }, `u · v = ${terms} = ${fmtCell(d)}`), ...extra);
  },
  cross() {
    const u = K.asVector(readMatrix('A')), v = K.asVector(readMatrix('B'));
    const w = K.cross(u, v);
    card('Cross product  u ⨯ v',
      row(colVec(u, { caption: 'u' }), opSym('⨯'), colVec(v, { caption: 'v' }), opSym('='), colVec(w, { caption: 'u ⨯ v', sendable: true })),
      el('p', { class: 'math note' }, 'u ⨯ v = ( u₂v₃ − u₃v₂,  u₃v₁ − u₁v₃,  u₁v₂ − u₂v₁ )'),
      el('p', { class: 'note' }, `Check: (u ⨯ v) · u = ${fmtCell(K.dot(w, u))},  (u ⨯ v) · v = ${fmtCell(K.dot(w, v))} — the result is orthogonal to both.`),
      el('p', { class: 'note' }, el('span', { class: 'label' }, '‖u ⨯ v‖ ='), el('span', { class: 'math' }, fmtCell(K.norm(w))),
        ' (area of the parallelogram spanned by u and v)'));
  },
  projVec() {
    const [src, dst] = state.proj;
    const u = K.asVector(readMatrix(src)), v = K.asVector(readMatrix(dst));
    const r = K.projectOntoVector(u, v);
    const terms = (a, b) => a.map((x, i) => `(${fmtCell(x)})(${fmtCell(b[i])})`).join(' + ');
    // with symbols the simplified quotient is a mess, so keep it as (u·v)/‖v‖
    const compStr = r.vv.constVal() !== null ? fmtCell(r.comp) : `(${fmtCell(r.uv)}) / (${fmtCell(K.norm(v))})`;
    card(`Projection of ${src} onto ${dst}  (vector onto vector)`,
      row(colVec(u, { caption: `u = ${src}` }), opSym('onto'), colVec(v, { caption: `v = ${dst}` }), opSym('='),
        colVec(r.proj, { caption: 'proj_v u', sendable: true })),
      el('p', { class: 'math note' }, 'proj_v u = (u · v) / (v · v) · v'),
      el('p', { class: 'math note' }, `u · v = ${terms(u, v)} = ${fmtCell(r.uv)}`),
      el('p', { class: 'math note' }, `v · v = ${terms(v, v)} = ${fmtCell(r.vv)}`),
      el('p', {}, el('span', { class: 'label' }, 'Coefficient:'), el('span', { class: 'math' }, `(u · v)/(v · v) = ${fmtCell(r.coef)}`),
        approxNote(r.coef) ? el('span', { class: 'note approx' }, ' ' + approxNote(r.coef)) : null),
      el('p', {}, el('span', { class: 'label' }, 'Scalar component:'), el('span', { class: 'math' }, `comp_v u = (u · v)/‖v‖ = ${compStr}`),
        approxNote(r.comp) ? el('span', { class: 'note approx' }, ' ' + approxNote(r.comp)) : null,
        el('span', { class: 'note' }, '  (signed length of the shadow of u along v)')),
      row(el('span', { class: 'label' }, 'Orthogonal part  u − proj_v u ='), colVec(r.perp, { caption: 'u⊥', sendable: true })),
      el('p', { class: 'note' }, r.check.isZero()
        ? 'Check: (u − proj_v u) · v = 0  ✓  — the remainder is perpendicular to v, so u = proj_v u + u⊥ is the orthogonal decomposition.'
        : `Check: (u − proj_v u) · v = ${fmtCell(r.check)}`),
      nonzeroNote(r.assumptions, 'v · v'));
  },
  projSpace() {
    const [src, dst] = state.proj;
    const b = K.asVector(readMatrix(src));
    const M = readMatrix(dst);
    const r = K.projectOntoColumnSpace(M, b);
    const kids = [
      row(colVec(b, { caption: `b = ${src}` }), opSym('onto C(' + dst + ')'), matrixEl(M, { caption: `${dst}  (${r.m}×${r.n})` }), opSym('='),
        colVec(r.proj, { caption: 'p = proj b', sendable: true })),
      singleRowNote(M, dst),
      el('p', { class: 'note' }, `The vector space is the column space of ${dst}: the span of its columns, of dimension ${r.k}. ` +
        'The projection p is the point of that space closest to b, found from the normal equations (BᵀB) x̂ = Bᵀb, with B a basis of independent columns; then p = B x̂.'),
    ];
    if (r.k === 0) {
      kids.push(el('p', {}, el('span', { class: 'badge warn' }, 'zero subspace'), ` ${dst} has no nonzero column, so the space is { 0 } and the projection is the zero vector.`));
      card(`Projection of ${src} onto the column space of ${dst}`, ...kids);
      return;
    }
    kids.push(el('div', { class: 'subspace' },
      el('h3', {}, 'Basis B ', el('span', { class: 'note' }, `— pivot columns ${r.pivots.map((c) => c + 1).join(', ')} of ${dst}`)),
      row(matrixEl(r.B, { caption: 'B', sendable: true }))));
    kids.push(el('div', { class: 'subspace' },
      el('h3', {}, 'Normal equations'),
      row(matrixEl(r.G, { caption: 'BᵀB' }), opSym('· x̂ ='), colVec(r.Mtb, { caption: 'Bᵀb' }),
        opSym('⟹'), colVec(r.xhat, { caption: 'x̂ = (BᵀB)⁻¹ Bᵀb' }))));
    kids.push(row(el('span', { class: 'label' }, 'p = B x̂ ='), colVec(r.proj, { caption: 'p', sendable: true }),
      el('span', { class: 'label', style: 'margin-left:16px' }, 'e = b − p ='), colVec(r.perp, { caption: 'e (⟂ to the space)', sendable: true })));
    if (r.inSpace) {
      kids.push(el('p', {}, el('span', { class: 'badge ok' }, 'b is in the space'), ' b already lies in the column space, so p = b and the error e is 0.'));
    } else {
      kids.push(el('p', { class: 'note' }, el('span', { class: 'label' }, 'Distance from b to the space:'), el('span', { class: 'math' }, `‖e‖ = ${fmtCell(K.norm(r.perp))}`),
        approxNote(K.norm(r.perp)) ? el('span', { class: 'note approx' }, ' ' + approxNote(K.norm(r.perp))) : null));
    }
    kids.push(el('p', { class: 'note' }, r.residualCheck.every((x) => x.isZero())
      ? 'Check: Bᵀ e = 0  ✓  — the error is orthogonal to every basis vector, hence to the whole space.'
      : `Check: Bᵀ e = (${r.residualCheck.map(fmtCell).join(', ')})`));
    kids.push(el('details', {}, el('summary', {}, 'Projection matrix  P = B (BᵀB)⁻¹ Bᵀ   (p = P b) — show the steps'),
      projectionSteps(r, M, dst)));
    kids.push(nonzeroNote(r.assumptions, 'these pivots and Gram-matrix pivots'));
    card(`Projection of ${src} onto the column space of ${dst}`, ...kids);
  },
  projMatrix() {
    const dst = state.proj[1];
    const M = readMatrix(dst);
    const r = K.projectionMatrix(M);
    const I = K.identity(r.m);
    const ok = (b) => (b ? '✓' : '✗');
    card(`Projection matrix onto the column space of ${dst}`,
      row(matrixEl(M, { caption: `${dst}  (${r.m}×${M[0].length})` }), opSym('→'), matrixEl(r.P, { caption: `P = B (BᵀB)⁻¹ Bᵀ`, sendable: true })),
      singleRowNote(M, dst),
      el('p', { class: 'note' }, `B is the independent (pivot) columns of ${dst}: ${r.pivots.length ? r.pivots.map((c) => c + 1).join(', ') : 'none'}. P b is the projection of any b ∈ ℝ${sup(r.m)} onto the space, which has dimension ${r.k}.`),
      el('p', { class: 'note' }, `P² = P  ${ok(r.idempotent)}   Pᵀ = P  ${ok(r.symmetric)}   rank P = trace P = ${fmtCell(r.trace)}`),
      row(el('span', { class: 'label' }, 'I − P  (projects onto the orthogonal complement):'), matrixEl(r.complement, { caption: 'I − P', sendable: true })),
      el('details', { open: '' }, el('summary', {}, 'Show the steps'), projectionSteps(r, M, dst)),
      nonzeroNote(r.assumptions, 'these pivots and Gram-matrix pivots'));
  },
  norm() {
    const T = state.target, M = readMatrix(T);
    const [r, c] = K.dims(M);
    const line = (label, math, e, extra) => el('p', {}, el('span', { class: 'label' }, label), el('span', { class: 'math' }, math + fmtCell(e)),
      approxNote(e) ? el('span', { class: 'note approx' }, ' ' + approxNote(e)) : null, extra ? el('span', { class: 'note' }, '  ' + extra) : null);
    const pick = (res, what) => (res ? line(what.label, what.math(res), res.value, what.extra(res))
      : el('p', { class: 'note' }, `${what.label} needs numeric values — enter values for the symbols in Variables to compare entries.`));
    if (r === 1 || c === 1) {
      const v = K.asVector(M);
      const n = K.vectorNorms(v, state.assignNum);
      const sumSq = v.map((x) => `(${fmtCell(x)})²`).join(' + ');
      const kids = [
        row(colVec(v, { caption: T }), opSym('→'), el('span', {}, el('span', { class: 'big' }, `‖${T}‖ = ${fmtCell(n.l2)}`),
          approxNote(n.l2) ? el('span', { class: 'note approx' }, ' ' + approxNote(n.l2)) : null),
          n.zero ? el('span', { class: 'badge no' }, 'zero vector') : null),
        el('p', { class: 'math note' }, `‖v‖₂ = √(v₁² + … + vₙ²) = √(${sumSq}) = √(${fmtCell(n.sq)})` + (`√(${fmtCell(n.sq)})` === fmtCell(n.l2) ? '' : ` = ${fmtCell(n.l2)}`)),
        line('1-norm', '‖v‖₁ = |v₁| + … + |vₙ| = ', n.l1, '(taxicab / Manhattan length)'),
        pick(n.linf, { label: '∞-norm', math: (m) => `‖v‖∞ = max |vᵢ| = (entry ${m.index + 1}) `, extra: () => '(largest absolute entry)' }),
      ];
      if (n.zero) kids.push(el('p', { class: 'note' }, 'The zero vector has no direction, so it cannot be normalized.'));
      else {
        kids.push(row(el('span', { class: 'label' }, 'Unit vector  v / ‖v‖ ='), colVec(n.unit, { caption: 'û', sendable: true })));
        kids.push(el('p', { class: 'note' }, `Check: ‖û‖ = ${fmtCell(K.norm(n.unit))}  ✓  — same direction as ${T}, length 1.`));
      }
      kids.push(nonzeroNote(n.assumptions, 'v · v'));
      card(`Norm of ${T}  (vector in ℝ${sup(v.length)})`, ...kids);
      return;
    }
    const n = K.matrixNorms(M, state.assignNum);
    const kids = [
      row(matrixEl(M, { caption: `${T}  (${r}×${c})` })),
      line('Frobenius', `‖${T}‖F = √(Σ aᵢⱼ²) = √(${fmtCell(n.frobeniusSq)}) = `, n.frobenius),
      pick(n.l1, { label: '1-norm', math: (m) => `‖${T}‖₁ = max column sum of |aᵢⱼ| = (column ${m.index + 1}) `, extra: () => `column sums: ${n.colSums.map(fmtCell).join(', ')}` }),
      pick(n.linf, { label: '∞-norm', math: (m) => `‖${T}‖∞ = max row sum of |aᵢⱼ| = (row ${m.index + 1}) `, extra: () => `row sums: ${n.rowSums.map(fmtCell).join(', ')}` }),
    ];
    if (n.spectral) {
      kids.push(n.spectral.value
        ? line('Spectral', `‖${T}‖₂ = σmax = √(λmax(${T}ᵀ${T})) = `, n.spectral.value)
        : el('p', {}, el('span', { class: 'label' }, 'Spectral'), el('span', { class: 'math' }, `‖${T}‖₂ = σmax = √(λmax(${T}ᵀ${T})) ≈ ${fmtDec(n.spectral.approx)}`),
          el('span', { class: 'note' }, '  (numerical: AᵀA has no closed-form eigenvalues)')));
    } else {
      kids.push(el('p', { class: 'note' }, 'The spectral norm (largest singular value) is available for matrices without symbols.'));
    }
    card(`Norms of ${T}`, ...kids);
  },
  gramschmidt() {
    const T = state.target, M = readMatrix(T);
    const g = K.gramSchmidt(M);
    const sub = (k) => String(k).replace(/\d/g, (d) => '₀₁₂₃₄₅₆₇₈₉'[d]);
    const kids = [];
    if (g.rank === 0) {
      card(`Gram–Schmidt on the columns of ${T}`, el('p', {}, el('span', { class: 'badge warn' }, 'zero matrix'), ` Every column of ${T} is zero, so there is no basis to orthogonalize.`));
      return;
    }
    kids.push(el('p', { class: 'note' }, `Each column is made orthogonal to the ones before it by subtracting its projections: vⱼ = aⱼ − Σ (aⱼ·vᵢ)/(vᵢ·vᵢ) · vᵢ. Normalizing the vⱼ gives Q, and R = Qᵀ${T}, so that ${T} = QR.`));
    kids.push(row(matrixEl(M, { caption: T }), opSym('='), matrixEl(g.Q, { caption: `Q  (${g.m}×${g.rank}, orthonormal columns)`, sendable: true }),
      opSym('×'), matrixEl(g.R, { caption: `R  (${g.rank}×${g.n}, upper triangular)`, sendable: true })));
    kids.push(el('p', { class: 'note' },
      `Check: Q R = ${T}  ${g.verified ? '✓' : '✗'}     QᵀQ = I  ${g.orthonormal ? '✓' : '✗'}`));
    if (g.dependent.length) {
      kids.push(el('p', {}, el('span', { class: 'badge warn' }, 'dependent columns'),
        ` Column${g.dependent.length === 1 ? '' : 's'} ${g.dependent.map((j) => j + 1).join(', ')} of ${T} already lie${g.dependent.length === 1 ? 's' : ''} in the span of the earlier ones, so ${g.dependent.length === 1 ? 'it was' : 'they were'} skipped. Q has ${g.rank} column${g.rank === 1 ? '' : 's'} (reduced QR); the rank of ${T} is ${g.rank}.`));
    }
    // the work, column by column
    const stepEls = g.steps.map((st) => {
      const j = st.col;
      const body = [];
      if (!st.terms.length) {
        body.push(el('p', { class: 'note' }, j === 0 ? 'The first column starts the basis: v₁ = a₁.' : `Nothing to subtract: v${sub(j + 1)} = a${sub(j + 1)}.`));
      } else {
        for (const t of st.terms) {
          body.push(el('p', { class: 'math note' },
            `(a${sub(j + 1)}·v${sub(t.from + 1)}) / (v${sub(t.from + 1)}·v${sub(t.from + 1)}) = (${fmtCell(t.num)}) / (${fmtCell(t.den)}) = ${fmtCell(t.coef)}`));
        }
        body.push(row(colVec(st.a, { caption: `a${sub(j + 1)}` }),
          ...st.terms.flatMap((t) => [opSym('−'), colVec(t.vec, { caption: `(${fmtCell(t.coef)}) · v${sub(t.from + 1)}` })]),
          opSym('='), colVec(st.v, { caption: `v${sub(j + 1)}` })));
      }
      if (st.zero) body.push(el('p', {}, el('span', { class: 'badge warn' }, 'zero'), ` v${sub(j + 1)} = 0, so column ${j + 1} is dependent and is skipped.`));
      return el('div', { class: 'subspace' }, el('h3', {}, `Column ${j + 1}`), ...body);
    });
    kids.push(el('details', { open: '' }, el('summary', {}, `Show the steps (${g.steps.length} column${g.steps.length === 1 ? '' : 's'})`), ...stepEls));
    // normalization
    const norms = g.used.map((j, i) => el('p', { class: 'math note' }, `‖v${sub(j + 1)}‖ = √(${fmtCell(g.dots[i])}) = ${fmtCell(g.norms[i])}`));
    kids.push(el('div', { class: 'subspace' }, el('h3', {}, 'Orthogonal basis, then normalized'),
      row(el('span', { class: 'label' }, 'Orthogonal (unnormalized):'), matrixEl(K.transpose(g.ortho), { caption: 'v’s as columns', sendable: true })),
      ...norms,
      row(el('span', { class: 'label' }, 'Orthonormal  eᵢ = vᵢ / ‖vᵢ‖ :'), vectorList(g.unit, { name: 'e' }))));
    kids.push(nonzeroNote(g.assumptions, 'each vᵢ · vᵢ'));
    card(`Gram–Schmidt on the columns of ${T}  (QR factorization)`, ...kids);
  },
  transpose() { const T = state.target, A = readMatrix(T);
    card(`${T}ᵀ`, row(matrixEl(A, { caption: T }), opSym('→'), matrixEl(K.transpose(A), { caption: `${T}ᵀ`, sendable: true }))); },

  rref() {
    const T = state.target, A = readMatrix(T);
    const res = K.rref(A, { steps: true });
    const free = [...Array(A[0].length).keys()].filter((c) => !res.pivots.includes(c));
    card(`RREF(${T})`,
      row(matrixEl(A, { caption: T }), opSym('→'), matrixEl(res.R, { caption: `rref(${T})`, pivots: pivotCells(res.pivots), sendable: true })),
      el('p', {}, el('span', { class: 'label' }, 'Rank:'), `${res.rank}   `,
        el('span', { class: 'label' }, 'Pivot columns:'), res.pivots.length ? res.pivots.map((c) => c + 1).join(', ') : 'none', '   ',
        el('span', { class: 'label' }, 'Free columns:'), free.length ? free.map((c) => c + 1).join(', ') : 'none'),
      assumptionNote(res.assumptions),
      stepsDetails(res.steps));
  },
  det() {
    const T = state.target, A = readMatrix(T);
    const r = K.det(A);
    const n = A.length;
    const body = [row(el('span', { class: 'big' }, `det(${T}) = ${fmtCell(r.value)}`),
      approxNote(r.value) ? el('span', { class: 'note approx' }, approxNote(r.value)) : null,
      r.value.isZero() ? el('span', { class: 'badge no' }, 'singular')
        : r.value.constVal() !== null ? el('span', { class: 'badge ok' }, 'invertible')
          : el('span', { class: 'badge warn' }, 'invertible where det ≠ 0'))];
    if (n === 2) body.push(el('p', { class: 'math note' }, `ad − bc = (${fmtCell(A[0][0])})(${fmtCell(A[1][1])}) − (${fmtCell(A[0][1])})(${fmtCell(A[1][0])}) = ${fmtCell(r.value)}`));
    if (r.method === 'cofactor') {
      body.push(el('p', { class: 'note' }, 'Computed by cofactor (Laplace) expansion, which avoids division and keeps a symbolic determinant as a polynomial.'));
    } else if (r.singularAt !== undefined) {
      body.push(el('p', { class: 'note' }, `Row reduction produced a zero column below the diagonal in column ${r.singularAt + 1}, so the determinant is 0.`));
      body.push(row(matrixEl(A, { caption: T }), opSym('→'), matrixEl(r.echelon, { caption: 'echelon form' })));
    } else {
      const diag = r.diagonal.map(fmtCell).map((s) => (s.startsWith('−') || s.includes('/') ? `(${s})` : s)).join(' · ');
      body.push(el('p', { class: 'note' }, `Row reduction to upper-triangular form used ${r.swaps} row swap${r.swaps === 1 ? '' : 's'}; det = ${r.swaps % 2 ? '−' : ''}(product of the diagonal) = ${r.swaps % 2 ? '−' : ''}${diag} = ${fmtCell(r.value)}`));
      body.push(row(matrixEl(A, { caption: T }), opSym('→'), matrixEl(r.echelon, { caption: 'upper triangular' })));
      body.push(stepsDetails(r.steps));
    }
    card(`det(${T})`, ...body);
  },
  inverse() {
    const T = state.target, A = readMatrix(T);
    const r = K.inverse(A);
    const n = r.n;
    if (r.singular) {
      card(`${T}⁻¹ (Gauss–Jordan)`,
        el('p', {}, el('span', { class: 'badge no' }, 'singular'),
          ` ${T} is not invertible: rank ${r.rank} < ${n}, so [${T} | I] cannot be reduced to [I | ${T}⁻¹].`),
        row(matrixEl(r.augmented, { aug: n, caption: `[${T} | I]` }), opSym('→'), matrixEl(r.reduced, { aug: n, caption: 'reduced' })),
        assumptionNote(r.assumptions),
        stepsDetails(r.steps, { aug: n }));
      return;
    }
    card(`${T}⁻¹ (Gauss–Jordan)`,
      el('p', { class: 'note' }, `Augment with the identity and row-reduce: [${T} | I] → [I | ${T}⁻¹]`),
      row(matrixEl(r.augmented, { aug: n, caption: `[${T} | I]` }), opSym('→'), matrixEl(r.reduced, { aug: n, caption: `[I | ${T}⁻¹]` })),
      row(el('span', { class: 'label' }, `${T}⁻¹ =`), matrixEl(r.inverse, { sendable: true })),
      el('p', { class: 'note' }, `Check: ${T} · ${T}⁻¹ = I  ✓  (det ${T} = ${fmtCell(K.det(A).value)})`),
      assumptionNote(r.assumptions),
      stepsDetails(r.steps, { aug: n }));
  },
  subspaces() {
    const T = state.target, A = readMatrix(T);
    const s = K.fourSubspaces(A);
    const { m, n, rank } = s;
    card(`Four fundamental subspaces of ${T}  (${m}×${n}, rank ${rank})`,
      row(matrixEl(A, { caption: T }), opSym('→'), matrixEl(s.R, { caption: `rref(${T})`, pivots: pivotCells(s.pivots) })),
      el('p', { class: 'note' }, `Pivot columns: ${s.pivots.length ? s.pivots.map((c) => c + 1).join(', ') : 'none'};  free columns: ${s.freeCols.length ? s.freeCols.map((c) => c + 1).join(', ') : 'none'}.  dim C(A) + dim N(A) = ${rank} + ${n - rank} = ${n};  dim C(Aᵀ) + dim N(Aᵀ) = ${rank} + ${m - rank} = ${m}.`),
      assumptionNote(s.assumptions),
      subspaceSection(`Column space  C(${T})`, `subspace of ℝ${sup(m)}, dimension ${rank}`, 'The pivot columns of the original matrix.', s.colSpace, 'c'),
      subspaceSection(`Row space  C(${T}ᵀ)`, `subspace of ℝ${sup(n)}, dimension ${rank}`, `The nonzero rows of rref(${T}).`, s.rowSpace, 'r'),
      subspaceSection(`Null space  N(${T})`, `subspace of ℝ${sup(n)}, dimension ${n - rank}`, 'Special solutions: set one free variable to 1 and the others to 0.', s.nullSpace, 'n'),
      subspaceSection(`Left null space  N(${T}ᵀ)`, `subspace of ℝ${sup(m)}, dimension ${m - rank}`, `Null space of ${T}ᵀ; these vectors y satisfy yᵀ${T} = 0.`, s.leftNull, 'y'));
  },
  eigen() {
    const T = state.target, A = readMatrix(T);
    card(`Eigenvalues & eigenvectors of ${T}`, ...eigenBody(K.eigen(A), T));
  },
  diag() {
    const T = state.target, A = readMatrix(T);
    const d = K.diagonalize(A);
    if (!d.ok) {
      const e = d.eigen;
      if (!e.solved) {
        card(`Diagonalize ${T}`,
          el('p', {}, el('span', { class: 'badge warn' }, 'not solvable in closed form'),
            ` The characteristic polynomial has degree ${e.unsolvedDegree} with symbolic coefficients; there is no general formula for its roots.`),
          el('p', {}, el('span', { class: 'label' }, 'Characteristic polynomial:'), el('span', { class: 'math' }, `det(λI − ${T}) = ${charPolyString(e.charPoly)}`)),
          el('p', { class: 'note' }, 'Give the symbols values in the Variables box and press Substitute to diagonalize a concrete matrix.'));
        return;
      }
      const bad = e.eigenvalues.filter((v) => v.geomMult < v.algMult);
      card(`Diagonalize ${T}`,
        el('p', {}, el('span', { class: 'badge no' }, 'not diagonalizable'),
          ` ${T} has only ${e.geomTotal} linearly independent eigenvector${e.geomTotal === 1 ? '' : 's'} but is ${e.n}×${e.n}.`),
        ...bad.map((v) => el('p', { class: 'note' }, `λ = ${eigValueString(v)}: algebraic multiplicity ${v.algMult}, geometric multiplicity ${v.geomMult}.`)),
        el('details', {}, el('summary', {}, 'Eigenvalue details'), ...eigenBody(e, T)));
      return;
    }
    const kids = [];
    if (!d.exact) kids.push(el('p', { class: 'note' }, 'These eigenvalues have no closed form, so P, D and P⁻¹ are numerical.'));
    kids.push(row(el('span', { class: 'label' }, `${T} = P D P⁻¹  with`),
      matrixEl(d.P, { caption: 'P (eigenvectors as columns)', sendable: true }),
      matrixEl(d.D, { caption: 'D (eigenvalues)', sendable: true }),
      d.Pinv ? matrixEl(d.Pinv, { caption: 'P⁻¹', sendable: true }) : el('span', { class: 'note' }, 'P⁻¹ could not be computed')));
    if (d.exact) {
      kids.push(el('p', { class: 'note' }, `Check: P D P⁻¹ = ${T}  ${d.verified ? '✓' : '✗'}`));
      kids.push(el('p', { class: 'note' }, `Consequence: ${T}ᵏ = P Dᵏ P⁻¹, where Dᵏ raises each diagonal entry to the k-th power.`));
      kids.push(assumptionNote(d.eigen.assumptions));
    }
    kids.push(el('details', {}, el('summary', {}, 'Eigenvalue details'), ...eigenBody(d.eigen, T)));
    card(`Diagonalize ${T}`, ...kids);
  },
};

function subspaceSection(title, dimText, hint, basis, name) {
  return el('div', { class: 'subspace' },
    el('h3', {}, title, ' ', el('span', { class: 'note' }, `— ${dimText}`)),
    el('p', { class: 'note' }, hint),
    row(el('span', { class: 'label' }, 'Basis:'), vectorList(basis, { name })));
}
function eigValueString(v) {
  if (v.kind === 'numeric') return `≈ ${fmtComplex(v.approx)}`;
  const s = fmtCell(v.value);
  const n = approxNote(v.value);
  return n ? `${s}  ${n}` : s;
}
function eigenBody(e, T) {
  const kids = [];
  kids.push(el('p', {}, el('span', { class: 'label' }, 'Characteristic polynomial:'),
    el('span', { class: 'math' }, `det(λI − ${T}) = ${charPolyString(e.charPoly)}`)));
  if (!e.solved) {
    kids.push(el('p', {}, el('span', { class: 'badge warn' }, 'no closed form'),
      ` The polynomial has degree ${e.unsolvedDegree} with symbolic coefficients. Closed-form roots exist only up to degree 2 here, so no eigenvalues can be produced.`));
    kids.push(el('p', { class: 'note' }, 'Set values in the Variables box and press Substitute on the matrix to solve a concrete case.'));
    return kids;
  }
  kids.push(el('p', {}, el('span', { class: 'label' }, 'Eigenvalues:'),
    el('span', { class: 'math' }, e.eigenvalues.map((v) => `λ = ${eigValueString(v)}${v.algMult > 1 ? ` (×${v.algMult})` : ''}`).join(' ;  ')),
    ' ', el('span', { class: e.diagonalizable ? 'badge ok' : 'badge no' }, e.diagonalizable ? 'diagonalizable' : 'not diagonalizable')));
  if (e.eigenvalues.some((v) => v.kind === 'numeric')) {
    kids.push(el('p', { class: 'note' }, 'The characteristic polynomial has degree ≥ 3 with no rational roots, so these eigenvalues and eigenvectors are numerical.'));
  }
  for (const v of e.eigenvalues) {
    kids.push(el('div', { class: 'eig' },
      el('p', {}, el('span', { class: 'label' }, 'λ ='), el('span', { class: 'math' }, eigValueString(v)), '   ',
        el('span', { class: 'note' }, `algebraic multiplicity ${v.algMult}, geometric multiplicity ${v.geomMult}`),
        v.geomMult < v.algMult ? el('span', { class: 'badge no', style: 'margin-left:8px' }, 'defective') : null),
      row(el('span', { class: 'label' }, `Eigenvectors (basis of N(${T} − λI)):`), vectorList(v.vectors, { name: 'v' }))));
  }
  kids.push(assumptionNote(e.assumptions));
  return kids;
}

/* --------------------------------------------------------------- examples */
const EXAMPLES = [
  { g: 'Numeric', name: '3×3 invertible (RREF / inverse / det)', A: '2 1 1\n1 3 2\n1 0 0', B: '1 0 0\n0 1 0\n0 0 1' },
  { g: 'Numeric', name: '3×4 rank 2 (four subspaces)', A: '1 2 2 2\n2 4 6 8\n3 6 8 10', B: '1\n2\n3\n4' },
  { g: 'Numeric', name: '2×2 rational eigenvalues (diagonalize)', A: '4 1\n2 3', B: '1 0\n0 1' },
  { g: 'Numeric', name: '3×3 symmetric', A: '2 1 1\n1 2 1\n1 1 2', B: '1 0 0\n0 1 0\n0 0 1' },
  { g: 'Numeric', name: '2×2 rotation by 90° (eigenvalues ±i)', A: '0 -1\n1 0', B: '1 0\n0 1' },
  { g: 'Numeric', name: 'Fibonacci matrix (golden ratio)', A: '1 1\n1 0', B: '1 0\n0 1' },
  { g: 'Numeric', name: 'Jordan block (not diagonalizable)', A: '2 1 0\n0 2 0\n0 0 3', B: '1 0 0\n0 1 0\n0 0 1' },
  { g: 'Numeric', name: 'Product 2×3 · 3×2', A: '1 2 3\n4 5 6', B: '7 8\n9 10\n11 12' },
  { g: 'Numeric', name: 'Vectors in ℝ³ (dot / cross)', A: '1\n2\n3', B: '4\n5\n6' },
  { g: 'Numeric', name: 'Projection: vector onto vector (A onto B)', A: '1\n2\n3', B: '4\n5\n6' },
  { g: 'Numeric', name: 'Projection: vector onto a plane (A onto col space of B)', A: '6\n0\n0', B: '1 0\n1 1\n1 2' },
  { g: 'Numeric', name: 'Projection: dependent spanning columns', A: '3\n4\n5', B: '1 0 1\n0 1 1\n0 0 0' },
  { g: 'Symbolic', name: 'Projection: vector onto vector with symbols', A: 'x\ny', B: 'a\nb' },
  { g: 'Symbolic', name: 'Projection: unit vector direction (θ)', A: 'x\ny', B: 'cos(theta)\nsin(theta)' },
  { g: 'Numeric', name: 'Gram–Schmidt / QR: independent columns', A: '1 1 0\n1 0 1\n0 1 1', B: '1 0 0\n0 1 0\n0 0 1' },
  { g: 'Numeric', name: 'Gram–Schmidt: dependent column (reduced QR)', A: '1 2 3\n1 2 4\n0 0 1', B: '1 0 0\n0 1 0\n0 0 1' },
  { g: 'Numeric', name: 'Norms of a 2×2 matrix', A: '1 2\n3 4', B: '1 0\n0 1' },
  { g: 'Symbolic', name: 'Gram–Schmidt with symbols', A: '1 x\n1 y', B: '1 0\n0 1' },
  { g: 'Symbolic', name: 'General 2×2 [[a,b],[c,d]] — det & inverse', A: 'a b\nc d', B: '1 0\n0 1' },
  { g: 'Symbolic', name: '2×2 rotation R(θ) — det, inverse, eigen', A: 'cos(theta) -sin(theta)\nsin(theta) cos(theta)', B: 'cos(phi) -sin(phi)\nsin(phi) cos(phi)' },
  { g: 'Symbolic', name: '3×3 rotation about z', A: 'cos(theta) -sin(theta) 0\nsin(theta) cos(theta) 0\n0 0 1', B: '1 0 0\n0 1 0\n0 0 1' },
  { g: 'Symbolic', name: 'Triangular with symbols (eigen = x, y)', A: 'x 1\n0 y', B: '1 0\n0 1' },
  { g: 'Symbolic', name: 'Shear / scaling in α', A: '1 alpha\n0 1', B: '1 0\n0 1' },
  { g: 'Symbolic', name: 'Vandermonde 3×3 (determinant)', A: '1 1 1\nx y z\nx^2 y^2 z^2', B: '1 0 0\n0 1 0\n0 0 1' },
  { g: 'Symbolic', name: 'Companion matrix in x', A: 'x 1 0\n0 x 1\n1 0 x', B: '1 0 0\n0 1 0\n0 0 1' },
  { g: 'Symbolic', name: 'Unit vectors on a circle (dot / cross)', A: 'cos(t)\nsin(t)\n0', B: '-sin(t)\ncos(t)\n0' },
  { g: 'Symbolic', name: 'Symbolic vectors (dot / cross)', A: 'x\ny\nz', B: '1\n2\n3' },
  { g: 'Symbolic', name: 'Exact radicals and π', A: 'sqrt(2) 1/2\npi sin(pi/3)', B: '1 0\n0 1' },
];

/* --------------------------------------------------------------- settings */
function readAssignments() {
  const src = $('#assign').value;
  state.assignSrc = src;
  try {
    state.assign = SY.parseAssignments(src);
    state.assignNum = SY.numericEnv(state.assign);
    $('#assign').classList.remove('bad');
    const names = Object.keys(state.assign);
    $('#assign-note').textContent = names.length
      ? names.map((n) => `${SY.displayName(n)} = ${display(state.assign[n], opts())}`).join(',  ')
      : '';
  } catch (e) {
    $('#assign').classList.add('bad');
    $('#assign-note').textContent = e.message;
    throw e;
  }
}
function syntaxHelp() {
  const rows = [
    ['Numbers', '7    -2.5    3/4    1e-2'],
    ['Symbols', 'x    y    z    a    n1'],
    ['Greek', 'alpha → α,  theta → θ,  lambda → λ … (or paste α, θ directly)'],
    ['Arithmetic', 'x + 2y    3*x    2x    (x+1)(x-1)    x/y    x^3    x^(-1)'],
    ['Trigonometry', 'sin(x)  cos(x)  tan(x)  cot(x)  sec(x)  csc(x)'],
    ['Inverse trig', 'asin(x)  acos(x)  atan(x)'],
    ['Hyperbolic', 'sinh(x)  cosh(x)  tanh(x)'],
    ['Other', 'sqrt(x)  exp(x)  ln(x)  abs(x)'],
    ['Constants', 'pi (or π)   i (imaginary unit)'],
  ];
  return el('div', { class: 'help' },
    el('table', { class: 'helptable' }, rows.map(([k, v]) => el('tr', {}, el('td', {}, k), el('td', { class: 'math' }, v)))),
    el('p', { class: 'note' }, 'Identities are applied automatically: sin²+cos² collapses to 1, √(u)² to u, i² to −1, and tan is kept as sin/cos internally. Exact values are known for multiples of π/6 and π/4.'));
}

/* ----------------------------------------------------------------- wiring */
function init() {
  resize('A', 2, 2); resize('B', 2, 2);
  state.A.cells = [['cos(theta)', '-sin(theta)'], ['sin(theta)', 'cos(theta)']];
  state.B.cells = [['1', '0'], ['0', '1']];
  buildPanel('A'); buildPanel('B');

  document.querySelectorAll('button[data-op]').forEach((b) => b.addEventListener('click', () => {
    try { readAssignments(); } catch { /* the box shows its own error */ }
    try { ops[b.dataset.op](); } catch (err) { showError(err.message); console.error(err); }
  }));
  $('#target-seg').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    state.target = b.dataset.target;
    $('#target-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  });
  $('#proj-seg').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    state.proj = b.dataset.proj;
    $('#proj-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  });
  $('#num-mode').addEventListener('change', (ev) => { state.mode = ev.target.value; });
  $('#precision').addEventListener('change', (ev) => {
    state.precision = Math.min(12, Math.max(0, parseInt(ev.target.value, 10) || 0));
    ev.target.value = state.precision;
  });
  $('#assign').addEventListener('input', () => { try { readAssignments(); } catch { /* shown inline */ } });
  $('#clear-results').addEventListener('click', () => { results.innerHTML = ''; });
  const toggle = $('#side-toggle');
  const setSide = (open) => { document.body.classList.toggle('side-collapsed', !open); toggle.setAttribute('aria-expanded', String(open)); };
  setSide(window.innerWidth > 900);
  toggle.addEventListener('click', () => setSide(document.body.classList.contains('side-collapsed')));
  $('#settings-extra').append(syntaxHelp());

  const exSel = $('#examples');
  let group = null;
  EXAMPLES.forEach((ex, i) => {
    if (ex.g !== group) { group = ex.g; exSel.append(el('optgroup', { label: group })); }
    exSel.lastChild.append(el('option', { value: i }, ex.name));
  });
  exSel.addEventListener('change', () => {
    const ex = EXAMPLES[exSel.value];
    if (!ex) return;
    loadFromText('A', ex.A); loadFromText('B', ex.B);
    exSel.value = '';
  });
}
init();
})();
