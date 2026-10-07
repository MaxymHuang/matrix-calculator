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
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined) e.append(c.nodeType ? c : richText(String(c)));
  return e;
};

/* ------------------------------------------------------ math typesetting */
// Any string may carry inline math as \u0001 plain \u0002 tex \u0003 (see fmtCell / mathMark).
// el() turns those into KaTeX; the plain part is the fallback if KaTeX did not load.
const MATH_RE = /\u0001([^\u0002]*)\u0002([^\u0003]*)\u0003/g;
const mathMark = (tex, plain = '') => `\u0001${plain}\u0002${tex}\u0003`;
const plainOf = (s) => String(s).replace(MATH_RE, '$1');
function typeset(tex, plain = '', cls = 'tex') {
  const span = document.createElement('span');
  span.className = cls;
  if (plain) span.setAttribute('aria-label', plain);
  try {
    if (!window.katex) throw new Error('KaTeX not loaded');
    span.innerHTML = window.katex.renderToString(tex, { throwOnError: false, output: 'html', strict: 'ignore' });
  } catch { span.textContent = plain || tex; }
  return span;
}
function richText(str) {
  if (!str.includes('\u0001')) return document.createTextNode(str);
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of str.matchAll(MATH_RE)) {
    if (m.index > last) frag.append(str.slice(last, m.index));
    frag.append(typeset(m[2], m[1]));
    last = m.index + m[0].length;
  }
  if (last < str.length) frag.append(str.slice(last));
  return frag;
}
// a whole formula, set at full size:  ml(tx`\mathbf{u}\cdot\mathbf{v} = ${d}`)
const ml = (tex, plain = '') => typeset('\\displaystyle ' + tex, plain, 'tex tex-line');
// template tag: Expr / complex interpolations become LaTeX, strings pass through raw
const tx = (strs, ...vals) => strs.raw.reduce((acc, s, i) => acc + s + (i < vals.length ? texVal(vals[i]) : ''), '');
const texVal = (v) => (Array.isArray(v) ? v.map(texVal).join(', ') : v !== null && typeof v === 'object' ? texOf(v) : String(v));

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
const fmtPlain = (x) => (isComplex(x) ? fmtComplex(x) : display(x, opts()));
function texComplex(z) {
  const eps = 0.5 * 10 ** -state.precision;
  const re = Math.abs(z.re) < eps ? 0 : z.re, im = Math.abs(z.im) < eps ? 0 : z.im;
  const num = (x) => fmtDec(x).replace(/−/g, '-');
  if (im === 0) return num(re);
  const imS = Math.abs(im) === 1 ? '' : num(Math.abs(im));
  if (re === 0) return (im < 0 ? '-' : '') + imS + 'i';
  return `${num(re)} ${im < 0 ? '-' : '+'} ${imS}i`;
}
const texOf = (x) => (isComplex(x) ? texComplex(x) : SY.toTeX(x, opts()));
// inline math inside a sentence
const fmtCell = (x) => mathMark(texOf(x), fmtPlain(x));
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
// a matrix as a LaTeX array: stretchy brackets, stacked fractions, optional augment bar and pivot cells
function matrixTeX(M, o = {}) {
  const pivotSet = new Set((o.pivots || []).map(([r, c]) => `${r},${c}`));
  const spec = M[0].map((_, j) => (o.aug !== undefined && j === o.aug ? '|' : '') + 'c').join('');
  const body = M.map((row, i) => row.map((x, j) => {
    const t = texOf(x);
    if (pivotSet.has(`${i},${j}`)) return `\\colorbox{#fde4ac}{$\\displaystyle\\boldsymbol{${t}}$}`;
    if (isZeroCell(x)) return `\\color{#9a9c88}{${t}}`;
    return `\\displaystyle ${t}`;
  }).join(' & ')).join(M.some((r) => r.some((x) => /\\frac/.test(texOf(x)))) ? ' \\\\[2.4ex] ' : ' \\\\[1.1ex] ');
  return `\\left[\\begin{array}{${spec}} ${body} \\end{array}\\right]`;
}
const matrixPlain = (M) => M.map((r) => r.map(fmtPlain).join(' ')).join('; ');
function matrixEl(M, o = {}) {
  const mat = el('div', { class: 'mat' }, typeset(matrixTeX(M, o), `matrix ${matrixPlain(M)}`, 'tex tex-matrix'));
  const wrap = el('div', { class: 'matwrap' }, mat);
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
  return el('div', { class: 'vecs' }, vs.map((v, i) => colVec(v, Object.assign({ caption: o.name ? cm(`${o.name}_{${i + 1}}`, `${o.name}${i + 1}`) : undefined }, o))));
}
const row = (...items) => el('div', { class: 'row' }, ...items);
// a caption with math in it:  cm('B^{\\mathsf T}B', 'BᵀB')
const cm = (tex, plain) => mathMark(tex, plain);
const opSym = (s) => el('span', { class: 'op' }, s);
const scalarEl = (e) => {
  const n = approxNote(e);
  return el('span', {}, el('span', { class: 'big' }, fmtCell(e)), n ? el('span', { class: 'note approx' }, ' ' + n) : null);
};

// an expression used as a row-operation factor, bracketed when it is a sum
function factorTeX(e) {
  const s = fmtPlain(e);
  const t = texOf(e);
  return /[+\s]/.test(s.trim()) && !/^−?[\d/.]+$/.test(s) ? `\\left(${t}\\right)` : t;
}
// bracket a value inside a product when it is negative or a sum
const texParen = (x) => (/^−|[+\s−]/.test(fmtPlain(x).trim()) && !/^[\d/.]+$/.test(fmtPlain(x)) ? `\\left(${texOf(x)}\\right)` : texOf(x));
const productSum = (a, b) => a.map((x, i) => `${texParen(x)}\\cdot ${texParen(b[i])}`).join(' + ');
function stepDesc(op) {
  const R = (k) => `R_{${k + 1}}`;
  if (op.kind === 'swap') return { tex: `${R(op.i)} \\leftrightarrow ${R(op.j)}`, plain: `R${op.i + 1} ↔ R${op.j + 1}` };
  if (op.kind === 'scale') return { tex: `${R(op.i)} \\leftarrow ${factorTeX(op.factor)}\\,${R(op.i)}`, plain: `R${op.i + 1} ← ${fmtPlain(op.factor)} · R${op.i + 1}` };
  const f = op.factor;
  const neg = !isComplex(f) && f.constVal() !== null && f.constVal().sign() < 0;
  return neg ? { tex: `${R(op.i)} \\leftarrow ${R(op.i)} + ${factorTeX(f.neg())}\\,${R(op.j)}`, plain: `R${op.i + 1} ← R${op.i + 1} + ${fmtPlain(f.neg())} · R${op.j + 1}` }
             : { tex: `${R(op.i)} \\leftarrow ${R(op.i)} - ${factorTeX(f)}\\,${R(op.j)}`, plain: `R${op.i + 1} ← R${op.i + 1} − ${fmtPlain(f)} · R${op.j + 1}` };
}
function stepsDetails(steps, o = {}, label = 'Show row operations') {
  if (!steps || !steps.length) return el('p', { class: 'note' }, 'No row operations were needed.');
  return el('details', {}, el('summary', {}, `${label} (${steps.length})`),
    el('div', { class: 'steps' }, steps.map((s, i) => {
      const d = stepDesc(s);
      return el('div', { class: 'step' }, el('div', { class: 'desc' }, `${i + 1}. `, ml(d.tex, d.plain)), matrixEl(s.matrix, o));
    })));
}
const pivotCells = (pivots) => pivots.map((c, r) => [r, c]);

// "Valid wherever x ≠ 0 and x − 1 ≠ 0" — pivots had to be assumed nonzero
function assumptionNote(list) {
  if (!list || !list.length) return null;
  return el('p', { class: 'note assume' }, el('span', { class: 'label' }, 'Assumes:'),
    neqList(list), ' — a pivot was taken to be nonzero, so the result is the generic case.');
}
const neqList = (list) => ml(list.map((e) => tx`${e} \neq 0`).join('\\;\\text{and}\\;'));

// projection needs a divisor (v·v, a Gram pivot …) that symbolic input could make vanish
function nonzeroNote(list, what) {
  if (!list || !list.length) return null;
  return el('p', { class: 'note assume' }, el('span', { class: 'label' }, 'Assumes:'),
    neqList(list), ` — ${what} must be nonzero for the formula to apply; otherwise the result is the generic case.`);
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
      row(matrixEl(r.B, { caption: 'B' }), opSym('→ transpose →'), matrixEl(r.Bt, { caption: BT }))),
    stage(3, 'form the Gram matrix  BᵀB',
      `Every entry is a dot product of two basis vectors (${k}×${k}).`,
      row(matrixEl(r.Bt, { caption: BT }), opSym('×'), matrixEl(r.B, { caption: 'B' }), opSym('='), matrixEl(r.G, { caption: GRAM }))),
    stage(4, 'invert it with Gauss–Jordan',
      'Row-reduce the augmented matrix until the left half is the identity; the right half is then the inverse.',
      row(matrixEl(inv.augmented, { aug: k, caption: cm('[\\,B^{\\mathsf T}B \\mid I\\,]', '[BᵀB | I]') }), opSym('→'),
        matrixEl(inv.reduced, { aug: k, caption: cm('[\\,I \\mid (B^{\\mathsf T}B)^{-1}\\,]', '[I | (BᵀB)⁻¹]') })),
      row(ml('(B^{\\mathsf T}B)^{-1} ='), matrixEl(inv.inverse)),
      stepsDetails(inv.steps, { aug: k })),
    stage(5, 'multiply  B (BᵀB)⁻¹',
      null,
      row(matrixEl(r.B, { caption: 'B' }), opSym('×'), matrixEl(inv.inverse, { caption: GINV }), opSym('='), matrixEl(r.BGinv, { caption: BGINV }))),
    stage(6, 'multiply by Bᵀ to get P',
      null,
      row(matrixEl(r.BGinv, { caption: BGINV }), opSym('×'), matrixEl(r.Bt, { caption: BT }), opSym('='), matrixEl(r.P, { caption: 'P', sendable: true }))));
}
const BT = cm('B^{\\mathsf T}', 'Bᵀ'), GRAM = cm('B^{\\mathsf T}B', 'BᵀB'),
  GINV = cm('(B^{\\mathsf T}B)^{-1}', '(BᵀB)⁻¹'), BGINV = cm('B(B^{\\mathsf T}B)^{-1}', 'B(BᵀB)⁻¹');

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
// det(λI − A) as LaTeX, highest power first
const charPolyTeX = (coefs) => {
  let out = '';
  const n = coefs.length - 1;
  coefs.forEach((c, i) => {
    const k = n - i;
    if (c.isZero()) return;
    const s = fmtPlain(c);
    const neg = s.startsWith('−');
    const magE = neg ? c.neg() : c;
    const mag = texOf(magE);
    const needs = /[+\s−]/.test(neg ? s.slice(1) : s);
    const wrapped = needs ? `\\left(${mag}\\right)` : mag;
    const body = k === 0 ? wrapped : `${mag === '1' ? '' : wrapped}\\lambda${k === 1 ? '' : `^{${k}}`}`;
    out += out === '' ? (neg ? '-' + body : body) : (neg ? ` - ${body}` : ` + ${body}`);
  });
  return out || '0';
};
const charPolyLine = (T, coefs) => ml(tx`\det(\lambda I - ${T}) = ${charPolyTeX(coefs)}`);

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
    const terms = productSum(u, v);
    const extra = [];
    if (!nu.isZero() && !nv.isZero()) {
      extra.push(el('p', {}, ml(tx`\lVert u\rVert = ${K.norm(u)}`), '     ', ml(tx`\lVert v\rVert = ${K.norm(v)}`)));
      const dn = d.evalNum(state.assignNum), a = nu.evalNum(state.assignNum), b = nv.evalNum(state.assignNum);
      if (dn !== null && a !== null && b !== null && a > 0 && b > 0) {
        const ang = Math.acos(Math.max(-1, Math.min(1, dn / Math.sqrt(a * b)))) * 180 / Math.PI;
        extra.push(el('p', {}, el('span', { class: 'label' }, 'Angle between u and v:'), ml(`\\theta = \\arccos\\dfrac{u\\cdot v}{\\lVert u\\rVert\\,\\lVert v\\rVert} \\approx ${fmtDec(ang).replace(/−/g, '-')}^{\\circ}`)));
      }
      if (d.isZero()) extra.push(el('p', {}, el('span', { class: 'badge ok' }, 'orthogonal'), ' u · v = 0 for every value of the symbols.'));
    }
    card('Dot product  u · v',
      row(colVec(u, { caption: 'u' }), opSym('·'), colVec(v, { caption: 'v' }), opSym('='), scalarEl(d)),
      el('p', {}, ml(tx`u\cdot v = ${terms} = ${d}`)), ...extra);
  },
  cross() {
    const u = K.asVector(readMatrix('A')), v = K.asVector(readMatrix('B'));
    const w = K.cross(u, v);
    card('Cross product  u ⨯ v',
      row(colVec(u, { caption: 'u' }), opSym('⨯'), colVec(v, { caption: 'v' }), opSym('='), colVec(w, { caption: 'u ⨯ v', sendable: true })),
      el('p', {}, ml(String.raw`u\times v = \begin{pmatrix} u_2v_3 - u_3v_2 \\ u_3v_1 - u_1v_3 \\ u_1v_2 - u_2v_1 \end{pmatrix}`)),
      el('p', { class: 'note' }, 'Check: ', ml(tx`(u\times v)\cdot u = ${K.dot(w, u)}`), ',  ', ml(tx`(u\times v)\cdot v = ${K.dot(w, v)}`), ' — the result is orthogonal to both.'),
      el('p', { class: 'note' }, ml(tx`\lVert u\times v\rVert = ${K.norm(w)}`),
        ' (area of the parallelogram spanned by u and v)'));
  },
  projVec() {
    const [src, dst] = state.proj;
    const u = K.asVector(readMatrix(src)), v = K.asVector(readMatrix(dst));
    const r = K.projectOntoVector(u, v);
    // with symbols the simplified quotient is a mess, so keep it as (u·v)/‖v‖
    const compTeX = r.vv.constVal() !== null ? texOf(r.comp) : tx`\dfrac{${r.uv}}{${K.norm(v)}}`;
    card(`Projection of ${src} onto ${dst}  (vector onto vector)`,
      row(colVec(u, { caption: `u = ${src}` }), opSym('onto'), colVec(v, { caption: `v = ${dst}` }), opSym('='),
        colVec(r.proj, { caption: cm('\\operatorname{proj}_{v}u', 'proj_v u'), sendable: true })),
      el('p', {}, ml(String.raw`\operatorname{proj}_{v}\,u = \dfrac{u\cdot v}{v\cdot v}\,v`)),
      el('p', {}, ml(tx`u\cdot v = ${productSum(u, v)} = ${r.uv}`)),
      el('p', {}, ml(tx`v\cdot v = ${productSum(v, v)} = ${r.vv}`)),
      el('p', {}, el('span', { class: 'label' }, 'Coefficient:'), ml(tx`\dfrac{u\cdot v}{v\cdot v} = ${r.coef}`),
        approxNote(r.coef) ? el('span', { class: 'note approx' }, ' ' + approxNote(r.coef)) : null),
      el('p', {}, el('span', { class: 'label' }, 'Scalar component:'), ml(tx`\operatorname{comp}_{v}\,u = \dfrac{u\cdot v}{\lVert v\rVert} = ${compTeX}`),
        approxNote(r.comp) ? el('span', { class: 'note approx' }, ' ' + approxNote(r.comp)) : null,
        el('span', { class: 'note' }, '  (signed length of the shadow of u along v)')),
      row(ml(String.raw`u_{\perp} = u - \operatorname{proj}_{v}\,u =`), colVec(r.perp, { caption: 'u⊥', sendable: true })),
      el('p', { class: 'note' }, r.check.isZero()
        ? ['Check: ', ml(String.raw`(u - \operatorname{proj}_{v}u)\cdot v = 0`), '  ✓  — the remainder is perpendicular to v, so ', ml(String.raw`u = \operatorname{proj}_{v}u + u_{\perp}`), ' is the orthogonal decomposition.']
        : ['Check: ', ml(tx`(u - \operatorname{proj}_{v}u)\cdot v = ${r.check}`)]),
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
        'The projection p is the point of that space closest to b, found from the normal equations ', ml(String.raw`(B^{\mathsf T}B)\,\hat{x} = B^{\mathsf T}b`),
        ', with B a basis of independent columns; then ', ml(String.raw`p = B\hat{x}`), '.'),
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
      row(matrixEl(r.G, { caption: cm('B^{\\mathsf T}B', 'BᵀB') }), ml('\\hat{x} ='), colVec(r.Mtb, { caption: cm('B^{\\mathsf T}b', 'Bᵀb') }),
        opSym('⟹'), colVec(r.xhat, { caption: cm('\\hat{x} = (B^{\\mathsf T}B)^{-1}B^{\\mathsf T}b', 'x̂ = (BᵀB)⁻¹Bᵀb') }))));
    kids.push(row(ml('p = B\\hat{x} ='), colVec(r.proj, { caption: 'p', sendable: true }),
      el('span', { style: 'margin-left:16px' }, ml('e = b - p =')), colVec(r.perp, { caption: 'e (⟂ to the space)', sendable: true })));
    if (r.inSpace) {
      kids.push(el('p', {}, el('span', { class: 'badge ok' }, 'b is in the space'), ' b already lies in the column space, so p = b and the error e is 0.'));
    } else {
      kids.push(el('p', { class: 'note' }, el('span', { class: 'label' }, 'Distance from b to the space:'), ml(tx`\lVert e\rVert = ${K.norm(r.perp)}`),
        approxNote(K.norm(r.perp)) ? el('span', { class: 'note approx' }, ' ' + approxNote(K.norm(r.perp))) : null));
    }
    kids.push(el('p', { class: 'note' }, r.residualCheck.every((x) => x.isZero())
      ? ['Check: ', ml(String.raw`B^{\mathsf T}e = 0`), '  ✓  — the error is orthogonal to every basis vector, hence to the whole space.']
      : ['Check: ', ml(tx`B^{\mathsf T}e = \begin{pmatrix}${r.residualCheck.map(texOf).join('\\\\')}\end{pmatrix}`)]));
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
      row(matrixEl(M, { caption: `${dst}  (${r.m}×${M[0].length})` }), opSym('→'), matrixEl(r.P, { caption: cm('P = B(B^{\\mathsf T}B)^{-1}B^{\\mathsf T}', 'P = B(BᵀB)⁻¹Bᵀ'), sendable: true })),
      singleRowNote(M, dst),
      el('p', { class: 'note' }, `B is the independent (pivot) columns of ${dst}: ${r.pivots.length ? r.pivots.map((c) => c + 1).join(', ') : 'none'}. `, ml('Pb'),
        ` is the projection of any b ∈ ℝ${sup(r.m)} onto the space, which has dimension ${r.k}.`),
      el('p', {}, ml('P^2 = P'), ` ${ok(r.idempotent)}      `, ml(String.raw`P^{\mathsf T} = P`), ` ${ok(r.symmetric)}      `, ml(tx`\operatorname{rank}P = \operatorname{tr}P = ${r.trace}`)),
      row(ml('I - P ='), matrixEl(r.complement, { caption: 'projects onto the orthogonal complement', sendable: true })),
      el('details', { open: '' }, el('summary', {}, 'Show the steps'), projectionSteps(r, M, dst)),
      nonzeroNote(r.assumptions, 'these pivots and Gram-matrix pivots'));
  },
  norm() {
    const T = state.target, M = readMatrix(T);
    const [r, c] = K.dims(M);
    // one labelled line:  <tex lhs> = <value>  ≈ …  (extra)
    const line = (lhs, e, extra) => el('p', {}, ml(`${lhs} = ${texOf(e)}`),
      approxNote(e) ? el('span', { class: 'note approx' }, ' ' + approxNote(e)) : null, extra ? el('span', { class: 'note' }, '   ' + extra) : null);
    const pick = (res, name, lhs, extra) => (res ? line(lhs(res), res.value, extra(res))
      : el('p', { class: 'note' }, `${name} needs numeric values — enter values for the symbols in Variables to compare entries.`));
    if (r === 1 || c === 1) {
      const v = K.asVector(M);
      const n = K.vectorNorms(v, state.assignNum);
      const sq = (x) => (/^[0-9A-Za-zͰ-Ͽ]+$/.test(fmtPlain(x)) ? texOf(x) : `\\left(${texOf(x)}\\right)`);
      const sumSq = v.map((x) => `${sq(x)}^{2}`).join(' + ');
      const sqrtForm = `\\sqrt{${texOf(n.sq)}}`;
      const kids = [
        row(colVec(v, { caption: T }), opSym('→'), el('span', {}, el('span', { class: 'big' }, ml(tx`\lVert ${T}\rVert = ${n.l2}`)),
          approxNote(n.l2) ? el('span', { class: 'note approx' }, ' ' + approxNote(n.l2)) : null),
          n.zero ? el('span', { class: 'badge no' }, 'zero vector') : null),
        el('p', {}, ml(`\\lVert v\\rVert_2 = \\sqrt{v_1^2 + \\cdots + v_n^2} = \\sqrt{${sumSq}} = ${sqrtForm}${sqrtForm === texOf(n.l2) ? '' : ' = ' + texOf(n.l2)}`)),
        line(String.raw`\lVert v\rVert_1 = |v_1| + \cdots + |v_n|`, n.l1, '(taxicab / Manhattan length)'),
        pick(n.linf, '∞-norm', (m) => `\\lVert v\\rVert_\\infty = \\max_i |v_i| \\;(i = ${m.index + 1})`, () => '(largest absolute entry)'),
      ];
      if (n.zero) kids.push(el('p', { class: 'note' }, 'The zero vector has no direction, so it cannot be normalized.'));
      else {
        kids.push(row(ml(String.raw`\hat{u} = \dfrac{v}{\lVert v\rVert} =`), colVec(n.unit, { caption: cm('\\hat{u}', 'û'), sendable: true })));
        kids.push(el('p', { class: 'note' }, 'Check: ', ml(tx`\lVert \hat{u}\rVert = ${K.norm(n.unit)}`), `  ✓  — same direction as ${T}, length 1.`));
      }
      kids.push(nonzeroNote(n.assumptions, 'v · v'));
      card(`Norm of ${T}  (vector in ℝ${sup(v.length)})`, ...kids);
      return;
    }
    const n = K.matrixNorms(M, state.assignNum);
    const kids = [
      row(matrixEl(M, { caption: `${T}  (${r}×${c})` })),
      line(`\\lVert ${T}\\rVert_F = \\sqrt{\\textstyle\\sum a_{ij}^2} = \\sqrt{${texOf(n.frobeniusSq)}}`, n.frobenius),
      pick(n.l1, '1-norm', (m) => `\\lVert ${T}\\rVert_1 = \\max_j \\sum_i |a_{ij}| \\;(j = ${m.index + 1})`, () => `column sums: ${n.colSums.map(fmtCell).join(', ')}`),
      pick(n.linf, '∞-norm', (m) => `\\lVert ${T}\\rVert_\\infty = \\max_i \\sum_j |a_{ij}| \\;(i = ${m.index + 1})`, () => `row sums: ${n.rowSums.map(fmtCell).join(', ')}`),
    ];
    if (n.spectral) {
      const lhs = `\\lVert ${T}\\rVert_2 = \\sigma_{\\max} = \\sqrt{\\lambda_{\\max}(${T}^{\\mathsf T}${T})}`;
      kids.push(n.spectral.value
        ? line(lhs, n.spectral.value)
        : el('p', {}, ml(`${lhs} \\approx ${fmtDec(n.spectral.approx).replace(/−/g, '-')}`),
          el('span', { class: 'note' }, `   (numerical: ${T}ᵀ${T} has no closed-form eigenvalues)`)));
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
    kids.push(el('p', { class: 'note' }, 'Each column is made orthogonal to the ones before it by subtracting its projections:'));
    kids.push(el('p', {}, ml(String.raw`v_j = a_j - \sum_{i<j}\dfrac{a_j\cdot v_i}{v_i\cdot v_i}\,v_i`)));
    kids.push(el('p', { class: 'note' }, 'Normalizing the vⱼ gives Q, and R = ', ml(`Q^{\\mathsf T}${T}`), ', so that ', ml(`${T} = QR`), '.'));
    kids.push(row(matrixEl(M, { caption: T }), opSym('='), matrixEl(g.Q, { caption: `Q  (${g.m}×${g.rank}, orthonormal columns)`, sendable: true }),
      opSym('×'), matrixEl(g.R, { caption: `R  (${g.rank}×${g.n}, upper triangular)`, sendable: true })));
    kids.push(el('p', { class: 'note' }, 'Check: ', ml(`QR = ${T}`), ` ${g.verified ? '✓' : '✗'}      `, ml('Q^{\\mathsf T}Q = I'), ` ${g.orthonormal ? '✓' : '✗'}`));
    if (g.dependent.length) {
      kids.push(el('p', {}, el('span', { class: 'badge warn' }, 'dependent columns'),
        ` Column${g.dependent.length === 1 ? '' : 's'} ${g.dependent.map((j) => j + 1).join(', ')} of ${T} already lie${g.dependent.length === 1 ? 's' : ''} in the span of the earlier ones, so ${g.dependent.length === 1 ? 'it was' : 'they were'} skipped. Q has ${g.rank} column${g.rank === 1 ? '' : 's'} (reduced QR); the rank of ${T} is ${g.rank}.`));
    }
    // the work, column by column
    const stepEls = g.steps.map((st) => {
      const j = st.col;
      const body = [];
      if (!st.terms.length) {
        body.push(el('p', { class: 'note' }, j === 0 ? ['The first column starts the basis: ', ml('v_1 = a_1'), '.'] : ['Nothing to subtract: ', ml(`v_{${j + 1}} = a_{${j + 1}}`), '.']));
      } else {
        for (const t of st.terms) {
          const a = `a_{${j + 1}}`, v = `v_{${t.from + 1}}`;
          body.push(el('p', {}, ml(tx`\dfrac{${a}\cdot ${v}}{${v}\cdot ${v}} = \dfrac{${t.num}}{${t.den}} = ${t.coef}`)));
        }
        body.push(row(colVec(st.a, { caption: cm(`a_{${j + 1}}`, `a${sub(j + 1)}`) }),
          ...st.terms.flatMap((t) => [opSym('−'), colVec(t.vec, { caption: cm(tx`\left(${t.coef}\right) v_{${t.from + 1}}`, `(${fmtPlain(t.coef)}) · v${sub(t.from + 1)}`) })]),
          opSym('='), colVec(st.v, { caption: cm(`v_{${j + 1}}`, `v${sub(j + 1)}`) })));
      }
      if (st.zero) body.push(el('p', {}, el('span', { class: 'badge warn' }, 'zero'), ' ', ml(`v_{${j + 1}} = 0`), `, so column ${j + 1} is dependent and is skipped.`));
      return el('div', { class: 'subspace' }, el('h3', {}, `Column ${j + 1}`), ...body);
    });
    kids.push(el('details', { open: '' }, el('summary', {}, `Show the steps (${g.steps.length} column${g.steps.length === 1 ? '' : 's'})`), ...stepEls));
    // normalization
    const norms = g.used.map((j, i) => el('p', {}, ml(tx`\lVert v_{${j + 1}}\rVert = \sqrt{${g.dots[i]}} = ${g.norms[i]}`)));
    kids.push(el('div', { class: 'subspace' }, el('h3', {}, 'Orthogonal basis, then normalized'),
      row(el('span', { class: 'label' }, 'Orthogonal (unnormalized):'), matrixEl(K.transpose(g.ortho), { caption: 'v’s as columns', sendable: true })),
      ...norms,
      row(ml(String.raw`e_i = \dfrac{v_i}{\lVert v_i\rVert}`), vectorList(g.unit, { name: 'e' }))));
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
    const body = [row(el('span', { class: 'big' }, ml(tx`\det(${T}) = ${r.value}`)),
      approxNote(r.value) ? el('span', { class: 'note approx' }, approxNote(r.value)) : null,
      r.value.isZero() ? el('span', { class: 'badge no' }, 'singular')
        : r.value.constVal() !== null ? el('span', { class: 'badge ok' }, 'invertible')
          : el('span', { class: 'badge warn' }, 'invertible where det ≠ 0'))];
    if (n === 2) body.push(el('p', {}, ml(`ad - bc = ${texParen(A[0][0])}${texParen(A[1][1])} - ${texParen(A[0][1])}${texParen(A[1][0])} = ${texOf(r.value)}`)));
    if (r.method === 'cofactor') {
      body.push(el('p', { class: 'note' }, 'Computed by cofactor (Laplace) expansion, which avoids division and keeps a symbolic determinant as a polynomial.'));
    } else if (r.singularAt !== undefined) {
      body.push(el('p', { class: 'note' }, `Row reduction produced a zero column below the diagonal in column ${r.singularAt + 1}, so the determinant is 0.`));
      body.push(row(matrixEl(A, { caption: T }), opSym('→'), matrixEl(r.echelon, { caption: 'echelon form' })));
    } else {
      const diag = r.diagonal.map(texParen).join('\\cdot ');
      const sgn = r.swaps % 2 ? '-' : '';
      body.push(el('p', { class: 'note' }, `Row reduction to upper-triangular form used ${r.swaps} row swap${r.swaps === 1 ? '' : 's'}, so the determinant is ${r.swaps % 2 ? 'minus ' : ''}the product of the diagonal:`));
      body.push(el('p', {}, ml(`\\det = ${sgn}${sgn ? '\\left(' + diag + '\\right)' : diag} = ${texOf(r.value)}`)));
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
          ` ${T} is not invertible: rank ${r.rank} < ${n}, so `, ml(`[\\,${T} \\mid I\\,]`), ' cannot be reduced to ', ml(`[\\,I \\mid ${T}^{-1}\\,]`), '.'),
        row(matrixEl(r.augmented, { aug: n, caption: cm(`[\\,${T} \\mid I\\,]`, `[${T} | I]`) }), opSym('→'), matrixEl(r.reduced, { aug: n, caption: 'reduced' })),
        assumptionNote(r.assumptions),
        stepsDetails(r.steps, { aug: n }));
      return;
    }
    card(`${T}⁻¹ (Gauss–Jordan)`,
      el('p', { class: 'note' }, 'Augment with the identity and row-reduce: ', ml(`[\\,${T} \\mid I\\,] \\to [\\,I \\mid ${T}^{-1}\\,]`)),
      row(matrixEl(r.augmented, { aug: n, caption: cm(`[\\,${T} \\mid I\\,]`, `[${T} | I]`) }), opSym('→'), matrixEl(r.reduced, { aug: n, caption: cm(`[\\,I \\mid ${T}^{-1}\\,]`, `[I | ${T}⁻¹]`) })),
      row(ml(`${T}^{-1} =`), matrixEl(r.inverse, { sendable: true })),
      el('p', { class: 'note' }, 'Check: ', ml(`${T}\\,${T}^{-1} = I`), '  ✓  ', ml(tx`(\det ${T} = ${K.det(A).value})`)),
      assumptionNote(r.assumptions),
      stepsDetails(r.steps, { aug: n }));
  },
  subspaces() {
    const T = state.target, A = readMatrix(T);
    const s = K.fourSubspaces(A);
    const { m, n, rank } = s;
    card(`Four fundamental subspaces of ${T}  (${m}×${n}, rank ${rank})`,
      row(matrixEl(A, { caption: T }), opSym('→'), matrixEl(s.R, { caption: `rref(${T})`, pivots: pivotCells(s.pivots) })),
      el('p', { class: 'note' }, `Pivot columns: ${s.pivots.length ? s.pivots.map((c) => c + 1).join(', ') : 'none'};  free columns: ${s.freeCols.length ? s.freeCols.map((c) => c + 1).join(', ') : 'none'}.`),
      el('p', {}, ml(`\\dim C(${T}) + \\dim N(${T}) = ${rank} + ${n - rank} = ${n}`), '      ',
        ml(`\\dim C(${T}^{\\mathsf T}) + \\dim N(${T}^{\\mathsf T}) = ${rank} + ${m - rank} = ${m}`)),
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
          el('p', {}, el('span', { class: 'label' }, 'Characteristic polynomial:'), charPolyLine(T, e.charPoly)),
          el('p', { class: 'note' }, 'Give the symbols values in the Variables box and press Substitute to diagonalize a concrete matrix.'));
        return;
      }
      const bad = e.eigenvalues.filter((v) => v.geomMult < v.algMult);
      card(`Diagonalize ${T}`,
        el('p', {}, el('span', { class: 'badge no' }, 'not diagonalizable'),
          ` ${T} has only ${e.geomTotal} linearly independent eigenvector${e.geomTotal === 1 ? '' : 's'} but is ${e.n}×${e.n}.`),
        ...bad.map((v) => el('p', { class: 'note' }, eigLine(v), `: algebraic multiplicity ${v.algMult}, geometric multiplicity ${v.geomMult}.`)),
        el('details', {}, el('summary', {}, 'Eigenvalue details'), ...eigenBody(e, T)));
      return;
    }
    const kids = [];
    if (!d.exact) kids.push(el('p', { class: 'note' }, 'These eigenvalues have no closed form, so P, D and P⁻¹ are numerical.'));
    kids.push(row(ml(`${T} = PDP^{-1}\\;\\text{with}`),
      matrixEl(d.P, { caption: 'P (eigenvectors as columns)', sendable: true }),
      matrixEl(d.D, { caption: 'D (eigenvalues)', sendable: true }),
      d.Pinv ? matrixEl(d.Pinv, { caption: cm('P^{-1}', 'P⁻¹'), sendable: true }) : el('span', { class: 'note' }, 'P⁻¹ could not be computed')));
    if (d.exact) {
      kids.push(el('p', { class: 'note' }, 'Check: ', ml(`PDP^{-1} = ${T}`), `  ${d.verified ? '✓' : '✗'}`));
      kids.push(el('p', { class: 'note' }, 'Consequence: ', ml(`${T}^k = PD^kP^{-1}`), ', where ', ml('D^k'), ' raises each diagonal entry to the k-th power.'));
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
// "λ = value" typeset, with the numeric approximation after it when the exact form is not already a plain number
function eigLine(v, mult) {
  const tex = v.kind === 'numeric' ? `\\approx ${texComplex(v.approx)}` : texOf(v.value);
  const n = v.kind === 'numeric' ? null : approxNote(v.value);
  return el('span', {}, ml(`\\lambda = ${tex}${mult > 1 ? `\\;(\\times ${mult})` : ''}`), n ? el('span', { class: 'note approx' }, ' ' + n) : null);
}
function eigenBody(e, T) {
  const kids = [];
  kids.push(el('p', {}, el('span', { class: 'label' }, 'Characteristic polynomial:'), charPolyLine(T, e.charPoly)));
  if (!e.solved) {
    kids.push(el('p', {}, el('span', { class: 'badge warn' }, 'no closed form'),
      ` The polynomial has degree ${e.unsolvedDegree} with symbolic coefficients. Closed-form roots exist only up to degree 2 here, so no eigenvalues can be produced.`));
    kids.push(el('p', { class: 'note' }, 'Set values in the Variables box and press Substitute on the matrix to solve a concrete case.'));
    return kids;
  }
  kids.push(el('p', {}, el('span', { class: 'label' }, 'Eigenvalues:'),
    e.eigenvalues.flatMap((v, i) => [i ? "   " : "", eigLine(v, v.algMult)]),
    ' ', el('span', { class: e.diagonalizable ? 'badge ok' : 'badge no' }, e.diagonalizable ? 'diagonalizable' : 'not diagonalizable')));
  if (e.eigenvalues.some((v) => v.kind === 'numeric')) {
    kids.push(el('p', { class: 'note' }, 'The characteristic polynomial has degree ≥ 3 with no rational roots, so these eigenvalues and eigenvectors are numerical.'));
  }
  for (const v of e.eigenvalues) {
    kids.push(el('div', { class: 'eig' },
      el('p', {}, eigLine(v), '   ',
        el('span', { class: 'note' }, `algebraic multiplicity ${v.algMult}, geometric multiplicity ${v.geomMult}`),
        v.geomMult < v.algMult ? el('span', { class: 'badge no', style: 'margin-left:8px' }, 'defective') : null),
      row(el('span', { class: 'label' }, 'Eigenvectors, a basis of '), ml(`N(${T} - \\lambda I)`), vectorList(v.vectors, { name: 'v' }))));
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

  // keep each group together (Array.sort is stable)
  EXAMPLES.sort((x, y) => (x.g === y.g ? 0 : x.g === 'Numeric' ? -1 : 1));
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
