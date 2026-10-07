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

/* ------------------------------------------------------------ projections */
// Projections use the real dot product, so complex entries are rejected rather
// than silently given a bilinear (non-Hermitian) "inner product".
function assertReal(items, what) {
  for (const x of items) {
    const p = x.splitImag();
    if (!p || !p[1].isZero()) throw new Error(`Projection is defined for real ${what}; this one contains the imaginary unit i`);
  }
}
function addAssumption(list, e) {
  if (e.constVal() === null && !list.some((a) => a.eq(e))) list.push(e);
}

// proj_v(u) = (u·v / v·v) v
function projectOntoVector(u, v) {
  if (u.length !== v.length) throw new Error(`Cannot project a ${u.length}-component vector onto a ${v.length}-component vector (lengths must match)`);
  assertReal(u, 'vectors'); assertReal(v, 'vectors');
  const vv = dot(v, v);
  if (vv.isZero()) throw new Error('Cannot project onto the zero vector — it spans no line');
  const uv = dot(u, v);
  const coef = uv.div(vv);
  const proj = v.map((x) => x.mul(coef));
  const perp = u.map((x, i) => x.sub(proj[i]));
  const assumptions = [];
  addAssumption(assumptions, vv);
  return { u, v, uv, vv, coef, proj, perp, assumptions,
    comp: uv.div(norm(v)),            // signed length of the shadow of u along v
    check: dot(perp, v) };            // 0 when perp ⟂ v
}

// Orthogonal projection of b onto the column space of M (any spanning set — dependent columns are fine).
// x̂ solves the normal equations (BᵀB) x̂ = Bᵀ b for B = an independent subset of the columns.
function projectOntoColumnSpace(M, b) {
  const [m, n] = dims(M);
  if (m !== b.length) throw new Error(`The vector has ${b.length} components but the subspace lives in ℝ${m} (columns of the matrix have ${m} entries)`);
  assertReal(b, 'vectors');
  for (const r of M) assertReal(r, 'matrices');
  const red = rref(M, { steps: true });
  const assumptions = red.assumptions.slice();
  const basisCols = red.pivots;
  const k = basisCols.length;
  const bcol = b.map((x) => [x]);
  if (k === 0) {
    const zero = b.map(() => Expr.ZERO);
    return { m, n, k, pivots: basisCols, basis: [], G: null, Mtb: null, xhat: null, proj: zero, perp: b.slice(),
      P: zeros(m, m), assumptions, inSpace: b.every((x) => x.isZero()), residualCheck: null,
      R: red.R, rrefSteps: red.steps };
  }
  const B = M.map((row) => basisCols.map((c) => row[c]));
  const Bt = transpose(B);
  const G = mul(Bt, B);
  const Mtb = mul(Bt, bcol);
  const inv = inverse(G);
  if (inv.singular) throw new Error('The Gram matrix BᵀB is singular, so this projection cannot be computed exactly (the columns are only generically independent)');
  for (const a of inv.assumptions) addAssumption(assumptions, a);
  const xhat = mul(inv.inverse, Mtb).map((r) => r[0]);
  const BGinv = mul(B, inv.inverse);
  const P = mul(BGinv, Bt);
  const proj = mul(B, xhat.map((x) => [x])).map((r) => r[0]);
  const perp = b.map((x, i) => x.sub(proj[i]));
  const resid = mul(Bt, perp.map((x) => [x])).map((r) => r[0]);   // Bᵀ(b − p) = 0
  return { m, n, k, pivots: basisCols, basis: basisCols.map((c) => M.map((row) => row[c])),
    B, Bt, G, Ginv: inv, BGinv, R: red.R, rrefSteps: red.steps,
    Mtb: Mtb.map((r) => r[0]), xhat, proj, perp, P, assumptions,
    inSpace: perp.every((x) => x.isZero()), residualCheck: resid };
}

// Projection matrix onto the column space of M: P = B (BᵀB)⁻¹ Bᵀ
function projectionMatrix(M) {
  const [m] = dims(M);
  const r = projectOntoColumnSpace(M, Array.from({ length: m }, () => Expr.ZERO));
  const P = r.P;
  const I = identity(m);
  return { P, k: r.k, m, pivots: r.pivots, basis: r.basis, assumptions: r.assumptions,
    R: r.R, rrefSteps: r.rrefSteps, B: r.B, Bt: r.Bt, G: r.G, Ginv: r.Ginv, BGinv: r.BGinv,
    idempotent: mul(P, P).every((row, i) => row.every((x, j) => x.eq(P[i][j]))),
    symmetric: P.every((row, i) => row.every((x, j) => x.eq(P[j][i]))),
    complement: sub(I, P), trace: trace(P) };
}

/* ------------------------------------------------------------------ norms */
const absExpr = (x) => SY.applyFn('abs', x);
// the entry (or sum) with the largest numeric value under env; null if any can't be evaluated
function maxBy(items, env) {
  let best = -1, bestVal = -Infinity;
  for (let i = 0; i < items.length; i++) {
    const v = items[i].evalNum(env);
    if (v === null) return null;
    if (v > bestVal) { bestVal = v; best = i; }
  }
  return best < 0 ? null : { index: best, value: items[best] };
}
// 2-norm, 1-norm and ∞-norm of a vector, plus the unit vector v/‖v‖
function vectorNorms(v, env = {}) {
  assertReal(v, 'vectors');
  const sq = dot(v, v);
  const l2 = sqrtExpr(sq);
  let l1 = Expr.ZERO;
  for (const x of v) l1 = l1.add(absExpr(x));
  const mx = maxBy(v.map(absExpr), env);
  const zero = sq.isZero();
  const assumptions = [];
  addAssumption(assumptions, sq);
  return { n: v.length, sq, l2, l1, linf: mx, zero, assumptions,
    unit: zero ? null : v.map((x) => x.div(l2)) };
}
// Frobenius, 1 (max column sum), ∞ (max row sum) and — for numeric matrices — spectral norm
function matrixNorms(M, env = {}) {
  for (const r of M) assertReal(r, 'matrices');
  const [m, n] = dims(M);
  let sq = Expr.ZERO;
  for (const r of M) for (const x of r) sq = sq.add(x.mul(x));
  const colSums = Array.from({ length: n }, (_, j) => M.reduce((s, r) => s.add(absExpr(r[j])), Expr.ZERO));
  const rowSums = M.map((r) => r.reduce((s, x) => s.add(absExpr(x)), Expr.ZERO));
  const l1 = maxBy(colSums, env), linf = maxBy(rowSums, env);
  let spectral = null;
  if (!isSymbolic(M)) {
    const ev = eigen(mul(transpose(M), M)).eigenvalues;
    const top = ev.reduce((b, e) => (e.approx && (!b || e.approx.re > b.approx.re) ? e : b), null);
    if (top) spectral = { value: top.kind === 'exact' ? sqrtExpr(top.value) : null, approx: Math.sqrt(Math.max(0, top.approx.re)) };
  }
  return { m, n, frobenius: sqrtExpr(sq), frobeniusSq: sq, l1, linf, colSums, rowSums, spectral };
}

/* ------------------------------------------- Gram–Schmidt and QR (exact) */
// Orthogonalise the columns of M left to right:  vⱼ = aⱼ − Σᵢ (aⱼ·vᵢ)/(vᵢ·vᵢ) vᵢ.
// A column that is already in the span of the earlier ones gives vⱼ = 0 and is skipped.
// Q holds vᵢ/‖vᵢ‖ and R = QᵀM, so that M = QR (reduced QR when columns are dependent).
function gramSchmidt(M) {
  const [m, n] = dims(M);
  for (const r of M) assertReal(r, 'matrices');
  const cols = transpose(M);
  const ortho = [], dots = [], used = [], dependent = [], steps = [], assumptions = [];
  cols.forEach((a, j) => {
    let v = a.slice();
    const terms = [];
    ortho.forEach((u, i) => {
      const coef = dot(a, u).div(dots[i]);
      terms.push({ from: used[i], coef, vec: u.map((x) => x.mul(coef)), num: dot(a, u), den: dots[i] });
      v = v.map((x, k) => x.sub(u[k].mul(coef)));
    });
    const zero = v.every((x) => x.isZero());
    steps.push({ col: j, a, terms, v, zero });
    if (zero) { dependent.push(j); return; }
    const vv = dot(v, v);
    ortho.push(v); dots.push(vv); used.push(j);
    addAssumption(assumptions, vv);
  });
  const norms = ortho.map(norm);
  const unit = ortho.map((u, i) => u.map((x) => x.div(norms[i])));
  const r = ortho.length;
  const Q = r ? transpose(unit) : [];
  const R = unit.map((e) => cols.map((a) => dot(e, a)));
  const verified = r === 0 ? M.every((row) => row.every((x) => x.isZero())) : mul(Q, R).every((row, i) => row.every((x, j) => x.eq(M[i][j])));
  const orthonormal = r === 0 ? true : mul(transpose(Q), Q).every((row, i) => row.every((x, j) => x.eq(i === j ? Expr.ONE : Expr.ZERO)));
  return { m, n, rank: r, used, dependent, steps, ortho, dots, norms, unit, Q, R, verified, orthonormal, assumptions };
}

const api = {
  Expr, E, display, sqrtExpr, Frac, F, C, isqrt, simplifySqrt,
  dims, zeros, identity, clone, transpose, add, sub, mul, scaleMat, trace, parseMatrix, augment,
  isSymbolic, substMatrix, matrixVars,
  rref, det, detCofactor, inverse, nullspace, fourSubspaces, charPoly, rootsNumeric,
  crref, complexNullspace, complexInverse, eigen, diagonalize, approxOf, quadraticRoots,
  asVector, dot, cross, norm,
  projectOntoVector, projectOntoColumnSpace, projectionMatrix,
  vectorNorms, matrixNorms, gramSchmidt,
};
if (isNode) module.exports = api;
else root.MatrixCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
