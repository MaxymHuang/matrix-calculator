/* app.js — UI for the matrix calculator (depends on core.js → window.MatrixCore) */
(() => {
'use strict';
const K = window.MatrixCore;
const { Frac, C } = K;
const MAX_DIM = 12;

// ---------- state ----------
const state = {
  A: { rows: 3, cols: 3, cells: [] },
  B: { rows: 3, cols: 3, cells: [] },
  target: 'A',
  mode: 'frac',
  precision: 4,
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

// ---------- number formatting ----------
const minus = (s) => s.replace(/-/g, '−');
function fmtDec(x) {
  if (!isFinite(x)) return String(x);
  if (Math.abs(x) < 0.5 * 10 ** -state.precision) x = 0;
  let s = Number.isInteger(x) ? String(x) : x.toFixed(state.precision).replace(/\.?0+$/, '');
  if (s === '-0') s = '0';
  return minus(s);
}
function fmtFrac(f) { return state.mode === 'dec' ? fmtDec(f.toNumber()) : minus(f.toString()); }
function fmtComplex(z) {
  const eps = 0.5 * 10 ** -state.precision;
  const re = Math.abs(z.re) < eps ? 0 : z.re, im = Math.abs(z.im) < eps ? 0 : z.im;
  if (im === 0) return fmtDec(re);
  const imS = Math.abs(im) === 1 ? '' : fmtDec(Math.abs(im));
  if (re === 0) return (im < 0 ? '−' : '') + imS + 'i';
  return `${fmtDec(re)} ${im < 0 ? '−' : '+'} ${imS}i`;
}
function fmtCell(x) { return typeof x === 'object' && 're' in x ? fmtComplex(x) : fmtFrac(x); }
function isZeroCell(x) { return 're' in x ? Math.abs(x.re) < 1e-12 && Math.abs(x.im) < 1e-12 : x.isZero(); }
function fmtCoefSigned(f, first) {
  // returns [sign, magnitude-string] for polynomial printing
  const neg = f.sign() < 0, a = f.abs();
  const sign = neg ? '−' : (first ? '' : '+');
  return [sign, a];
}
function charPolyString(coefHigh) {
  const n = coefHigh.length - 1;
  const sup = (k) => String(k).replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d]);
  let out = '';
  coefHigh.forEach((c, i) => {
    const k = n - i;
    if (c.isZero()) return;
    const [sign, a] = fmtCoefSigned(c, out === '');
    let mag = (a.isOne() && k > 0) ? '' : minus(a.toString());
    if (mag.includes('/')) mag = `(${mag})`;
    const term = k === 0 ? mag : k === 1 ? `${mag}λ` : `${mag}λ${sup(k)}`;
    out += (out === '' ? sign : ` ${sign} `) + term;
  });
  return out || '0';
}

// ---------- matrix rendering ----------
function matrixEl(M, opts = {}) {
  const table = el('table');
  const pivotSet = new Set((opts.pivots || []).map(([r, c]) => `${r},${c}`));
  M.forEach((row, i) => {
    const tr = el('tr');
    row.forEach((x, j) => {
      const td = el('td', {}, fmtCell(x));
      if (opts.aug !== undefined && j === opts.aug) td.classList.add('aug');
      if (pivotSet.has(`${i},${j}`)) td.classList.add('pivot');
      else if (isZeroCell(x)) td.classList.add('zero');
      tr.append(td);
    });
    table.append(tr);
  });
  const mat = el('div', { class: 'mat' }, table);
  const wrap = el('div', { class: 'matwrap' }, mat);
  if (opts.caption) wrap.append(el('div', { class: 'cap' }, opts.caption));
  if (opts.sendable && M.length && M[0].length && M[0][0] instanceof Frac && M.length <= MAX_DIM && M[0].length <= MAX_DIM) {
    wrap.append(el('div', { class: 'send' },
      el('button', { class: 'small', onclick: () => loadMatrix('A', M) }, '→ A'),
      el('button', { class: 'small', onclick: () => loadMatrix('B', M) }, '→ B')));
  }
  return wrap;
}
const colVec = (v, opts) => matrixEl(v.map((x) => [x]), opts);
function vectorList(vs, opts = {}) {
  if (!vs.length) return el('span', { class: 'trivial' }, '{ 0 }  (only the zero vector)');
  return el('div', { class: 'vecs' }, vs.map((v, i) => colVec(v, { caption: opts.name ? `${opts.name}${i + 1}` : undefined, ...opts })));
}

// ---------- input panels ----------
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
      el('div', { class: 'dims' }, rowsIn, '×', colsIn)),
    el('div', { class: 'grid-wrap' }, el('div', { class: 'grid' })),
    el('div', { class: 'tools' },
      el('button', { class: 'small', onclick: () => fill(name, (i, j) => (i === j ? '1' : '0')) }, 'Identity'),
      el('button', { class: 'small', onclick: () => fill(name, () => '0') }, 'Zeros'),
      el('button', { class: 'small', onclick: () => fill(name, () => String(Math.floor(Math.random() * 19) - 9)) }, 'Random'),
      el('button', { class: 'small', onclick: () => fill(name, () => '') }, 'Clear'),
      el('button', { class: 'small', onclick: () => { const M = readMatrix(name); loadMatrix(name, K.transpose(M)); } }, 'Transpose in place'),
      el('button', { class: 'small', onclick: () => loadMatrix(name === 'A' ? 'B' : 'A', readMatrix(name)) }, `Copy to ${name === 'A' ? 'B' : 'A'}`),
      el('button', { class: 'small', onclick: () => pasteDialog(name) }, 'Paste…')));
  renderGrid(name);
}
const clampDim = (v) => Math.min(MAX_DIM, Math.max(1, parseInt(v, 10) || 1));
function resize(name, r, c) {
  const st = state[name];
  const cells = Array.from({ length: r }, (_, i) => Array.from({ length: c }, (_, j) => (st.cells[i] && st.cells[i][j] !== undefined ? st.cells[i][j] : '0')));
  st.rows = r; st.cols = c; st.cells = cells;
}
function renderGrid(name) {
  const st = state[name];
  const grid = $(`#panel-${name} .grid`);
  grid.innerHTML = '';
  grid.style.gridTemplateColumns = `repeat(${st.cols}, auto)`;
  for (let i = 0; i < st.rows; i++) for (let j = 0; j < st.cols; j++) {
    const inp = el('input', { type: 'text', value: st.cells[i][j], 'aria-label': `${name}[${i + 1},${j + 1}]`, spellcheck: 'false' });
    inp.addEventListener('input', () => {
      st.cells[i][j] = inp.value;
      try { Frac.parse(inp.value); inp.classList.remove('bad'); } catch { inp.classList.add('bad'); }
    });
    inp.addEventListener('focus', () => inp.select());
    inp.addEventListener('paste', (ev) => {
      const text = (ev.clipboardData || window.clipboardData).getData('text');
      if (/[\n;]/.test(text.trim()) || text.trim().split(/[\s,]+/).length > 1) { ev.preventDefault(); loadFromText(name, text); }
    });
    inp.addEventListener('keydown', (ev) => {
      // arrow-key navigation between cells
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
}
function fill(name, fn) {
  const st = state[name];
  st.cells = st.cells.map((row, i) => row.map((_, j) => fn(i, j)));
  renderGrid(name);
}
function loadMatrix(name, M) {
  const st = state[name];
  st.rows = M.length; st.cols = M[0].length;
  st.cells = M.map((r) => r.map((x) => x.toString()));
  const panel = $(`#panel-${name}`);
  const [ri, ci] = panel.querySelectorAll('.dims input');
  ri.value = st.rows; ci.value = st.cols;
  renderGrid(name);
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function loadFromText(name, text) {
  const rows = text.trim().split(/\r?\n|;/).map((l) => l.trim()).filter(Boolean)
    .map((l) => l.replace(/^[\[\(]|[\]\)]$/g, '').trim().split(/[\s,]+/).filter(Boolean));
  if (!rows.length) return;
  const c = Math.max(...rows.map((r) => r.length));
  if (rows.length > MAX_DIM || c > MAX_DIM) { showError(`Pasted matrix is ${rows.length}×${c}; the maximum is ${MAX_DIM}×${MAX_DIM}`); return; }
  const M = rows.map((r) => Array.from({ length: c }, (_, j) => r[j] !== undefined ? r[j] : '0'));
  state[name].rows = rows.length; state[name].cols = c; state[name].cells = M;
  const [ri, ci] = $(`#panel-${name}`).querySelectorAll('.dims input');
  ri.value = rows.length; ci.value = c;
  renderGrid(name);
}
function pasteDialog(name) {
  const text = window.prompt(`Paste matrix ${name}: one row per line (or separated by ";"), entries separated by spaces or commas.\nExample:\n1 2 3\n4 5 6`);
  if (text) loadFromText(name, text);
}
function readMatrix(name) {
  const st = state[name];
  try {
    return K.parseMatrix(st.cells);
  } catch (e) {
    throw new Error(`Matrix ${name}: ${e.message}`);
  }
}

// ---------- result cards ----------
const results = $('#results');
function card(title, ...children) {
  const c = el('div', { class: 'card' }, el('h2', {}, title), ...children);
  results.prepend(c);
  c.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return c;
}
function showError(msg) {
  const c = el('div', { class: 'card error' }, el('h2', {}, 'Error'), el('p', {}, msg));
  results.prepend(c);
}
const row = (...items) => el('div', { class: 'row' }, ...items);
const opSym = (s) => el('span', { class: 'op' }, s);
function stepsDetails(steps, opts = {}, label = 'Show row operations') {
  if (!steps || !steps.length) return el('p', { class: 'note' }, 'No row operations were needed.');
  return el('details', {}, el('summary', {}, `${label} (${steps.length})`),
    el('div', { class: 'steps' }, steps.map((s, i) => el('div', { class: 'step' }, el('div', { class: 'desc' }, `${i + 1}. ${s.desc}`), matrixEl(s.matrix, opts)))));
}
const pivotCells = (pivots) => pivots.map((c, r) => [r, c]);

// ---------- operations ----------
const ops = {
  mul() { const A = readMatrix('A'), B = readMatrix('B'); const P = K.mul(A, B);
    card('A × B', row(matrixEl(A, { caption: 'A' }), opSym('×'), matrixEl(B, { caption: 'B' }), opSym('='), matrixEl(P, { caption: `A × B  (${P.length}×${P[0].length})`, sendable: true }))); },
  mulBA() { const A = readMatrix('A'), B = readMatrix('B'); const P = K.mul(B, A);
    card('B × A', row(matrixEl(B, { caption: 'B' }), opSym('×'), matrixEl(A, { caption: 'A' }), opSym('='), matrixEl(P, { caption: `B × A  (${P.length}×${P[0].length})`, sendable: true }))); },
  add() { const A = readMatrix('A'), B = readMatrix('B');
    card('A + B', row(matrixEl(A), opSym('+'), matrixEl(B), opSym('='), matrixEl(K.add(A, B), { sendable: true }))); },
  sub() { const A = readMatrix('A'), B = readMatrix('B');
    card('A − B', row(matrixEl(A), opSym('−'), matrixEl(B), opSym('='), matrixEl(K.sub(A, B), { sendable: true }))); },
  dot() {
    const u = K.asVector(readMatrix('A')), v = K.asVector(readMatrix('B'));
    const d = K.dot(u, v);
    const nu = K.dot(u, u), nv = K.dot(v, v);
    const terms = u.map((x, i) => `(${fmtFrac(x)})(${fmtFrac(v[i])})`).join(' + ');
    const extra = [];
    if (!nu.isZero() && !nv.isZero()) {
      const cos = d.toNumber() / Math.sqrt(nu.toNumber() * nv.toNumber());
      const ang = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
      extra.push(el('p', {}, el('span', { class: 'label' }, '‖u‖ ='), el('span', { class: 'math' }, sqrtString(nu)), '   ',
        el('span', { class: 'label' }, '‖v‖ ='), el('span', { class: 'math' }, sqrtString(nv))));
      extra.push(el('p', {}, el('span', { class: 'label' }, 'Angle between u and v:'), el('span', { class: 'math' }, `${fmtDec(ang)}°`),
        d.isZero() ? el('span', { class: 'badge ok', style: 'margin-left:8px' }, 'orthogonal') : null));
    }
    card('Dot product  u · v', row(colVec(u, { caption: 'u' }), opSym('·'), colVec(v, { caption: 'v' }), opSym('='), el('span', { class: 'big' }, fmtFrac(d))),
      el('p', { class: 'math note' }, `u · v = ${terms} = ${fmtFrac(d)}`), ...extra);
  },
  cross() {
    const u = K.asVector(readMatrix('A')), v = K.asVector(readMatrix('B'));
    const w = K.cross(u, v);
    card('Cross product  u ⨯ v', row(colVec(u, { caption: 'u' }), opSym('⨯'), colVec(v, { caption: 'v' }), opSym('='), colVec(w, { caption: 'u ⨯ v', sendable: true })),
      el('p', { class: 'math note' }, `u ⨯ v = ( u₂v₃ − u₃v₂,  u₃v₁ − u₁v₃,  u₁v₂ − u₂v₁ )`),
      el('p', { class: 'note' }, `Check: (u ⨯ v) · u = ${fmtFrac(K.dot(w, u))},  (u ⨯ v) · v = ${fmtFrac(K.dot(w, v))}  — the result is orthogonal to both.`),
      el('p', { class: 'note' }, el('span', { class: 'label' }, '‖u ⨯ v‖ ='), el('span', { class: 'math' }, sqrtString(K.dot(w, w))), ' (area of the parallelogram spanned by u and v)'));
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
      stepsDetails(res.steps, { pivots: [] }));
  },
  det() {
    const T = state.target, A = readMatrix(T);
    const r = K.det(A);
    const n = A.length;
    const body = [row(el('span', { class: 'big' }, `det(${T}) = ${fmtFrac(r.value)}`), r.value.isZero() ? el('span', { class: 'badge no' }, 'singular') : el('span', { class: 'badge ok' }, 'invertible'))];
    if (n === 2) body.push(el('p', { class: 'math note' }, `ad − bc = (${fmtFrac(A[0][0])})(${fmtFrac(A[1][1])}) − (${fmtFrac(A[0][1])})(${fmtFrac(A[1][0])}) = ${fmtFrac(r.value)}`));
    if (r.singularAt !== undefined) {
      body.push(el('p', { class: 'note' }, `Row reduction produced a zero column below the diagonal in column ${r.singularAt + 1}, so the determinant is 0.`));
    } else {
      const diag = r.diagonal.map(fmtFrac).map((s) => (s.startsWith('−') || s.includes('/') ? `(${s})` : s)).join(' · ');
      body.push(el('p', { class: 'note' }, `Row reduction to upper-triangular form used ${r.swaps} row swap${r.swaps === 1 ? '' : 's'}; det = ${r.swaps % 2 ? '−' : ''}(product of the diagonal) = ${r.swaps % 2 ? '−' : ''}${diag} = ${fmtFrac(r.value)}`));
    }
    body.push(row(matrixEl(A, { caption: T }), opSym('→'), matrixEl(r.echelon, { caption: 'upper triangular' })));
    body.push(stepsDetails(r.steps));
    card(`det(${T})`, ...body);
  },
  inverse() {
    const T = state.target, A = readMatrix(T);
    const r = K.inverse(A);
    const n = r.n;
    if (r.singular) {
      card(`${T}⁻¹ (Gauss–Jordan)`,
        el('p', {}, el('span', { class: 'badge no' }, 'singular'), ` ${T} is not invertible: rank ${r.rank} < ${n}, so [${T} | I] cannot be reduced to [I | ${T}⁻¹].`),
        row(matrixEl(r.augmented, { aug: n, caption: `[${T} | I]` }), opSym('→'), matrixEl(r.reduced, { aug: n, caption: 'reduced' })),
        stepsDetails(r.steps, { aug: n }));
      return;
    }
    card(`${T}⁻¹ (Gauss–Jordan)`,
      el('p', { class: 'note' }, `Augment with the identity and row-reduce: [${T} | I] → [I | ${T}⁻¹]`),
      row(matrixEl(r.augmented, { aug: n, caption: `[${T} | I]` }), opSym('→'), matrixEl(r.reduced, { aug: n, caption: `[I | ${T}⁻¹]` })),
      row(el('span', { class: 'label' }, `${T}⁻¹ =`), matrixEl(r.inverse, { sendable: true })),
      el('p', { class: 'note' }, `Check: ${T} · ${T}⁻¹ = I  ✓  (det ${T} = ${fmtFrac(K.det(A).value)})`),
      stepsDetails(r.steps, { aug: n }));
  },
  eigen() {
    const T = state.target, A = readMatrix(T);
    const e = K.eigen(A);
    card(`Eigenvalues & eigenvectors of ${T}`, ...eigenBody(e, T));
  },
  subspaces() {
    const T = state.target, A = readMatrix(T);
    const s = K.fourSubspaces(A);
    const { m, n, rank } = s;
    card(`Four fundamental subspaces of ${T}  (${m}×${n}, rank ${rank})`,
      row(matrixEl(A, { caption: T }), opSym('→'), matrixEl(s.R, { caption: `rref(${T})`, pivots: pivotCells(s.pivots) })),
      el('p', { class: 'note' }, `Pivot columns: ${s.pivots.length ? s.pivots.map((c) => c + 1).join(', ') : 'none'};  free columns: ${s.freeCols.length ? s.freeCols.map((c) => c + 1).join(', ') : 'none'}.  dim C(A) + dim N(A) = ${rank} + ${n - rank} = ${n};  dim C(Aᵀ) + dim N(Aᵀ) = ${rank} + ${m - rank} = ${m}.`),
      subspaceSection(`Column space  C(${T})`, `subspace of ℝ${sup(m)}, dimension ${rank}`, 'The pivot columns of the original matrix.', s.colSpace, 'c'),
      subspaceSection(`Row space  C(${T}ᵀ)`, `subspace of ℝ${sup(n)}, dimension ${rank}`, `The nonzero rows of rref(${T}).`, s.rowSpace, 'r'),
      subspaceSection(`Null space  N(${T})`, `subspace of ℝ${sup(n)}, dimension ${n - rank}`, 'Special solutions: set one free variable to 1 and the others to 0.', s.nullSpace, 'n'),
      subspaceSection(`Left null space  N(${T}ᵀ)`, `subspace of ℝ${sup(m)}, dimension ${m - rank}`, `Null space of ${T}ᵀ; these vectors y satisfy yᵀ${T} = 0.`, s.leftNull, 'y'));
  },
  diag() {
    const T = state.target, A = readMatrix(T);
    const d = K.diagonalize(A);
    if (!d.ok) {
      const bad = d.eigen.eigenvalues.filter((v) => v.geomMult < v.algMult);
      card(`Diagonalize ${T}`,
        el('p', {}, el('span', { class: 'badge no' }, 'not diagonalizable'),
          ` ${T} has only ${d.eigen.geomTotal} linearly independent eigenvector${d.eigen.geomTotal === 1 ? '' : 's'} but is ${d.eigen.n}×${d.eigen.n}.`),
        ...bad.map((v) => el('p', { class: 'note' }, `λ = ${eigValueString(v)}: algebraic multiplicity ${v.algMult}, geometric multiplicity ${v.geomMult}.`)),
        el('details', {}, el('summary', {}, 'Eigenvalue details'), ...eigenBody(d.eigen, T)));
      return;
    }
    const kids = [];
    if (!d.exact) kids.push(el('p', { class: 'note' }, 'Some eigenvalues are irrational or complex, so P, D and P⁻¹ are shown numerically (diagonalization over ℂ).'));
    kids.push(row(el('span', { class: 'label' }, `${T} = P D P⁻¹  with`), matrixEl(d.P, { caption: 'P (eigenvectors as columns)', sendable: true }), matrixEl(d.D, { caption: 'D (eigenvalues)', sendable: true }),
      d.Pinv ? matrixEl(d.Pinv, { caption: 'P⁻¹', sendable: true }) : el('span', { class: 'note' }, 'P⁻¹ could not be computed numerically')));
    if (d.exact) {
      const back = K.mul(K.mul(d.P, d.D), d.Pinv);
      const ok = back.every((r, i) => r.every((x, j) => x.eq(A[i][j])));
      kids.push(el('p', { class: 'note' }, `Check: P D P⁻¹ = ${T}  ${ok ? '✓' : '✗'}`));
      kids.push(el('p', { class: 'note' }, `Consequence: ${T}ᵏ = P Dᵏ P⁻¹, where Dᵏ just raises each diagonal entry to the k-th power.`));
    }
    kids.push(el('details', {}, el('summary', {}, 'Eigenvalue details'), ...eigenBody(d.eigen, T)));
    card(`Diagonalize ${T}`, ...kids);
  },
};

const sup = (k) => String(k).replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d]);
function subspaceSection(title, dimText, hint, basis, name) {
  return el('div', { class: 'subspace' },
    el('h3', {}, title, ' ', el('span', { class: 'note' }, `— ${dimText}`)),
    el('p', { class: 'note' }, hint),
    row(el('span', { class: 'label' }, 'Basis:'), vectorList(basis, { name, sendable: false })));
}
function sqrtString(q) {
  // q is a Frac ≥ 0; returns "√q" simplified plus decimal
  const ex = Frac.sqrtExact(q);
  if (ex) return fmtFrac(ex);
  const { k, m } = K.simplifySqrt(q.n * q.d);
  const coef = new Frac(k, q.d);
  const coefS = coef.isOne() ? '' : (coef.isInteger() ? coef.toString() : `(${coef})`);
  return `${coefS}√${m}  ≈ ${fmtDec(Math.sqrt(q.toNumber()))}`;
}
function eigValueString(v) {
  if (v.kind === 'exact') return fmtFrac(v.value);
  if (v.closed) {
    const { p, coef, radicand, imag, sign } = v.closed;
    const cS = coef.isOne() ? '' : (coef.isInteger() ? coef.toString() : `(${coef})`);
    const radS = radicand === 1n ? `${cS}${imag ? 'i' : ''}` : `${cS}${imag ? 'i' : ''}√${radicand}`;
    const pS = p.isZero() ? '' : minus(p.toString()) + ' ';
    return `${pS}${sign > 0 ? (p.isZero() ? '' : '+ ') : '− '}${radS}  ≈ ${fmtComplex(v.approx)}`;
  }
  return `≈ ${fmtComplex(v.approx)}`;
}
function eigenBody(e, T) {
  const kids = [];
  kids.push(el('p', {}, el('span', { class: 'label' }, 'Characteristic polynomial:'), el('span', { class: 'math' }, `det(λI − ${T}) = ${charPolyString(e.charPoly)}`)));
  kids.push(el('p', {}, el('span', { class: 'label' }, 'Eigenvalues:'), el('span', { class: 'math' }, e.eigenvalues.map((v) => `λ = ${eigValueString(v)}${v.algMult > 1 ? ` (×${v.algMult})` : ''}`).join(' ;  ')),
    ' ', el('span', { class: e.diagonalizable ? 'badge ok' : 'badge no' }, e.diagonalizable ? 'diagonalizable' : 'not diagonalizable')));
  if (e.eigenvalues.some((v) => v.kind === 'numeric')) kids.push(el('p', { class: 'note' }, 'Irrational/complex eigenvalues and their eigenvectors are computed numerically.'));
  for (const v of e.eigenvalues) {
    kids.push(el('div', { class: 'eig' },
      el('p', {}, el('span', { class: 'label' }, 'λ ='), el('span', { class: 'math' }, eigValueString(v)), '   ',
        el('span', { class: 'note' }, `algebraic multiplicity ${v.algMult}, geometric multiplicity ${v.geomMult}`),
        v.geomMult < v.algMult ? el('span', { class: 'badge no', style: 'margin-left:8px' }, 'defective') : null),
      row(el('span', { class: 'label' }, `Eigenvectors (basis of N(${T} − λI)):`), vectorList(v.vectors, { name: 'v', sendable: false }))));
  }
  return kids;
}

// ---------- examples ----------
const EXAMPLES = [
  { name: '3×3 invertible (RREF / inverse / det)', A: '2 1 1\n1 3 2\n1 0 0', B: '1 0 0\n0 1 0\n0 0 1' },
  { name: '3×4 rank 2 (four subspaces)', A: '1 2 2 2\n2 4 6 8\n3 6 8 10', B: '1\n2\n3\n4' },
  { name: '2×2 with rational eigenvalues (diagonalize)', A: '4 1\n2 3', B: '1 0\n0 1' },
  { name: '3×3 symmetric (orthogonal eigenvectors)', A: '2 1 1\n1 2 1\n1 1 2', B: '1 0 0\n0 1 0\n0 0 1' },
  { name: '2×2 rotation (complex eigenvalues)', A: '0 -1\n1 0', B: '1 0\n0 1' },
  { name: 'Fibonacci matrix (golden-ratio eigenvalues)', A: '1 1\n1 0', B: '1 0\n0 1' },
  { name: 'Jordan block (not diagonalizable)', A: '2 1 0\n0 2 0\n0 0 3', B: '1 0 0\n0 1 0\n0 0 1' },
  { name: 'Matrix product 2×3 · 3×2', A: '1 2 3\n4 5 6', B: '7 8\n9 10\n11 12' },
  { name: 'Vectors u, v in ℝ³ (dot / cross)', A: '1\n2\n3', B: '4\n5\n6' },
  { name: 'Fractions & decimals', A: '1/2 0.25 -3\n2/3 1 0\n0 1.5 -1/4', B: '1 0 0\n0 1 0\n0 0 1' },
];

// ---------- wiring ----------
function init() {
  resize('A', 3, 3); resize('B', 3, 3);
  state.A.cells = [['2', '1', '1'], ['1', '3', '2'], ['1', '0', '0']];
  state.B.cells = [['1', '0', '0'], ['0', '1', '0'], ['0', '0', '1']];
  buildPanel('A'); buildPanel('B');

  document.querySelectorAll('button[data-op]').forEach((b) => b.addEventListener('click', () => {
    try { ops[b.dataset.op](); } catch (err) { showError(err.message); console.error(err); }
  }));
  $('#target-seg').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    state.target = b.dataset.target;
    $('#target-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  });
  $('#num-mode').addEventListener('change', (ev) => { state.mode = ev.target.value; });
  $('#precision').addEventListener('change', (ev) => { state.precision = Math.min(12, Math.max(0, parseInt(ev.target.value, 10) || 0)); ev.target.value = state.precision; });
  $('#clear-results').addEventListener('click', () => { results.innerHTML = ''; });
  const exSel = $('#examples');
  EXAMPLES.forEach((ex, i) => exSel.append(el('option', { value: i }, ex.name)));
  exSel.addEventListener('change', () => {
    const ex = EXAMPLES[exSel.value]; if (!ex) return;
    loadFromText('A', ex.A); loadFromText('B', ex.B);
    exSel.value = '';
  });
}
init();
})();
