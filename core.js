/* core.js — exact rational linear algebra (BigInt fractions) + numeric eigen helpers.
   Works in the browser (window.MatrixCore) and in Node (module.exports). */
(function (root) {
'use strict';

// ---------- BigInt helpers ----------
const babs = (x) => (x < 0n ? -x : x);
function gcd(a, b) { a = babs(a); b = babs(b); while (b) { const t = a % b; a = b; b = t; } return a; }
function isqrt(n) {
  if (n < 0n) throw new Error('isqrt of negative');
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) { const y = (x + n / x) >> 1n; if (y >= x) return x; x = y; }
}
// sqrt(N) = k * sqrt(m) with m square-free (up to a trial-division limit)
function simplifySqrt(N) {
  let k = 1n, m = N;
  const s = isqrt(m);
  if (s * s === m) return { k: s, m: 1n };
  for (let p = 2n; p * p <= m && p < 20000n; p++) {
    const pp = p * p;
    while (m % pp === 0n) { m /= pp; k *= p; }
  }
  return { k, m };
}

// ---------- Exact fractions ----------
class Frac {
  constructor(n, d = 1n) {
    if (typeof n === 'number') n = BigInt(n);
    if (typeof d === 'number') d = BigInt(d);
    if (d === 0n) throw new Error('Division by zero');
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d) || 1n;
    this.n = n / g; this.d = d / g;
  }
  static parse(str) {
    const s = String(str).replace(/\s+/g, '').replace(/[−–]/g, '-');
    if (s === '') return Frac.ZERO;
    const parts = s.split('/');
    if (parts.length > 2) throw new Error(`Cannot parse "${str}"`);
    const a = Frac.parseDecimal(parts[0], str);
    if (parts.length === 1) return a;
    const b = Frac.parseDecimal(parts[1], str);
    if (b.isZero()) throw new Error(`Division by zero in "${str}"`);
    return a.div(b);
  }
  static parseDecimal(s, orig) {
    const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
    if (!m || ((m[2] || '') === '' && (m[3] || '') === '')) throw new Error(`Cannot parse "${orig !== undefined ? orig : s}"`);
    const sign = m[1] === '-' ? -1n : 1n;
    const ip = m[2] || '0', fp = m[3] || '';
    let n = BigInt(ip + fp), d = 10n ** BigInt(fp.length);
    const e = m[4] ? parseInt(m[4], 10) : 0;
    if (e > 0) n *= 10n ** BigInt(e); else if (e < 0) d *= 10n ** BigInt(-e);
    return new Frac(sign * n, d);
  }
  add(o) { return new Frac(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { return new Frac(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { return new Frac(this.n * o.n, this.d * o.d); }
  div(o) { if (o.n === 0n) throw new Error('Division by zero'); return new Frac(this.n * o.d, this.d * o.n); }
  neg() { return new Frac(-this.n, this.d); }
  abs() { return new Frac(babs(this.n), this.d); }
  isZero() { return this.n === 0n; }
  isOne() { return this.n === 1n && this.d === 1n; }
  isInteger() { return this.d === 1n; }
  sign() { return this.n < 0n ? -1 : this.n > 0n ? 1 : 0; }
  eq(o) { return this.n === o.n && this.d === o.d; }
  cmp(o) { const l = this.n * o.d, r = o.n * this.d; return l < r ? -1 : l > r ? 1 : 0; }
  toNumber() { return Number(this.n) / Number(this.d); }
  toString() { return this.d === 1n ? this.n.toString() : `${this.n}/${this.d}`; }
  // exact square root if q is a perfect-square rational, else null
  static sqrtExact(q) {
    if (q.sign() < 0) return null;
    const a = isqrt(q.n), b = isqrt(q.d);
    return (a * a === q.n && b * b === q.d) ? new Frac(a, b) : null;
  }
}
Frac.ZERO = new Frac(0n);
Frac.ONE = new Frac(1n);
const F = (x) => new Frac(BigInt(x));

// ---------- Complex numbers (numeric) ----------
const C = {
  of: (re, im = 0) => ({ re, im }),
  fromFrac: (f) => ({ re: f.toNumber(), im: 0 }),
  add: (a, b) => ({ re: a.re + b.re, im: a.im + b.im }),
  sub: (a, b) => ({ re: a.re - b.re, im: a.im - b.im }),
  mul: (a, b) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }),
  div: (a, b) => { const d = b.re * b.re + b.im * b.im; return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d }; },
  neg: (a) => ({ re: -a.re, im: -a.im }),
  abs: (a) => Math.hypot(a.re, a.im),
  isZero: (a, tol = 1e-12) => Math.hypot(a.re, a.im) <= tol,
};

// ---------- Basic matrix ops (Frac) ----------
function dims(A) { return [A.length, A.length ? A[0].length : 0]; }
function zeros(m, n) { return Array.from({ length: m }, () => Array.from({ length: n }, () => Frac.ZERO)); }
function identity(n) { return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? Frac.ONE : Frac.ZERO))); }
function clone(A) { return A.map((r) => r.slice()); }
function transpose(A) { const [m, n] = dims(A); return Array.from({ length: n }, (_, j) => Array.from({ length: m }, (_, i) => A[i][j])); }
function add(A, B) {
  const [m, n] = dims(A), [p, q] = dims(B);
  if (m !== p || n !== q) throw new Error(`Cannot add a ${m}×${n} matrix and a ${p}×${q} matrix (dimensions must match)`);
  return A.map((r, i) => r.map((x, j) => x.add(B[i][j])));
}
function sub(A, B) {
  const [m, n] = dims(A), [p, q] = dims(B);
  if (m !== p || n !== q) throw new Error(`Cannot subtract a ${p}×${q} matrix from a ${m}×${n} matrix (dimensions must match)`);
  return A.map((r, i) => r.map((x, j) => x.sub(B[i][j])));
}
function mul(A, B) {
  const [m, n] = dims(A), [p, q] = dims(B);
  if (n !== p) throw new Error(`Cannot multiply a ${m}×${n} matrix by a ${p}×${q} matrix: inner dimensions ${n} ≠ ${p}`);
  const Cm = zeros(m, q);
  for (let i = 0; i < m; i++) for (let j = 0; j < q; j++) {
    let s = Frac.ZERO;
    for (let k = 0; k < n; k++) s = s.add(A[i][k].mul(B[k][j]));
    Cm[i][j] = s;
  }
  return Cm;
}
function scaleMat(A, s) { return A.map((r) => r.map((x) => x.mul(s))); }
function trace(A) { let t = Frac.ZERO; for (let i = 0; i < A.length; i++) t = t.add(A[i][i]); return t; }
function parseMatrix(strRows) { return strRows.map((r) => r.map((s) => Frac.parse(s))); }
function augment(A, B) { return A.map((r, i) => r.concat(B[i])); }

// ---------- RREF with recorded row operations ----------
function fmtCoef(f) { return (f.isInteger() && f.sign() > 0) ? f.toString() : `(${f})`; }
function rref(A, opts = {}) {
  const [rows, cols] = dims(A);
  const M = clone(A);
  const pivotLimit = opts.pivotCols !== undefined ? opts.pivotCols : cols;
  const steps = opts.steps ? [] : null;
  const snap = (desc) => { if (steps) steps.push({ desc, matrix: clone(M) }); };
  let r = 0, swaps = 0;
  const pivots = [];
  for (let c = 0; c < pivotLimit && r < rows; c++) {
    let p = -1;
    for (let i = r; i < rows; i++) if (!M[i][c].isZero()) { p = i; break; }
    if (p < 0) continue;
    if (p !== r) { [M[p], M[r]] = [M[r], M[p]]; swaps++; snap(`R${r + 1} ↔ R${p + 1}`); }
    const pv = M[r][c];
    if (!pv.isOne()) {
      const inv = Frac.ONE.div(pv);
      M[r] = M[r].map((x) => x.mul(inv));
      snap(`R${r + 1} ← ${fmtCoef(inv)} · R${r + 1}`);
    }
    for (let i = 0; i < rows; i++) {
      if (i === r) continue;
      const f = M[i][c];
      if (f.isZero()) continue;
      M[i] = M[i].map((x, j) => x.sub(f.mul(M[r][j])));
      snap(f.sign() < 0 ? `R${i + 1} ← R${i + 1} + ${fmtCoef(f.neg())} · R${r + 1}`
                        : `R${i + 1} ← R${i + 1} − ${fmtCoef(f)} · R${r + 1}`);
    }
    pivots.push(c);
    r++;
  }
  return { R: M, pivots, rank: pivots.length, steps, swaps };
}

// ---------- Determinant (row reduction to echelon form) ----------
function det(A) {
  const [m, n] = dims(A);
  if (m !== n) throw new Error(`Determinant requires a square matrix (got ${m}×${n})`);
  const M = clone(A);
  let d = Frac.ONE, swaps = 0;
  const steps = [];
  for (let c = 0; c < n; c++) {
    let p = -1;
    for (let i = c; i < n; i++) if (!M[i][c].isZero()) { p = i; break; }
    if (p < 0) return { value: Frac.ZERO, echelon: M, swaps, steps, singularAt: c };
    if (p !== c) { [M[p], M[c]] = [M[c], M[p]]; swaps++; steps.push({ desc: `R${c + 1} ↔ R${p + 1}  (det changes sign)`, matrix: clone(M) }); }
    for (let i = c + 1; i < n; i++) {
      const f = M[i][c].div(M[c][c]);
      if (f.isZero()) continue;
      M[i] = M[i].map((x, j) => x.sub(f.mul(M[c][j])));
      steps.push({ desc: f.sign() < 0 ? `R${i + 1} ← R${i + 1} + ${fmtCoef(f.neg())} · R${c + 1}` : `R${i + 1} ← R${i + 1} − ${fmtCoef(f)} · R${c + 1}`, matrix: clone(M) });
    }
    d = d.mul(M[c][c]);
  }
  if (swaps % 2 === 1) d = d.neg();
  return { value: d, echelon: M, swaps, steps, diagonal: M.map((r, i) => r[i]) };
}

// ---------- Gauss–Jordan inverse ----------
function inverse(A) {
  const [m, n] = dims(A);
  if (m !== n) throw new Error(`Inverse requires a square matrix (got ${m}×${n})`);
  const aug = augment(A, identity(n));
  const res = rref(aug, { pivotCols: n, steps: true });
  const singular = res.rank < n;
  return {
    singular,
    inverse: singular ? null : res.R.map((r) => r.slice(n)),
    augmented: aug,
    reduced: res.R,
    steps: res.steps,
    rank: res.rank,
    n,
  };
}

// ---------- Null space & fundamental subspaces ----------
function nullspaceFrom(R, pivots, n) {
  const free = [];
  for (let c = 0; c < n; c++) if (!pivots.includes(c)) free.push(c);
  const basis = free.map((f) => {
    const v = Array.from({ length: n }, () => Frac.ZERO);
    v[f] = Frac.ONE;
    pivots.forEach((pc, k) => { v[pc] = R[k][f].neg(); });
    return v;
  });
  return { basis, free };
}
function nullspace(A) {
  const [, n] = dims(A);
  const { R, pivots } = rref(A);
  const { basis, free } = nullspaceFrom(R, pivots, n);
  return { basis, free, R, pivots };
}
function fourSubspaces(A) {
  const [m, n] = dims(A);
  const { R, pivots, rank } = rref(A);
  const colSpace = pivots.map((c) => A.map((row) => row[c]));
  const rowSpace = R.slice(0, rank).map((row) => row.slice());
  const nullSpace = nullspaceFrom(R, pivots, n);
  const At = transpose(A);
  const rt = rref(At);
  const leftNull = nullspaceFrom(rt.R, rt.pivots, m);
  return { m, n, rank, R, pivots, colSpace, rowSpace, nullSpace: nullSpace.basis, freeCols: nullSpace.free, leftNull: leftNull.basis, Rt: rt.R, pivotsT: rt.pivots };
}

// ---------- Characteristic polynomial (Faddeev–LeVerrier) ----------
// returns coefficients of det(λI − A), highest power first, as Frac
function charPoly(A) {
  const n = A.length;
  const I = identity(n);
  const coef = new Array(n + 1);
  coef[n] = Frac.ONE;
  let Mk = zeros(n, n);
  for (let k = 1; k <= n; k++) {
    Mk = add(mul(A, Mk), scaleMat(I, coef[n - k + 1]));
    coef[n - k] = trace(mul(A, Mk)).div(F(k)).neg();
  }
  return coef.reverse();
}
function polyEval(coefHigh, x) { let acc = Frac.ZERO; for (const c of coefHigh) acc = acc.mul(x).add(c); return acc; }
function polyDeflate(coefHigh, r) {
  const out = [];
  let acc = Frac.ZERO;
  for (let i = 0; i < coefHigh.length - 1; i++) { acc = acc.mul(r).add(coefHigh[i]); out.push(acc); }
  return out;
}

// ---------- Numeric polynomial roots (Durand–Kerner) ----------
function rootsNumeric(coefHigh) {
  const n = coefHigh.length - 1;
  if (n < 1) return [];
  const a = coefHigh.map((c) => c / coefHigh[0]);
  const bound = 1 + Math.max(...a.slice(1).map(Math.abs));
  const ac = a.map((x) => C.of(x));
  const evalP = (z) => { let acc = C.of(0); for (const c of ac) acc = C.add(C.mul(acc, z), c); return acc; };
  const z = Array.from({ length: n }, (_, k) => {
    const ang = (2 * Math.PI * k) / n + 0.4, r = 0.9 * bound;
    return C.of(r * Math.cos(ang), r * Math.sin(ang));
  });
  for (let it = 0; it < 3000; it++) {
    let maxd = 0;
    for (let i = 0; i < n; i++) {
      let den = C.of(1);
      for (let j = 0; j < n; j++) if (j !== i) den = C.mul(den, C.sub(z[i], z[j]));
      if (C.abs(den) < 1e-300) den = C.of(1e-300);
      const delta = C.div(evalP(z[i]), den);
      z[i] = C.sub(z[i], delta);
      maxd = Math.max(maxd, C.abs(delta));
    }
    if (maxd < 1e-15 * bound) break;
  }
  return z.map((w) => (Math.abs(w.im) < 1e-9 * (1 + Math.abs(w.re)) ? C.of(w.re, 0) : w));
}
// continued-fraction convergents of x (candidates for an exact rational root)
function rationalCandidates(x) {
  const out = [];
  if (!isFinite(x)) return out;
  let p0 = 0n, p1 = 1n, q0 = 1n, q1 = 0n, v = x;
  for (let i = 0; i < 40; i++) {
    const a = Math.floor(v);
    if (!isFinite(a)) break;
    const A = BigInt(a);
    const p2 = A * p1 + p0, q2 = A * q1 + q0;
    out.push(new Frac(p2, q2));
    if (q2 > 1000000n) break;
    const frac = v - a;
    if (frac < 1e-12) break;
    v = 1 / frac;
    p0 = p1; p1 = p2; q0 = q1; q1 = q2;
  }
  return out;
}

// ---------- Complex (numeric) elimination ----------
function crref(M, tol) {
  const rows = M.length, cols = M[0].length;
  const R = M.map((r) => r.map((z) => ({ re: z.re, im: z.im })));
  let r = 0;
  const pivots = [];
  for (let c = 0; c < cols && r < rows; c++) {
    let p = -1, best = tol;
    for (let i = r; i < rows; i++) { const a = C.abs(R[i][c]); if (a > best) { best = a; p = i; } }
    if (p < 0) { for (let i = r; i < rows; i++) R[i][c] = C.of(0); continue; }
    if (p !== r) [R[p], R[r]] = [R[r], R[p]];
    const pv = R[r][c];
    R[r] = R[r].map((z) => C.div(z, pv));
    for (let i = 0; i < rows; i++) {
      if (i === r) continue;
      const f = R[i][c];
      if (C.abs(f) === 0) continue;
      R[i] = R[i].map((z, j) => C.sub(z, C.mul(f, R[r][j])));
    }
    pivots.push(c);
    r++;
  }
  return { R, pivots };
}
function complexNullspace(M, maxVectors) {
  const n = M[0].length;
  let scale = 0;
  for (const row of M) for (const z of row) scale = Math.max(scale, C.abs(z));
  scale = scale || 1;
  for (const tol of [1e-11, 1e-9, 1e-7, 1e-5, 1e-3]) {
    const { R, pivots } = crref(M, tol * scale);
    if (pivots.length >= n) continue;
    const free = [];
    for (let c = 0; c < n; c++) if (!pivots.includes(c)) free.push(c);
    const basis = free.map((f) => {
      const v = Array.from({ length: n }, () => C.of(0));
      v[f] = C.of(1);
      pivots.forEach((pc, k) => { v[pc] = C.neg(R[k][f]); });
      return v;
    });
    return maxVectors ? basis.slice(0, maxVectors) : basis;
  }
  return [];
}
function complexInverse(P) {
  const n = P.length;
  let scale = 0;
  for (const row of P) for (const z of row) scale = Math.max(scale, C.abs(z));
  const aug = P.map((row, i) => row.concat(Array.from({ length: n }, (_, j) => C.of(i === j ? 1 : 0))));
  const { R, pivots } = crref(aug, 1e-12 * (scale || 1));
  if (pivots.length < n || pivots.some((c) => c >= n)) return null;
  return R.map((r) => r.slice(n));
}

// ---------- Eigenvalues / eigenvectors ----------
function eigen(A) {
  const [m, n] = dims(A);
  if (m !== n) throw new Error(`Eigenvalues require a square matrix (got ${m}×${n})`);
  const cp = charPoly(A);
  let rem = cp.slice();
  const exact = [];
  const addExact = (val, mult) => { const e = exact.find((x) => x.value.eq(val)); if (e) e.mult += mult; else exact.push({ value: val, mult }); };

  // 1) numeric roots → try to recognise exact rational roots, deflate exactly
  for (const z of rootsNumeric(cp.map((c) => c.toNumber()))) {
    if (rem.length <= 1) break;
    if (Math.abs(z.im) > 1e-3 * (1 + Math.abs(z.re))) continue;
    for (const cand of rationalCandidates(z.re)) {
      if (exact.some((e) => e.value.eq(cand))) break;
      if (!polyEval(rem, cand).isZero()) continue;
      let mult = 0;
      while (rem.length > 1 && polyEval(rem, cand).isZero()) { rem = polyDeflate(rem, cand); mult++; }
      addExact(cand, mult);
      break;
    }
  }

  // 2) whatever is left: linear → exact, quadratic → closed form, else numeric
  const others = [];
  const deg = rem.length - 1;
  if (deg === 1) {
    addExact(rem[1].neg().div(rem[0]), 1);
    rem = [Frac.ONE];
  } else if (deg === 2) {
    const [a, b, c] = rem;
    const D = b.mul(b).sub(F(4).mul(a).mul(c));
    const sD = Frac.sqrtExact(D);
    const twoA = F(2).mul(a);
    if (sD) {
      addExact(b.neg().add(sD).div(twoA), 1);
      addExact(b.neg().sub(sD).div(twoA), 1);
    } else {
      const p = b.neg().div(twoA);
      const q = D.div(twoA.mul(twoA));       // λ = p ± √q
      const qa = q.abs();
      const { k, m: radicand } = simplifySqrt(qa.n * qa.d);
      const coef = new Frac(k, qa.d);        // √(qa) = coef · √radicand
      const rad = Math.sqrt(qa.toNumber());
      const imag = q.sign() < 0;
      for (const s of [1, -1]) {
        const approx = imag ? C.of(p.toNumber(), s * rad) : C.of(p.toNumber() + s * rad, 0);
        others.push({ approx, mult: 1, closed: { p, coef, radicand, imag, sign: s } });
      }
    }
    rem = [Frac.ONE];
  } else if (deg >= 3) {
    for (const r of rootsNumeric(rem.map((c) => c.toNumber()))) {
      const hit = others.find((o) => C.abs(C.sub(o.approx, r)) < 1e-6 * (1 + C.abs(r)));
      if (hit) hit.mult++; else others.push({ approx: r, mult: 1 });
    }
  }

  // 3) eigenvectors
  const evs = [];
  for (const e of exact) {
    const M = sub(A, scaleMat(identity(n), e.value));
    const ns = nullspace(M);
    evs.push({ kind: 'exact', value: e.value, approx: C.of(e.value.toNumber(), 0), algMult: e.mult, geomMult: ns.basis.length, vectors: ns.basis });
  }
  for (const o of others) {
    const Mc = A.map((row, i) => row.map((x, j) => (i === j ? C.sub(C.fromFrac(x), o.approx) : C.fromFrac(x))));
    const basis = complexNullspace(Mc, o.mult);
    evs.push({ kind: 'numeric', approx: o.approx, closed: o.closed, algMult: o.mult, geomMult: basis.length, vectors: basis });
  }
  evs.sort((x, y) => (y.approx.re - x.approx.re) || (y.approx.im - x.approx.im));
  const geomTotal = evs.reduce((s, e) => s + e.geomMult, 0);
  return { n, charPoly: cp, eigenvalues: evs, diagonalizable: geomTotal === n, geomTotal };
}

// ---------- Diagonalization A = P D P⁻¹ ----------
function diagonalize(A) {
  const e = eigen(A);
  const n = e.n;
  if (!e.diagonalizable) return { ok: false, eigen: e };
  const allExact = e.eigenvalues.every((v) => v.kind === 'exact');
  if (allExact) {
    const cols = [], diag = [];
    for (const v of e.eigenvalues) for (const vec of v.vectors) { cols.push(vec); diag.push(v.value); }
    const P = transpose(cols);
    const D = identity(n).map((r, i) => r.map((x, j) => (i === j ? diag[i] : Frac.ZERO)));
    const inv = inverse(P);
    return { ok: true, exact: true, P, D, Pinv: inv.inverse, eigen: e };
  }
  const cols = [], diag = [];
  for (const v of e.eigenvalues) for (const vec of v.vectors) {
    cols.push(v.kind === 'exact' ? vec.map(C.fromFrac) : vec);
    diag.push(v.approx);
  }
  const P = Array.from({ length: n }, (_, i) => cols.map((c) => c[i]));
  const D = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? diag[i] : C.of(0))));
  return { ok: true, exact: false, P, D, Pinv: complexInverse(P), eigen: e };
}

// ---------- Vectors ----------
function asVector(M) {
  const [r, c] = dims(M);
  if (r === 1) return M[0].slice();
  if (c === 1) return M.map((row) => row[0]);
  throw new Error(`A ${r}×${c} matrix is not a vector — use a 1×n row or an n×1 column`);
}
function dot(u, v) {
  if (u.length !== v.length) throw new Error(`Dot product needs vectors of equal length (got ${u.length} and ${v.length})`);
  let s = Frac.ZERO;
  for (let i = 0; i < u.length; i++) s = s.add(u[i].mul(v[i]));
  return s;
}
function cross(u, v) {
  if (u.length !== 3 || v.length !== 3) throw new Error(`Cross product is defined for 3-component vectors (got ${u.length} and ${v.length})`);
  return [
    u[1].mul(v[2]).sub(u[2].mul(v[1])),
    u[2].mul(v[0]).sub(u[0].mul(v[2])),
    u[0].mul(v[1]).sub(u[1].mul(v[0])),
  ];
}

const api = {
  Frac, F, C, gcd, isqrt, simplifySqrt,
  dims, zeros, identity, clone, transpose, add, sub, mul, scaleMat, trace, parseMatrix, augment,
  rref, det, inverse, nullspace, fourSubspaces, charPoly, polyEval, rootsNumeric,
  crref, complexNullspace, complexInverse, eigen, diagonalize, asVector, dot, cross,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.MatrixCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
