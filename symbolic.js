/* symbolic.js — a small exact computer-algebra layer.
 *
 * An Expr is a ratio of two multivariate polynomials whose coefficients are exact
 * rationals. The "variables" of those polynomials are atoms: symbols (x, theta),
 * the constant pi, the imaginary unit i, and function applications (sin(u), sqrt(u), …).
 *
 * Canonical rewrites keep the representation normal, so `isZero` is an exact,
 * structural test — which is what makes pivoting in RREF/determinant/inverse sound:
 *     i^2       -> -1
 *     sqrt(u)^2 -> u
 *     sin(u)^2  -> 1 - cos(u)^2
 *     sinh(u)^2 -> cosh(u)^2 - 1
 * tan/cot/sec/csc are rewritten to sin and cos on input, so trig identities collapse.
 *
 * Browser: window.Symbolic · Node: module.exports
 */
(function (root) {
'use strict';
const FL = (typeof module !== 'undefined' && module.exports) ? require('./fraction.js') : root.FractionLib;
const { Frac, F, gcd, lcm, isqrt, simplifySqrt } = FL;

/* ------------------------------------------------------------------ atoms */
const ATOMS = new Map();
function defAtom(a) { if (!ATOMS.has(a.key)) ATOMS.set(a.key, a); return ATOMS.get(a.key); }
const atomOf = (key) => ATOMS.get(key);

const IMAG_KEY = 'i';
defAtom({ key: IMAG_KEY, kind: 'imag' });
defAtom({ key: 'pi', kind: 'const', name: 'pi' });

function varAtom(name) { return defAtom({ key: name, kind: 'var', name }); }
function fnAtom(fn, arg) {
  const key = `${fn}(${arg.key()})`;
  const a = defAtom({ key, kind: 'fn', fn, arg });
  if (fn === 'sqrt' && !a.argPoly) a.argPoly = arg.num; // sqrt args are kept polynomial
  return a;
}

/* ------------------------------------------------- polynomials (Map-based)
 * A polynomial is a Map<monoKey, {m, c}> where m is {atomKey: exponent>0}
 * and c is a nonzero Frac. The empty Map is the zero polynomial.
 * Term objects are never mutated in place, so shallow Map copies are safe.
 */
function monoKey(m) {
  const ks = Object.keys(m).sort();
  return ks.map((k) => (m[k] === 1 ? k : `${k}^${m[k]}`)).join('*');
}
const pZero = () => new Map();
const pCopy = (p) => new Map(p);
function pFromFrac(c) { const p = new Map(); if (!c.isZero()) p.set('', { m: {}, c }); return p; }
const pOne = () => pFromFrac(Frac.ONE);
function pFromAtom(key) { const p = new Map(); const m = { [key]: 1 }; p.set(monoKey(m), { m, c: Frac.ONE }); return p; }
function pAddTerm(p, m, c) {
  if (c.isZero()) return;
  const k = monoKey(m);
  const cur = p.get(k);
  if (!cur) { p.set(k, { m, c }); return; }
  const nc = cur.c.add(c);
  if (nc.isZero()) p.delete(k); else p.set(k, { m: cur.m, c: nc });
}
function pAdd(a, b) { const o = pCopy(a); for (const t of b.values()) pAddTerm(o, t.m, t.c); return o; }
function pSub(a, b) { const o = pCopy(a); for (const t of b.values()) pAddTerm(o, t.m, t.c.neg()); return o; }
function pNeg(a) { const o = pZero(); for (const t of a.values()) pAddTerm(o, t.m, t.c.neg()); return o; }
function pScale(a, c) { const o = pZero(); if (c.isZero()) return o; for (const t of a.values()) pAddTerm(o, t.m, t.c.mul(c)); return o; }
function monoMul(a, b) { const o = Object.assign({}, a); for (const k in b) o[k] = (o[k] || 0) + b[k]; return o; }
function pMulRaw(a, b) {
  const o = pZero();
  for (const s of a.values()) for (const t of b.values()) pAddTerm(o, monoMul(s.m, t.m), s.c.mul(t.c));
  return o;
}
function pPowRaw(a, n) { let r = pOne(); for (let k = 0; k < n; k++) r = pMulRaw(r, a); return r; }
const pMul = (a, b) => pNormalize(pMulRaw(a, b));
const pIsZero = (p) => p.size === 0;
const pIsConst = (p) => p.size === 0 || (p.size === 1 && p.has(''));
function pConstVal(p) { if (p.size === 0) return Frac.ZERO; return p.has('') && p.size === 1 ? p.get('').c : null; }
function pAtoms(p) { const s = new Set(); for (const t of p.values()) for (const k in t.m) s.add(k); return s; }
const pDegree = (t) => { let d = 0; for (const k in t.m) d += t.m[k]; return d; };
const hasImag = (t) => (t.m[IMAG_KEY] || 0) > 0;
function pEq(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, t] of a) { const u = b.get(k); if (!u || !u.c.eq(t.c)) return false; }
  return true;
}
// graded lexicographic order — a genuine monomial order, so polynomial division
// and square-root extraction terminate and behave
function cmpMono(a, b) {
  const da = Object.keys(a).reduce((s, k) => s + a[k], 0);
  const db = Object.keys(b).reduce((s, k) => s + b[k], 0);
  if (da !== db) return da < db ? -1 : 1;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const k of keys) {
    const ea = a[k] || 0, eb = b[k] || 0;
    if (ea !== eb) return ea > eb ? 1 : -1;
  }
  return 0;
}
function leadTerm(p) {
  let best = null;
  for (const t of p.values()) if (best === null || cmpMono(t.m, best.m) > 0) best = t;
  return best;
}
// the term printed first, which also fixes the sign of a ratio
const displayCmp = (a, b) => (hasImag(a) ? 1 : 0) - (hasImag(b) ? 1 : 0) || -cmpMono(a.m, b.m);
function signLeadTerm(p) {
  let best = null;
  for (const t of p.values()) if (best === null || displayCmp(t, best) < 0) best = t;
  return best;
}
// √(p) when p is a perfect square polynomial, else null
function polySqrt(p) {
  if (p.size === 0) return pZero();
  const lt = leadTerm(p);
  const c0 = Frac.sqrtExact(lt.c);
  if (!c0) return null;
  const qm = {};
  for (const k in lt.m) { if (lt.m[k] % 2) return null; qm[k] = lt.m[k] / 2; }
  const q = pZero();
  pAddTerm(q, qm, c0);
  let prev = null;
  const twoC = c0.mul(F(2));
  for (let guard = 0; guard < 60; guard++) {
    const rem = pNormalize(pSub(p, pMulRaw(q, q)));
    if (rem.size === 0) return q;
    const rt = leadTerm(rem);
    if (prev && cmpMono(rt.m, prev) >= 0) return null;   // must strictly decrease
    prev = rt.m;
    const nm = Object.assign({}, rt.m);
    for (const k in qm) { const e = (nm[k] || 0) - qm[k]; if (e < 0) return null; if (e === 0) delete nm[k]; else nm[k] = e; }
    pAddTerm(q, nm, rt.c.div(twoC));
  }
  return null;
}
// recognise ±(1 − cos(u)²), which is ±sin(u)²
function sinSquarePattern(p) {
  if (p.size !== 2) return null;
  let ct = null, st = null;
  for (const [k, t] of p) { if (k === '') ct = t; else st = t; }
  if (!ct || !st) return null;
  const ks = Object.keys(st.m);
  if (ks.length !== 1 || st.m[ks[0]] !== 2) return null;
  const a = atomOf(ks[0]);
  if (!a || a.kind !== 'fn' || a.fn !== 'cos') return null;
  const negOne = Frac.ONE.neg();
  if (ct.c.isOne() && st.c.eq(negOne)) return { arg: a.arg, imag: false };
  if (ct.c.eq(negOne) && st.c.isOne()) return { arg: a.arg, imag: true };
  return null;
}

/* ---------------------------------------------------- canonical rewrites */
function rewriteFor(key, e) {
  if (e < 2) return null;
  const a = atomOf(key);
  if (!a) return null;
  if (a.kind === 'imag') return { keep: e & 1, coef: (e >> 1) % 2 === 0 ? Frac.ONE : Frac.ONE.neg() };
  if (a.kind !== 'fn') return null;
  const q = e >> 1, keep = e & 1;
  if (a.fn === 'sqrt') return { keep, factor: pPowRaw(a.argPoly, q) };
  if (a.fn === 'sin') {   // sin^2 = 1 - cos^2
    const cosKey = fnAtom('cos', a.arg).key;
    return { keep, factor: pPowRaw(pSub(pOne(), pPowRaw(pFromAtom(cosKey), 2)), q) };
  }
  if (a.fn === 'sinh') {  // sinh^2 = cosh^2 - 1
    const coshKey = fnAtom('cosh', a.arg).key;
    return { keep, factor: pPowRaw(pSub(pPowRaw(pFromAtom(coshKey), 2), pOne()), q) };
  }
  return null;
}
function needsRewrite(p) {
  for (const t of p.values()) for (const k in t.m) if (t.m[k] >= 2 && rewriteFor(k, t.m[k])) return true;
  return false;
}
function pNormalize(p) {
  if (!needsRewrite(p)) return p;
  let cur = p;
  for (let guard = 0; guard < 64; guard++) {
    let changed = false;
    const out = pZero();
    for (const t of cur.values()) {
      let done = false;
      for (const k in t.m) {
        const r = rewriteFor(k, t.m[k]);
        if (!r) continue;
        const nm = Object.assign({}, t.m);
        if (r.keep === 0) delete nm[k]; else nm[k] = r.keep;
        const base = pZero();
        pAddTerm(base, nm, r.coef ? t.c.mul(r.coef) : t.c);
        const piece = r.factor ? pMulRaw(base, r.factor) : base;
        for (const u of piece.values()) pAddTerm(out, u.m, u.c);
        done = true; changed = true;
        break;
      }
      if (!done) pAddTerm(out, t.m, t.c);
    }
    cur = out;
    if (!changed) break;
  }
  return cur;
}

/* ------------------------------------------------------- simplification */
function pContent(p) {  // positive Frac c with p/c having coprime integer coefficients
  if (p.size === 0) return Frac.ONE;
  let g = 0n, l = 1n;
  for (const t of p.values()) { g = gcd(g, t.c.n < 0n ? -t.c.n : t.c.n); l = lcm(l, t.c.d); }
  if (g === 0n) return Frac.ONE;
  return new Frac(g, l);
}
function commonMono(p) {
  let g = null;
  for (const t of p.values()) {
    if (g === null) { g = Object.assign({}, t.m); continue; }
    for (const k in g) { const e = t.m[k] || 0; if (e === 0) delete g[k]; else g[k] = Math.min(g[k], e); }
    if (Object.keys(g).length === 0) break;
  }
  return g || {};
}
function pDivMono(p, m) {
  const o = pZero();
  for (const t of p.values()) {
    const nm = Object.assign({}, t.m);
    for (const k in m) { const e = (nm[k] || 0) - m[k]; if (e <= 0) delete nm[k]; else nm[k] = e; }
    pAddTerm(o, nm, t.c);
  }
  return o;
}
// Candidate exact quotient a/b, verified by multiplying back — sound even
// though the rewrite rules make the ring a quotient ring.
function pDivExact(a, b) {
  if (b.size === 0) return null;
  if (a.size === 0) return pZero();
  const lb = leadTerm(b);
  let rem = pCopy(a);
  const q = pZero();
  for (let guard = 0; rem.size && guard < 4000; guard++) {
    const lt = leadTerm(rem);
    const nm = Object.assign({}, lt.m);
    let ok = true;
    for (const k in lb.m) { const e = (nm[k] || 0) - lb.m[k]; if (e < 0) { ok = false; break; } if (e === 0) delete nm[k]; else nm[k] = e; }
    if (!ok) return null;
    const c = lt.c.div(lb.c);
    const step = pZero(); pAddTerm(step, nm, c);
    pAddTerm(q, nm, c);
    rem = pSub(rem, pMulRaw(step, b));
  }
  if (rem.size) return null;
  return pEq(pNormalize(pMulRaw(q, b)), a) ? q : null;   // verify
}
// Euclidean gcd when both polynomials involve at most one atom
function uniOf(p, key) {
  const c = [];
  for (const t of p.values()) {
    const ks = Object.keys(t.m);
    if (ks.length > 1 || (ks.length === 1 && ks[0] !== key)) return null;
    const d = ks.length ? t.m[key] : 0;
    while (c.length <= d) c.push(Frac.ZERO);
    c[d] = t.c;
  }
  return c.length ? c : [Frac.ZERO];
}
function uniFromCoefs(c, key) {
  const p = pZero();
  c.forEach((co, d) => { if (!co.isZero()) pAddTerm(p, d === 0 ? {} : { [key]: d }, co); });
  return p;
}
function uniGcd(a, b) {
  const deg = (v) => { let d = v.length - 1; while (d >= 0 && v[d].isZero()) d--; return d; };
  let x = a.slice(), y = b.slice();
  for (let guard = 0; guard < 200; guard++) {
    const dy = deg(y);
    if (dy < 0) break;
    const dx = deg(x);
    if (dx < 0) { [x, y] = [y, x]; continue; }
    if (dx < dy) { [x, y] = [y, x]; continue; }
    const r = x.slice();
    const f = r[dx].div(y[dy]);
    for (let k = 0; k <= dy; k++) r[dx - dy + k] = r[dx - dy + k].sub(f.mul(y[k]));
    r[dx] = Frac.ZERO;
    x = y; y = r;
  }
  const dx = deg(x);
  if (dx < 0) return null;
  const lead = x[dx];
  return x.slice(0, dx + 1).map((c) => c.div(lead));
}
function reduceRatio(num, den) {
  if (den.size === 0) throw new Error('Division by zero');
  if (num.size === 0) return [pZero(), pOne()];
  const r = pContent(num).div(pContent(den));
  let n = pScale(num, Frac.ONE.div(pContent(num)));
  let d = pScale(den, Frac.ONE.div(pContent(den)));
  const g = commonMono(d);
  const gn = commonMono(n);
  const both = {};
  for (const k in g) if (gn[k]) both[k] = Math.min(g[k], gn[k]);
  if (Object.keys(both).length) { n = pDivMono(n, both); d = pDivMono(d, both); }
  if (signLeadTerm(d).c.sign() < 0) { n = pNeg(n); d = pNeg(d); }
  if (!pIsConst(d)) {
    let q = pDivExact(n, d);
    if (q) { n = q; d = pOne(); }
    else {
      q = pDivExact(d, n);
      if (q) { d = q; n = pOne(); }
      else {
        const at = new Set([...pAtoms(n), ...pAtoms(d)]);
        if (at.size === 1) {
          const key = [...at][0];
          const un = uniOf(n, key), ud = uniOf(d, key);
          if (un && ud) {
            const g2 = uniGcd(un, ud);
            if (g2 && g2.length > 1) {
              const gp = uniFromCoefs(g2, key);
              const qn = pDivExact(n, gp), qd = pDivExact(d, gp);
              if (qn && qd && !pIsZero(qd)) { n = qn; d = qd; }
            }
          }
        }
      }
    }
  }
  if (signLeadTerm(d).c.sign() < 0) { n = pNeg(n); d = pNeg(d); }   // again: the steps above can flip it
  const dc = pConstVal(d);
  if (dc !== null) { n = pScale(n, Frac.ONE.div(dc)); d = pOne(); }
  n = pScale(n, r);
  return [n, d];
}

/* ------------------------------------------------------------------ Expr */
class Expr {
  constructor(num, den) { this.num = num; this.den = den; }

  static fromFrac(c) { return new Expr(pFromFrac(c), pOne()); }
  static fromInt(n) { return Expr.fromFrac(F(n)); }
  static symbol(name) { return new Expr(pFromAtom(varAtom(canonicalName(name)).key), pOne()); }
  static parse(s) { return parseExpr(s); }

  isZero() { return this.num.size === 0; }
  isOne() { const c = this.constVal(); return c !== null && c.isOne(); }
  isConst() { return pIsConst(this.num) && pIsConst(this.den); }
  constVal() {
    const a = pConstVal(this.num), b = pConstVal(this.den);
    return a !== null && b !== null && !b.isZero() ? a.div(b) : null;
  }
  isInteger() { const c = this.constVal(); return c !== null && c.isInteger(); }
  sign() { const c = this.constVal(); return c === null ? null : c.sign(); }

  add(o) { return mkExpr(pAdd(pMulRaw(this.num, o.den), pMulRaw(o.num, this.den)), pMulRaw(this.den, o.den)); }
  sub(o) { return mkExpr(pSub(pMulRaw(this.num, o.den), pMulRaw(o.num, this.den)), pMulRaw(this.den, o.den)); }
  mul(o) { return mkExpr(pMulRaw(this.num, o.num), pMulRaw(this.den, o.den)); }
  div(o) { if (o.isZero()) throw new Error('Division by zero'); return mkExpr(pMulRaw(this.num, o.den), pMulRaw(this.den, o.num)); }
  neg() { return new Expr(pNeg(this.num), this.den); }
  inv() { if (this.isZero()) throw new Error('Division by zero'); return mkExpr(this.den, this.num); }
  pow(k) {
    if (!Number.isInteger(k)) throw new Error('Only integer powers are supported here');
    if (k === 0) return Expr.ONE;
    const e = Math.abs(k);
    const p = mkExpr(pPowRaw(this.num, e), pPowRaw(this.den, e));
    return k > 0 ? p : p.inv();
  }
  eq(o) { return this.sub(o).isZero(); }

  atoms() { const s = pAtoms(this.num); for (const k of pAtoms(this.den)) s.add(k); return s; }
  // free variable names appearing anywhere, including inside function arguments
  vars() {
    const out = new Set();
    const walk = (keys) => {
      for (const k of keys) {
        const a = atomOf(k);
        if (!a) continue;
        if (a.kind === 'var') out.add(a.name);
        else if (a.kind === 'fn') walk(a.arg.atoms());
      }
    };
    walk(this.atoms());
    return out;
  }
  leadingSign() { const lt = leadTerm(this.num); return lt ? lt.c.sign() : 0; }

  // canonical, option-independent string — also the identity used for atom keys
  key() { return `${polyKey(this.num)}${pIsConst(this.den) && pConstVal(this.den) !== null && pConstVal(this.den).isOne() ? '' : '/' + polyKey(this.den)}`; }
  toString() { return display(this, { mode: 'frac' }); }

  // split a + b·i  ->  [a, b]; null when i survives in the denominator
  splitImag() {
    if (pAtoms(this.den).has(IMAG_KEY)) return null;
    const re = pZero(), im = pZero();
    for (const t of this.num.values()) {
      const e = t.m[IMAG_KEY] || 0;
      if (e === 0) pAddTerm(re, t.m, t.c);
      else if (e === 1) { const nm = Object.assign({}, t.m); delete nm[IMAG_KEY]; pAddTerm(im, nm, t.c); }
      else return null;
    }
    return [mkExpr(re, this.den), mkExpr(im, this.den)];
  }

  subst(env) {
    const sub = (p) => {
      let acc = Expr.ZERO;
      for (const t of p.values()) {
        let term = Expr.fromFrac(t.c);
        for (const k in t.m) {
          const a = atomOf(k);
          let base;
          if (!a) base = new Expr(pFromAtom(k), pOne());
          else if (a.kind === 'var' && env[a.name] !== undefined) base = env[a.name];
          else if (a.kind === 'fn') base = applyFn(a.fn, a.arg.subst(env));
          else base = new Expr(pFromAtom(k), pOne());
          term = term.mul(base.pow(t.m[k]));
        }
        acc = acc.add(term);
      }
      return acc;
    };
    return sub(this.num).div(sub(this.den));
  }

  // numeric value, or null when something cannot be evaluated (unbound symbol, i, …)
  evalNum(env = {}) {
    const ev = (p) => {
      let sum = 0;
      for (const t of p.values()) {
        let v = t.c.toNumber();
        for (const k in t.m) {
          const av = atomNum(k, env);
          if (av === null) return null;
          v *= Math.pow(av, t.m[k]);
        }
        sum += v;
      }
      return sum;
    };
    const a = ev(this.num); if (a === null) return null;
    const b = ev(this.den); if (b === null || b === 0) return null;
    return a / b;
  }
}
function polyKey(p) {
  return [...p.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([k, t]) => `${t.c}${k ? '*' + k : ''}`).join('+') || '0';
}
function mkExpr(num, den) {
  num = pNormalize(num); den = pNormalize(den);
  if (den.size === 0) throw new Error('Division by zero');
  if (num.size === 0) return Expr.ZERO;
  // rationalise denominators holding i or a square root: multiply by the conjugate
  for (let guard = 0; guard < 6; guard++) {
    const key = [...pAtoms(den)].find((k) => {
      const a = atomOf(k);
      return a && (a.kind === 'imag' || (a.kind === 'fn' && a.fn === 'sqrt'));
    });
    if (!key) break;
    const conj = pZero();
    for (const t of den.values()) pAddTerm(conj, t.m, (t.m[key] || 0) % 2 === 1 ? t.c.neg() : t.c);
    const nd = pNormalize(pMulRaw(den, conj));
    // the rewrite rules make this a quotient ring, which has zero divisors
    // (e.g. √(u²) − u): a vanishing product means the conjugate is useless here
    if (nd.size === 0) break;
    if (pAtoms(nd).has(key)) break;            // no progress — leave it alone
    num = pNormalize(pMulRaw(num, conj));
    den = nd;
  }
  const [n, d] = reduceRatio(num, den);
  return new Expr(n, d);
}
Expr.ZERO = new Expr(pZero(), pOne());
Expr.ONE = new Expr(pOne(), pOne());
const E = (n) => Expr.fromInt(n);

function atomNum(key, env) {
  const a = atomOf(key);
  if (!a) return null;
  if (a.kind === 'var') { const v = env[a.name]; return v === undefined ? null : v; }
  if (a.kind === 'const') return a.name === 'pi' ? Math.PI : null;
  if (a.kind === 'imag') return null;
  const x = a.arg.evalNum(env);
  if (x === null) return null;
  const fns = {
    sin: Math.sin, cos: Math.cos, sqrt: (v) => (v < 0 ? NaN : Math.sqrt(v)), exp: Math.exp,
    ln: (v) => (v <= 0 ? NaN : Math.log(v)), asin: Math.asin, acos: Math.acos, atan: Math.atan,
    sinh: Math.sinh, cosh: Math.cosh, abs: Math.abs,
  };
  const f = fns[a.fn];
  if (!f) return null;
  const y = f(x);
  return Number.isFinite(y) ? y : null;
}

/* ------------------------------------------------------- function builders */
function sqrtExpr(u) {
  const c = u.constVal();
  if (c !== null) {
    if (c.isZero()) return Expr.ZERO;
    const neg = c.sign() < 0;
    const a = c.abs();
    const ex = Frac.sqrtExact(a);
    let mag;
    if (ex) mag = Expr.fromFrac(ex);
    else {
      const { k, m } = simplifySqrt(a.n * a.d);   // √(n/d) = √(n·d)/d
      mag = Expr.fromFrac(new Frac(k, a.d)).mul(new Expr(pFromAtom(fnAtom('sqrt', E(Number(m))).key), pOne()));
    }
    return neg ? mag.mul(imagUnit()) : mag;
  }
  // √(n/d) = √(n·d)/d
  let inner = u, scale = Expr.ONE;
  if (!(pIsConst(u.den) && pConstVal(u.den) !== null && pConstVal(u.den).isOne())) {
    inner = new Expr(pNormalize(pMulRaw(u.num, u.den)), pOne());
    scale = new Expr(pOne(), u.den);
  }
  // pull out square factors of the numeric content and of the common monomial
  let p = inner.num;
  const cont = pContent(p);
  p = pScale(p, Frac.ONE.div(cont));
  const cm = commonMono(p);
  const sq = {}, rest = {};
  for (const k in cm) { const e = cm[k]; if (e >= 2) { sq[k] = e >> 1; if (e & 1) rest[k] = 1; } else rest[k] = e; }
  if (Object.keys(sq).length) p = pDivMono(p, (() => { const t = {}; for (const k in sq) t[k] = sq[k] * 2; return t; })());
  let out = new Expr(pOne(), pOne());
  for (const k in sq) out = out.mul(new Expr(pFromAtom(k), pOne()).pow(sq[k]));
  const ex = Frac.sqrtExact(cont);
  if (ex) out = out.mul(Expr.fromFrac(ex));
  else out = out.mul(sqrtExpr(Expr.fromFrac(cont)));
  // √(q²) = q and √(1 − cos(u)²) = sin(u), taking the principal root
  const ps = polySqrt(p);
  if (ps) return out.mul(new Expr(ps, pOne())).mul(scale);
  const sp = sinSquarePattern(p);
  if (sp) {
    const s = sinExpr(sp.arg);
    return out.mul(sp.imag ? s.mul(imagUnit()) : s).mul(scale);
  }
  if (leadTerm(p) && leadTerm(p).c.sign() < 0) { p = pNeg(p); out = out.mul(imagUnit()); }
  const arg = new Expr(p, pOne());
  if (arg.isOne()) return out.mul(scale);
  return out.mul(new Expr(pFromAtom(fnAtom('sqrt', arg).key), pOne())).mul(scale);
}
const imagUnit = () => new Expr(pFromAtom(IMAG_KEY), pOne());

// c such that u = c·π, else null
function piMultiple(u) {
  if (u.isZero()) return Frac.ZERO;
  const d = pConstVal(u.den);
  if (d === null || d.isZero()) return null;
  if (u.num.size !== 1) return null;
  const t = [...u.num.values()][0];
  const ks = Object.keys(t.m);
  if (ks.length !== 1 || ks[0] !== 'pi' || t.m.pi !== 1) return null;
  return t.c.div(d);
}
const TWELFTH_SIN = {   // sin(k·π/12) for the exactly-representable angles
  0: () => Expr.ZERO,
  2: () => Expr.fromFrac(new Frac(1n, 2n)),
  3: () => sqrtExpr(E(2)).div(E(2)),
  4: () => sqrtExpr(E(3)).div(E(2)),
  6: () => Expr.ONE,
  8: () => sqrtExpr(E(3)).div(E(2)),
  9: () => sqrtExpr(E(2)).div(E(2)),
  10: () => Expr.fromFrac(new Frac(1n, 2n)),
  12: () => Expr.ZERO,
};
function trigSpecial(kind, u) {
  const c = piMultiple(u);
  if (c === null) return null;
  let k = c.mul(F(12));
  if (!k.isInteger()) return null;
  let kk = Number(k.n % 24n); if (kk < 0) kk += 24;
  if (kind === 'cos') kk = (kk + 6) % 24;      // cos(x) = sin(x + π/2)
  const base = kk <= 12 ? kk : 24 - kk;
  const f = TWELFTH_SIN[base];
  if (!f) return null;
  const v = f();
  return kk <= 12 ? v : v.neg();
}
function sinExpr(u) {
  const s = trigSpecial('sin', u);
  if (s) return s;
  if (u.leadingSign() < 0) return sinExpr(u.neg()).neg();   // sin(-u) = -sin(u)
  return new Expr(pFromAtom(fnAtom('sin', u).key), pOne());
}
function cosExpr(u) {
  const s = trigSpecial('cos', u);
  if (s) return s;
  if (u.leadingSign() < 0) return cosExpr(u.neg());         // cos(-u) = cos(u)
  return new Expr(pFromAtom(fnAtom('cos', u).key), pOne());
}
function opaqueFn(fn, u) { return new Expr(pFromAtom(fnAtom(fn, u).key), pOne()); }
function applyFn(fn, u) {
  switch (fn) {
    case 'sqrt': return sqrtExpr(u);
    case 'sin': return sinExpr(u);
    case 'cos': return cosExpr(u);
    case 'tan': return sinExpr(u).div(cosExpr(u));
    case 'cot': return cosExpr(u).div(sinExpr(u));
    case 'sec': return Expr.ONE.div(cosExpr(u));
    case 'csc': return Expr.ONE.div(sinExpr(u));
    case 'sinh': return u.isZero() ? Expr.ZERO : opaqueFn('sinh', u);
    case 'cosh': return u.isZero() ? Expr.ONE : opaqueFn('cosh', u);
    case 'tanh': return applyFn('sinh', u).div(applyFn('cosh', u));
    case 'exp': return u.isZero() ? Expr.ONE : opaqueFn('exp', u);
    case 'ln': case 'log': return u.isOne() ? Expr.ZERO : opaqueFn('ln', u);
    case 'abs': {
      const c = u.constVal();
      return c !== null ? Expr.fromFrac(c.abs()) : opaqueFn('abs', u);
    }
    case 'asin': case 'arcsin': return u.isZero() ? Expr.ZERO : opaqueFn('asin', u);
    case 'acos': case 'arccos': return opaqueFn('acos', u);
    case 'atan': case 'arctan': return u.isZero() ? Expr.ZERO : opaqueFn('atan', u);
    default: throw new Error(`Unknown function "${fn}"`);
  }
}
const FUNCTIONS = ['sqrt', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh',
  'exp', 'ln', 'log', 'abs', 'asin', 'acos', 'atan', 'arcsin', 'arccos', 'arctan'];

/* ------------------------------------------------------- names and Greek */
const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', rho: 'ρ', sigma: 'σ', tau: 'τ',
  upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};
const GREEK_TO_NAME = Object.fromEntries(Object.entries(GREEK).map(([k, v]) => [v, k]));
function canonicalName(raw) {
  let s = String(raw);
  let out = '';
  for (const ch of s) out += (GREEK_TO_NAME[ch] || ch);
  return out;
}
const displayName = (name) => GREEK[name] || name;

/* ------------------------------------------------------------- the parser */
function tokenize(src) {
  const s = String(src).replace(/[−–—]/g, '-').replace(/[×⋅·]/g, '*').replace(/÷/g, '/');
  const out = [];
  let i = 0;
  const isDigit = (c) => c >= '0' && c <= '9';
  const isAlpha = (c) => /[A-Za-z_Ͱ-Ͽ]/.test(c);
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (isDigit(c) || (c === '.' && isDigit(s[i + 1]))) {
      let j = i;
      while (j < s.length && (isDigit(s[j]) || s[j] === '.')) j++;
      if ((s[j] === 'e' || s[j] === 'E')) {   // only an exponent when digits follow
        let k = j + 1;
        if (s[k] === '+' || s[k] === '-') k++;
        if (isDigit(s[k])) { while (k < s.length && isDigit(s[k])) k++; j = k; }
      }
      out.push({ t: 'num', v: s.slice(i, j) });
      i = j; continue;
    }
    if (isAlpha(c)) {
      let j = i;
      while (j < s.length && (isAlpha(s[j]) || isDigit(s[j]))) j++;
      out.push({ t: 'id', v: s.slice(i, j) });
      i = j; continue;
    }
    if ('+-*/^(),'.includes(c)) { out.push({ t: c }); i++; continue; }
    throw new Error(`Unexpected character "${c}"`);
  }
  return out;
}
function parseExpr(src) {
  const raw = String(src == null ? '' : src).trim();
  if (raw === '') return Expr.ZERO;
  const ts = tokenize(raw);
  let p = 0;
  const peek = () => ts[p];
  const eat = (t) => { if (ts[p] && ts[p].t === t) { p++; return true; } return false; };
  const expect = (t) => { if (!eat(t)) throw new Error(`Expected "${t}" in "${raw}"`); };

  function parseSum() {
    let v = parseProduct();
    for (;;) {
      if (eat('+')) v = v.add(parseProduct());
      else if (eat('-')) v = v.sub(parseProduct());
      else return v;
    }
  }
  function startsFactor() {
    const t = peek();
    return !!t && (t.t === 'num' || t.t === 'id' || t.t === '(');
  }
  function parseProduct() {
    let v = parseUnary();
    for (;;) {
      if (eat('*')) v = v.mul(parseUnary());
      else if (eat('/')) v = v.div(parseUnary());
      else if (startsFactor()) v = v.mul(parseUnary());   // implicit: 2x, 3sin(t), (x+1)(x-1)
      else return v;
    }
  }
  function parseUnary() {
    if (eat('-')) return parseUnary().neg();
    if (eat('+')) return parseUnary();
    return parsePower();
  }
  function parsePower() {
    const base = parseAtom();
    if (!eat('^')) return base;
    const ex = parseUnary();
    const c = ex.constVal();
    if (c === null) throw new Error('Exponents must be constant numbers');
    if (c.isInteger()) return base.pow(Number(c.n));
    if (c.d === 2n) return sqrtExpr(base).pow(Number(c.n));   // x^(3/2) = √x³
    throw new Error(`Unsupported exponent "${c}" — use integers or halves`);
  }
  function parseAtom() {
    const t = peek();
    if (!t) throw new Error(`Unexpected end of "${raw}"`);
    if (eat('(')) { const v = parseSum(); expect(')'); return v; }
    if (t.t === 'num') { p++; return Expr.fromFrac(Frac.parse(t.v)); }
    if (t.t === 'id') {
      p++;
      const name = canonicalName(t.v);
      if (peek() && peek().t === '(') {
        const fn = name.toLowerCase();
        if (!FUNCTIONS.includes(fn)) throw new Error(`Unknown function "${t.v}"`);
        eat('(');
        const arg = parseSum();
        expect(')');
        return applyFn(fn, arg);
      }
      if (name === 'pi') return new Expr(pFromAtom('pi'), pOne());
      if (name === 'i') return imagUnit();
      if (FUNCTIONS.includes(name.toLowerCase()) && name.toLowerCase() !== 'e')
        throw new Error(`"${t.v}" is a function — write ${t.v}(…)`);
      return Expr.symbol(name);
    }
    throw new Error(`Unexpected "${t.t === 'num' || t.t === 'id' ? t.v : t.t}" in "${raw}"`);
  }
  const v = parseSum();
  if (p !== ts.length) throw new Error(`Unexpected "${ts[p].v || ts[p].t}" in "${raw}"`);
  return v;
}

/* ------------------------------------------------------------- rendering */
const SUP = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻' };
const sup = (n) => String(n).split('').map((c) => SUP[c] || c).join('');
const mnus = (s) => s.replace(/-/g, '−');
function fmtFracVal(c, opts) {
  if (opts.ascii) {
    if (opts.mode === 'dec') { const x = c.toNumber(); return Number.isInteger(x) ? String(x) : String(x); }
    return c.toString();
  }
  if (opts.mode === 'dec') {
    let x = c.toNumber();
    const p = opts.precision === undefined ? 4 : opts.precision;
    if (Math.abs(x) < 0.5 * 10 ** -p) x = 0;
    let s = Number.isInteger(x) ? String(x) : x.toFixed(p).replace(/0+$/, '').replace(/\.$/, '');
    if (s === '-0') s = '0';
    return mnus(s);
  }
  return mnus(c.toString());
}
function atomDisplay(key, opts) {
  const a = atomOf(key);
  if (!a) return key;
  if (a.kind === 'var') return opts.ascii ? a.name : displayName(a.name);
  if (a.kind === 'const') return a.name === 'pi' ? (opts.ascii ? 'pi' : 'π') : a.name;
  if (a.kind === 'imag') return 'i';
  if (opts.ascii) return `${a.fn}(${display(a.arg, opts)})`;
  if (a.fn === 'sqrt') {
    const inner = display(a.arg, opts);
    return /^[0-9A-Za-zͰ-Ͽ]+$/.test(inner) ? `√${inner}` : `√(${inner})`;
  }
  return `${a.fn}(${display(a.arg, opts)})`;
}
function termDisplay(t, opts) {
  const keys = Object.keys(t.m).sort((x, y) => {
    const ax = atomOf(x), ay = atomOf(y);
    const rank = (a) => (!a ? 3 : a.kind === 'var' ? 0 : a.kind === 'const' ? 1 : a.kind === 'imag' ? 2 : 4);
    return rank(ax) - rank(ay) || (x < y ? -1 : x > y ? 1 : 0);
  });
  // function calls need an explicit separator; radicals and symbols read better juxtaposed
  const needsDot = opts.ascii || keys.some((k) => { const a = atomOf(k); return a && a.kind === 'fn' && a.fn !== 'sqrt'; });
  const sep = opts.ascii ? '*' : '·';
  const parts = keys.map((k) => atomDisplay(k, opts) + (t.m[k] === 1 ? '' : (opts.ascii ? `^${t.m[k]}` : sup(t.m[k]))));
  const body = parts.join(needsDot ? sep : '');
  const mag = t.c.abs();
  if (!keys.length) return fmtFracVal(mag, opts);
  if (mag.isOne()) return body;
  const cs = fmtFracVal(mag, opts);
  const wrap = cs.includes('/') ? `(${cs})` : cs;   // (1/2)√2, not 1/2√2
  return wrap + (needsDot ? sep : '') + body;
}
function polyDisplay(p, opts) {
  if (p.size === 0) return '0';
  // real part first, then by descending degree — so complex values read as a + bi
  const terms = [...p.values()].sort(displayCmp);
  let out = '';
  terms.forEach((t, i) => {
    const neg = t.c.sign() < 0;
    const mi = opts.ascii ? '-' : '−';
    out += i === 0 ? (neg ? mi : '') : (neg ? ` ${mi} ` : ' + ');
    out += termDisplay(t, opts);
  });
  return out;
}
// a numerator only needs brackets when it is a sum; a denominator also needs them
// whenever it is a product, so that 1/(2xy) cannot be read as (1/2)xy
function polyNeedsParens(p, isDen) {
  if (p.size > 1) return true;
  if (p.size === 0 || !isDen) return false;
  const t = [...p.values()][0];
  const atoms = Object.keys(t.m).length;
  return atoms > 1 || (atoms >= 1 && !t.c.abs().isOne()) || (atoms === 0 && t.c.sign() < 0);
}
function display(e, opts = {}) {
  const o = { mode: opts.mode || 'frac', precision: opts.precision === undefined ? 4 : opts.precision, ascii: !!opts.ascii };
  const c = e.constVal();
  if (c !== null) return fmtFracVal(c, o);
  // print a bare sin(u)/cos(u) ratio back as tan(u)
  if (e.num.size === 1 && e.den.size === 1) {
    const nt = [...e.num.values()][0], dt = [...e.den.values()][0];
    const nk = Object.keys(nt.m), dk = Object.keys(dt.m);
    if (nk.length === 1 && dk.length === 1 && nt.m[nk[0]] === 1 && dt.m[dk[0]] === 1) {
      const na = atomOf(nk[0]), da = atomOf(dk[0]);
      if (na && da && na.kind === 'fn' && da.kind === 'fn' && na.fn === 'sin' && da.fn === 'cos' && na.arg.key() === da.arg.key()) {
        const coef = nt.c.div(dt.c);
        const t = `tan(${display(na.arg, o)})`;
        return coef.isOne() ? t : coef.neg().isOne() ? '−' + t : `${fmtFracVal(coef, o)}·${t}`;
      }
    }
  }
  const dc = pConstVal(e.den);
  const ns = polyDisplay(e.num, o);
  if (dc !== null && dc.isOne()) return ns;
  const nStr = (o.ascii || polyNeedsParens(e.num, false)) ? `(${ns})` : ns;
  const ds = polyDisplay(e.den, o);
  const dStr = (o.ascii || polyNeedsParens(e.den, true)) ? `(${ds})` : ds;
  return `${nStr}/${dStr}`;
}

/* ---------------------------------------------------------------- LaTeX */
// The same expressions as display(), typeset as LaTeX: stacked fractions, radicals, real exponents.
const TEX_GREEK = { epsilon: 'varepsilon', phi: 'varphi' };
function texName(name) {
  if (GREEK[name]) return '\\' + (TEX_GREEK[name] || name);
  let m = /^([A-Za-z])_?(\d+)$/.exec(name);
  if (m) return m[1] + '_{' + m[2] + '}';
  m = /^([A-Za-z]+)_(\w+)$/.exec(name);
  if (m) return (m[1].length > 1 ? '\\mathit{' + m[1] + '}' : m[1]) + '_{' + m[2] + '}';
  return name.length > 1 ? '\\mathit{' + name + '}' : name;
}
function texNum(c, o) {   // c is a nonnegative Frac
  if (o.mode === 'dec') {
    let x = c.toNumber();
    const pr = o.precision;
    if (Math.abs(x) < 0.5 * 10 ** -pr) x = 0;
    return Number.isInteger(x) ? String(x) : x.toFixed(pr).replace(/0+$/, '').replace(/\.$/, '');
  }
  return c.isInteger() ? String(c.n) : '\\frac{' + c.n + '}{' + c.d + '}';
}
const TEX_FN = { sin: '\\sin', cos: '\\cos', tan: '\\tan', cot: '\\cot', sec: '\\sec', csc: '\\csc',
  sinh: '\\sinh', cosh: '\\cosh', tanh: '\\tanh', ln: '\\ln', asin: '\\arcsin', acos: '\\arccos', atan: '\\arctan' };
function texAtomPow(key, k, o) {
  const a = atomOf(key);
  const pw = k === 1 ? '' : '^{' + k + '}';
  if (!a) return key + pw;
  if (a.kind === 'var') return texName(a.name) + pw;
  if (a.kind === 'const') return (a.name === 'pi' ? '\\pi' : a.name) + pw;
  if (a.kind === 'imag') return 'i' + pw;
  const arg = toTeX(a.arg, o);
  if (TEX_FN[a.fn]) {   // \left( adds a gap after the name, so only use stretchy brackets for tall arguments
    const tall = /\\frac|\\sqrt|\\left|\^\{/.test(arg);
    return TEX_FN[a.fn] + pw + (tall ? '\\left(' + arg + '\\right)' : '(' + arg + ')');
  }
  const base = a.fn === 'sqrt' ? '\\sqrt{' + arg + '}'
    : a.fn === 'abs' ? '\\left|' + arg + '\\right|'
    : a.fn === 'exp' ? 'e^{' + arg + '}'
    : '\\operatorname{' + a.fn + '}\\left(' + arg + '\\right)';
  return k === 1 ? base : '\\left(' + base + '\\right)' + pw;
}
function texTerm(t, o) {   // a term without its sign
  const keys = Object.keys(t.m).sort((x, y) => {
    const ax = atomOf(x), ay = atomOf(y);
    const rank = (a) => (!a ? 3 : a.kind === 'var' ? 0 : a.kind === 'const' ? 1 : a.kind === 'imag' ? 2 : 4);
    return rank(ax) - rank(ay) || (x < y ? -1 : x > y ? 1 : 0);
  });
  const mag = t.c.abs();
  const body = keys.map((k) => texAtomPow(k, t.m[k], o)).join('');
  if (!keys.length) return texNum(mag, o);
  if (mag.isOne()) return body;
  if (o.mode !== 'dec' && !mag.isInteger()) return '\\frac{' + (mag.n === 1n ? '' : String(mag.n)) + body + '}{' + mag.d + '}';
  return texNum(mag, o) + body;
}
function texPoly(p, o) {
  if (p.size === 0) return '0';
  const terms = [...p.values()].sort(displayCmp);
  return terms.map((t, i) => {
    const neg = t.c.sign() < 0;
    return (i === 0 ? (neg ? '-' : '') : (neg ? ' - ' : ' + ')) + texTerm(t, o);
  }).join('');
}
function toTeX(e, opts = {}) {
  const o = { mode: opts.mode || 'frac', precision: opts.precision === undefined ? 4 : opts.precision };
  const c = e.constVal();
  if (c !== null) return (c.sign() < 0 ? '-' : '') + texNum(c.abs(), o);
  if (e.num.size === 1 && e.den.size === 1) {            // sin(u)/cos(u) prints as tan(u)
    const nt = [...e.num.values()][0], dt = [...e.den.values()][0];
    const nk = Object.keys(nt.m), dk = Object.keys(dt.m);
    if (nk.length === 1 && dk.length === 1 && nt.m[nk[0]] === 1 && dt.m[dk[0]] === 1) {
      const na = atomOf(nk[0]), da = atomOf(dk[0]);
      if (na && da && na.kind === 'fn' && da.kind === 'fn' && na.fn === 'sin' && da.fn === 'cos' && na.arg.key() === da.arg.key()) {
        const coef = nt.c.div(dt.c);
        const targ = toTeX(na.arg, o);
        const t = /\\frac|\\sqrt|\\left|\^\{/.test(targ) ? '\\tan\\left(' + targ + '\\right)' : '\\tan(' + targ + ')';
        return coef.isOne() ? t : coef.neg().isOne() ? '-' + t : (coef.sign() < 0 ? '-' : '') + texNum(coef.abs(), o) + t;
      }
    }
  }
  const dc = pConstVal(e.den);
  if (dc !== null && dc.isOne()) return texPoly(e.num, o);
  let neg = '', num = e.num;
  if (num.size === 1 && [...num.values()][0].c.sign() < 0) {   // -a/b, not (-a)/b
    neg = '-';
    num = new Map([...num.entries()].map(([k, t]) => [k, Object.assign({}, t, { c: t.c.neg() })]));
  }
  let den = e.den;
  if (o.mode !== 'dec') {   // clear rational coefficients upward:  (1/2)/(xy) → 1/(2xy)
    const bgcd = (a, b) => { while (b) { [a, b] = [b, a % b]; } return a; };
    let L = 1n;
    for (const t of [...num.values(), ...den.values()]) L = (L / bgcd(L, t.c.d)) * t.c.d;
    if (L !== 1n) { const f = new Frac(L, 1n); num = pScale(num, f); den = pScale(den, f); }
  }
  return neg + '\\frac{' + texPoly(num, o) + '}{' + texPoly(den, o) + '}';
}

/* --------------------------------------------------------------- helpers */
// "x=2, theta=pi/4" -> { x: Expr, theta: Expr }
function parseAssignments(src) {
  const env = {};
  const s = String(src || '').trim();
  if (!s) return env;
  for (const piece of s.split(/[,;\n]+/)) {
    const bit = piece.trim();
    if (!bit) continue;
    const eq = bit.indexOf('=');
    if (eq < 0) throw new Error(`"${bit}" is not an assignment — write it as name = value`);
    const name = canonicalName(bit.slice(0, eq).trim());
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) throw new Error(`"${bit.slice(0, eq).trim()}" is not a valid variable name`);
    env[name] = parseExpr(bit.slice(eq + 1));
  }
  return env;
}
function numericEnv(env) {
  const out = {};
  for (const k in env) { const v = env[k].evalNum({}); if (v !== null) out[k] = v; }
  return out;
}

const toInput = (e) => display(e, { mode: 'frac', ascii: true });
const api = {
  Expr, E, display, toTeX, toInput, parseExpr, parseAssignments, numericEnv,
  sqrtExpr, sinExpr, cosExpr, applyFn, imagUnit,
  canonicalName, displayName, GREEK, FUNCTIONS,
  _internals: { pZero, pOne, pFromFrac, pAdd, pMul, pNormalize, pDivExact, atomOf, ATOMS },
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.Symbolic = api;
})(typeof window !== 'undefined' ? window : globalThis);
