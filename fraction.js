/* fraction.js — exact rational numbers on BigInt, plus integer-root helpers.
   Browser: window.FractionLib · Node: module.exports */
(function (root) {
'use strict';

const babs = (x) => (x < 0n ? -x : x);
function gcd(a, b) { a = babs(a); b = babs(b); while (b) { const t = a % b; a = b; b = t; } return a; }
function lcm(a, b) { a = babs(a); b = babs(b); if (a === 0n || b === 0n) return 0n; return (a / gcd(a, b)) * b; }
function isqrt(n) {
  if (n < 0n) throw new Error('isqrt of a negative number');
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) { const y = (x + n / x) >> 1n; if (y >= x) return x; x = y; }
}
// √N = k·√m with m square-free (trial division up to a bound)
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

class Frac {
  constructor(n, d = 1n) {
    if (typeof n === 'number') n = BigInt(n);
    if (typeof d === 'number') d = BigInt(d);
    if (d === 0n) throw new Error('Division by zero');
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d) || 1n;
    this.n = n / g; this.d = d / g;
  }
  // "3", "-2.5", "1/3", "1e-2" — plain rational literals only (see symbolic.js for expressions)
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
  pow(k) {
    if (k === 0) return Frac.ONE;
    const e = BigInt(Math.abs(k));
    const p = new Frac(this.n ** e, this.d ** e);
    return k > 0 ? p : Frac.ONE.div(p);
  }
  toNumber() { return Number(this.n) / Number(this.d); }
  toString() { return this.d === 1n ? this.n.toString() : `${this.n}/${this.d}`; }
  static sqrtExact(q) {
    if (q.sign() < 0) return null;
    const a = isqrt(q.n), b = isqrt(q.d);
    return (a * a === q.n && b * b === q.d) ? new Frac(a, b) : null;
  }
}
Frac.ZERO = new Frac(0n);
Frac.ONE = new Frac(1n);
const F = (x) => new Frac(BigInt(x));

const api = { Frac, F, gcd, lcm, isqrt, simplifySqrt };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.FractionLib = api;
})(typeof window !== 'undefined' ? window : globalThis);
