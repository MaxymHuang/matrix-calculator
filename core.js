/* core.js — linear algebra over exact symbolic expressions.
 *
 * Every matrix entry is an Expr (symbolic.js). A plain number is just an Expr with
 * no symbols, so the same routines serve numeric and symbolic matrices alike.
 *
 * Browser: window.MatrixCore · Node: module.exports
 */
(function (root) {
'use strict';
const isNode = (typeof module !== 'undefined' && module.exports);
const FL = isNode ? require('./fraction.js') : root.FractionLib;
const SY = isNode ? require('./symbolic.js') : root.Symbolic;
const { Frac, F, isqrt, simplifySqrt } = FL;
const { Expr, E, display, sqrtExpr } = SY;

/* ---------------------------------------------- numeric complex helpers */
const C = {
  of: (re, im = 0) => ({ re, im }),
  add: (a, b) => ({ re: a.re + b.re, im: a.im + b.im }),
  sub: (a, b) => ({ re: a.re - b.re, im: a.im - b.im }),
  mul: (a, b) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }),
  div: (a, b) => { const d = b.re * b.re + b.im * b.im; return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d }; },
  neg: (a) => ({ re: -a.re, im: -a.im }),
  abs: (a) => Math.hypot(a.re, a.im),
};

/* ------------------------------------------------------- basic matrix ops */
function dims(A) { return [A.length, A.length ? A[0].length : 0]; }
function zeros(m, n) { return Array.from({ length: m }, () => Array.from({ length: n }, () => Expr.ZERO)); }
function identity(n) { return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? Expr.ONE : Expr.ZERO))); }
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
  const R = zeros(m, q);
  for (let i = 0; i < m; i++) for (let j = 0; j < q; j++) {
    let s = Expr.ZERO;
    for (let k = 0; k < n; k++) s = s.add(A[i][k].mul(B[k][j]));
    R[i][j] = s;
  }
  return R;
}
function scaleMat(A, s) { return A.map((r) => r.map((x) => x.mul(s))); }
function trace(A) { let t = Expr.ZERO; for (let i = 0; i < A.length; i++) t = t.add(A[i][i]); return t; }
function parseMatrix(strRows) { return strRows.map((r) => r.map((s) => Expr.parse(s))); }
function augment(A, B) { return A.map((r, i) => r.concat(B[i])); }
const isSymbolic = (A) => A.some((r) => r.some((x) => x.constVal() === null));
function substMatrix(A, env) { return A.map((r) => r.map((x) => x.subst(env))); }
function matrixVars(A) {
  const s = new Set();
  for (const r of A) for (const x of r) for (const v of x.vars()) s.add(v);
  return [...s];
}

/* ----------------------------------------------------------------- RREF */
// Pivots are chosen on structural nonzeroness; a non-constant pivot is recorded
// as an assumption, because the reduction is only valid where it does not vanish.
function rref(A, opts = {}) {
  const [rows, cols] = dims(A);
  const M = clone(A);
  const pivotLimit = opts.pivotCols !== undefined ? opts.pivotCols : cols;
  const steps = opts.steps ? [] : null;
  const assumptions = [];
  const note = (e) => { if (e.constVal() === null && !assumptions.some((a) => a.eq(e))) assumptions.push(e); };
  const snap = (op) => { if (steps) steps.push(Object.assign({}, op, { matrix: clone(M) })); };
  let r = 0, swaps = 0;
  const pivots = [];
  for (let c = 0; c < pivotLimit && r < rows; c++) {
    let p = -1;
    for (let i = r; i < rows; i++) if (!M[i][c].isZero()) { p = i; break; }
    if (p < 0) continue;
    if (p !== r) { [M[p], M[r]] = [M[r], M[p]]; swaps++; snap({ kind: 'swap', i: r, j: p }); }
    const pv = M[r][c];
    note(pv);
    if (!pv.isOne()) {
      const inv = Expr.ONE.div(pv);
      M[r] = M[r].map((x) => x.mul(inv));
      snap({ kind: 'scale', i: r, factor: inv });
    }
    for (let i = 0; i < rows; i++) {
      if (i === r) continue;
      const f = M[i][c];
      if (f.isZero()) continue;
      M[i] = M[i].map((x, j) => x.sub(f.mul(M[r][j])));
      snap({ kind: 'elim', i, j: r, factor: f });
    }
    pivots.push(c);
    r++;
  }
  return { R: M, pivots, rank: pivots.length, steps, swaps, assumptions };
}

/* ---------------------------------------------------------- determinant */
// Laplace expansion (division-free, keeps symbolic results as clean polynomials)
function detCofactor(A) {
  const n = A.length;
  const memo = new Map();
  const go = (rowsLeft, mask) => {
    if (rowsLeft === n) return Expr.ONE;
    const key = `${rowsLeft}|${mask}`;
    const hit = memo.get(key);
    if (hit) return hit;
    let acc = Expr.ZERO, sign = 1;
    for (let c = 0; c < n; c++) {
      if (mask & (1 << c)) continue;
      const a = A[rowsLeft][c];
      if (!a.isZero()) {
        const t = a.mul(go(rowsLeft + 1, mask | (1 << c)));
        acc = sign > 0 ? acc.add(t) : acc.sub(t);
      }
      sign = -sign;
    }
    memo.set(key, acc);
    return acc;
  };
  return go(0, 0);
}
function det(A) {
  const [m, n] = dims(A);
  if (m !== n) throw new Error(`Determinant requires a square matrix (got ${m}×${n})`);
  if (n === 0) return { value: Expr.ONE, method: 'trivial', steps: [], assumptions: [] };
  if (isSymbolic(A)) {
    if (n > 8) throw new Error(`Symbolic determinants are limited to 8×8 (got ${n}×${n})`);
    return { value: detCofactor(A), method: 'cofactor', steps: [], assumptions: [] };
  }
  const M = clone(A);
  let d = Expr.ONE, swaps = 0;
  const steps = [];
  for (let c = 0; c < n; c++) {
    let p = -1;
    for (let i = c; i < n; i++) if (!M[i][c].isZero()) { p = i; break; }
    if (p < 0) return { value: Expr.ZERO, echelon: M, swaps, steps, singularAt: c, method: 'elimination', assumptions: [] };
    if (p !== c) { [M[p], M[c]] = [M[c], M[p]]; swaps++; steps.push({ kind: 'swap', i: c, j: p, matrix: clone(M) }); }
    for (let i = c + 1; i < n; i++) {
      const f = M[i][c].div(M[c][c]);
      if (f.isZero()) continue;
      M[i] = M[i].map((x, j) => x.sub(f.mul(M[c][j])));
      steps.push({ kind: 'elim', i, j: c, factor: f, matrix: clone(M) });
    }
    d = d.mul(M[c][c]);
  }
  if (swaps % 2 === 1) d = d.neg();
  return { value: d, echelon: M, swaps, steps, method: 'elimination', diagonal: M.map((r, i) => r[i]), assumptions: [] };
}

/* ----------------------------------------------- Gauss–Jordan inverse */
function inverse(A) {
  const [m, n] = dims(A);
  if (m !== n) throw new Error(`Inverse requires a square matrix (got ${m}×${n})`);
  const aug = augment(A, identity(n));
  const res = rref(aug, { pivotCols: n, steps: true });
  const singular = res.rank < n;
  return {
    singular,
    inverse: singular ? null : res.R.map((r) => r.slice(n)),
    augmented: aug, reduced: res.R, steps: res.steps, rank: res.rank, n,
    assumptions: res.assumptions,
  };
}

/* ------------------------------------------ null space & the 4 subspaces */
function nullspaceFrom(R, pivots, n) {
  const free = [];
  for (let c = 0; c < n; c++) if (!pivots.includes(c)) free.push(c);
  const basis = free.map((f) => {
    const v = Array.from({ length: n }, () => Expr.ZERO);
    v[f] = Expr.ONE;
    pivots.forEach((pc, k) => { v[pc] = R[k][f].neg(); });
    return v;
  });
  return { basis, free };
}
function nullspace(A) {
  const [, n] = dims(A);
  const { R, pivots, assumptions } = rref(A);
  const { basis, free } = nullspaceFrom(R, pivots, n);
  return { basis, free, R, pivots, assumptions };
}
function fourSubspaces(A) {
  const [m, n] = dims(A);
  const { R, pivots, rank, assumptions } = rref(A);
  const colSpace = pivots.map((c) => A.map((row) => row[c]));
  const rowSpace = R.slice(0, rank).map((row) => row.slice());
  const ns = nullspaceFrom(R, pivots, n);
  const rt = rref(transpose(A));
  const leftNull = nullspaceFrom(rt.R, rt.pivots, m);
  const asm = assumptions.slice();
  for (const a of rt.assumptions) if (!asm.some((x) => x.eq(a))) asm.push(a);
  return { m, n, rank, R, pivots, colSpace, rowSpace, nullSpace: ns.basis, freeCols: ns.free,
    leftNull: leftNull.basis, Rt: rt.R, pivotsT: rt.pivots, assumptions: asm };
}

/* ---------------------------------- characteristic polynomial and roots */
// det(λI − A) coefficients, highest power first (Faddeev–LeVerrier)
function charPoly(A) {
  const n = A.length;
  const I = identity(n);
  const coef = new Array(n + 1);
  coef[n] = Expr.ONE;
  let Mk = zeros(n, n);
  for (let k = 1; k <= n; k++) {
    Mk = add(mul(A, Mk), scaleMat(I, coef[n - k + 1]));
    coef[n - k] = trace(mul(A, Mk)).div(E(k)).neg();
  }
  return coef.reverse();
}
const fPolyEval = (c, x) => c.reduce((acc, k) => acc.mul(x).add(k), Frac.ZERO);
function fPolyDeflate(c, r) {
  const out = [];
  let acc = Frac.ZERO;
  for (let i = 0; i < c.length - 1; i++) { acc = acc.mul(r).add(c[i]); out.push(acc); }
  return out;
}
function rootsNumeric(coefHigh) {   // Durand–Kerner
  const n = coefHigh.length - 1;
  if (n < 1) return [];
  const a = coefHigh.map((c) => c / coefHigh[0]);
  const bound = 1 + Math.max(...a.slice(1).map(Math.abs));
  const ac = a.map((x) => C.of(x));
  const evalP = (z) => ac.reduce((acc, c) => C.add(C.mul(acc, z), c), C.of(0));
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
function rationalCandidates(x) {   // continued-fraction convergents
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
    const fr = v - a;
    if (fr < 1e-12) break;
    v = 1 / fr;
    p0 = p1; p1 = p2; q0 = q1; q1 = q2;
  }
  return out;
}

/* ----------------------------------------- numeric complex linear algebra */
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

/* ------------------------------------------------ eigenvalues / vectors */
// numeric approximation of an Expr that may be complex
function approxOf(e) {
  const parts = e.splitImag();
  if (!parts) return null;
  const re = parts[0].evalNum({}), im = parts[1].evalNum({});
  if (re === null || im === null) return null;
  return C.of(re, im);
}
function exactEntry(value, algMult, A, n) {
  const M = sub(A, scaleMat(identity(n), value));
  const ns = nullspace(M);
  return { kind: 'exact', value, approx: approxOf(value), algMult,
    geomMult: ns.basis.length, vectors: ns.basis, assumptions: ns.assumptions };
}
// roots of aλ² + bλ + c, exactly — covers irrational and complex cases
function quadraticRoots(a, b, c) {
  const disc = b.mul(b).sub(E(4).mul(a).mul(c));
  const s = sqrtExpr(disc);
  const two = E(2).mul(a);
  return [b.neg().add(s).div(two), b.neg().sub(s).div(two)];
}
function eigen(A) {
  const [m, n] = dims(A);
  if (m !== n) throw new Error(`Eigenvalues require a square matrix (got ${m}×${n})`);
  const cp = charPoly(A);
  const symbolic = cp.some((c) => c.constVal() === null);
  const evs = [];
  let unsolvedDegree = 0;

  if (!symbolic) {
    let rem = cp.map((c) => c.constVal());
    const exact = [];
    const addExact = (v, k) => { const e = exact.find((x) => x.value.eq(v)); if (e) e.mult += k; else exact.push({ value: v, mult: k }); };
    for (const z of rootsNumeric(rem.map((c) => c.toNumber()))) {   // recognise exact rational roots
      if (rem.length <= 1) break;
      if (Math.abs(z.im) > 1e-3 * (1 + Math.abs(z.re))) continue;
      for (const cand of rationalCandidates(z.re)) {
        if (exact.some((e) => e.value.eq(cand))) break;
        if (!fPolyEval(rem, cand).isZero()) continue;
        let mult = 0;
        while (rem.length > 1 && fPolyEval(rem, cand).isZero()) { rem = fPolyDeflate(rem, cand); mult++; }
        addExact(cand, mult);
        break;
      }
    }
    for (const e of exact) evs.push(exactEntry(Expr.fromFrac(e.value), e.mult, A, n));
    const deg = rem.length - 1;
    if (deg === 1) {
      evs.push(exactEntry(Expr.fromFrac(rem[1].neg().div(rem[0])), 1, A, n));
    } else if (deg === 2) {
      const [r1, r2] = quadraticRoots(Expr.fromFrac(rem[0]), Expr.fromFrac(rem[1]), Expr.fromFrac(rem[2]));
      if (r1.eq(r2)) evs.push(exactEntry(r1, 2, A, n));
      else { evs.push(exactEntry(r1, 1, A, n)); evs.push(exactEntry(r2, 1, A, n)); }
    } else if (deg >= 3) {
      unsolvedDegree = deg;
      const others = [];
      for (const r of rootsNumeric(rem.map((c) => c.toNumber()))) {
        const hit = others.find((o) => C.abs(C.sub(o.approx, r)) < 1e-6 * (1 + C.abs(r)));
        if (hit) hit.mult++; else others.push({ approx: r, mult: 1 });
      }
      for (const o of others) {
        const Mc = A.map((row, i) => row.map((x, j) => {
          const v = x.constVal().toNumber();
          return i === j ? C.sub(C.of(v), o.approx) : C.of(v);
        }));
        const basis = complexNullspace(Mc, o.mult);
        evs.push({ kind: 'numeric', value: null, approx: o.approx, algMult: o.mult, geomMult: basis.length, vectors: basis, assumptions: [] });
      }
    }
  } else {
    // symbolic entries: only degrees 1 and 2 have a usable closed form
    if (n === 1) {
      evs.push(exactEntry(cp[1].neg(), 1, A, n));
    } else if (n === 2) {
      const [r1, r2] = quadraticRoots(cp[0], cp[1], cp[2]);
      if (r1.eq(r2)) evs.push(exactEntry(r1, 2, A, n));
      else { evs.push(exactEntry(r1, 1, A, n)); evs.push(exactEntry(r2, 1, A, n)); }
    } else {
      unsolvedDegree = n;
    }
  }

  evs.sort((x, y) => {
    const ax = x.approx, ay = y.approx;
    if (ax && ay) return (ay.re - ax.re) || (ay.im - ax.im);
    if (ax) return -1;
    if (ay) return 1;
    return 0;
  });
  const geomTotal = evs.reduce((s, e) => s + e.geomMult, 0);
  const assumptions = [];
  for (const e of evs) for (const a of e.assumptions || []) if (!assumptions.some((x) => x.eq(a))) assumptions.push(a);
  return { n, charPoly: cp, eigenvalues: evs, symbolic, unsolvedDegree,
    solved: unsolvedDegree === 0 || !symbolic,
    diagonalizable: unsolvedDegree === 0 && geomTotal === n, geomTotal, assumptions };
}

/* ------------------------------------------------ diagonalization A=PDP⁻¹ */
function diagonalize(A) {
  const e = eigen(A);
  const n = e.n;
  if (!e.diagonalizable) return { ok: false, eigen: e };
  const allExact = e.eigenvalues.every((v) => v.kind === 'exact');
  if (allExact) {
    const cols = [], diag = [];
    for (const v of e.eigenvalues) for (const vec of v.vectors) { cols.push(vec); diag.push(v.value); }
    const P = transpose(cols);
    const D = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? diag[i] : Expr.ZERO)));
    const inv = inverse(P);
    if (inv.singular) return { ok: false, eigen: e, reason: 'eigenvector matrix is singular' };
    const back = mul(mul(P, D), inv.inverse);
    const verified = back.every((r, i) => r.every((x, j) => x.eq(A[i][j])));
    return { ok: true, exact: true, P, D, Pinv: inv.inverse, eigen: e, verified };
  }
  const cols = [], diag = [];
  for (const v of e.eigenvalues) for (const vec of v.vectors) {
    cols.push(v.kind === 'exact' ? vec.map((x) => approxOf(x) || C.of(NaN)) : vec);
    diag.push(v.approx);
  }
  const P = Array.from({ length: n }, (_, i) => cols.map((c) => c[i]));
  const D = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? diag[i] : C.of(0))));
  return { ok: true, exact: false, P, D, Pinv: complexInverse(P), eigen: e };
}

/* ---------------------------------------------------------------- vectors */
function asVector(M) {
  const [r, c] = dims(M);
  if (r === 1) return M[0].slice();
  if (c === 1) return M.map((row) => row[0]);
  throw new Error(`A ${r}×${c} matrix is not a vector — use a 1×n row or an n×1 column`);
}
function dot(u, v) {
  if (u.length !== v.length) throw new Error(`Dot product needs vectors of equal length (got ${u.length} and ${v.length})`);
  let s = Expr.ZERO;
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
function norm(u) { return sqrtExpr(dot(u, u)); }

const api = {
  Expr, E, display, sqrtExpr, Frac, F, C, isqrt, simplifySqrt,
  dims, zeros, identity, clone, transpose, add, sub, mul, scaleMat, trace, parseMatrix, augment,
  isSymbolic, substMatrix, matrixVars,
  rref, det, detCofactor, inverse, nullspace, fourSubspaces, charPoly, rootsNumeric,
  crref, complexNullspace, complexInverse, eigen, diagonalize, approxOf, quadraticRoots,
  asVector, dot, cross, norm,
};
if (isNode) module.exports = api;
else root.MatrixCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
