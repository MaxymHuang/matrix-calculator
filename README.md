# Matrix Calculator

A dependency-free web matrix calculator for matrices of **any dimension**, with **exact arithmetic** — over rational numbers *and* over symbols. Entries can be numbers (`-3/4`), symbols (`x`, `alpha`, `theta`), or expressions (`sin(theta)`, `sqrt(2)`, `x^2 - 1`), and every operation works the same way on all of them.

Open `index.html` in any browser. No build step, no install, no server.

**Live:** https://maxymhuang.github.io/matrix-calculator/

```
A = [ cos θ  −sin θ ]        det A = 1          λ = cos θ ± i·sin θ
    [ sin θ   cos θ ]        A⁻¹ = Aᵀ           v = (±i, 1)
```

## Features

| Operation | Notes |
|---|---|
| **Matrix multiplication** | `A × B`, `B × A`, plus `A + B`, `A − B`, transpose. Dimension mismatches are reported in plain language. |
| **RREF** | Pivot columns highlighted, rank and free columns reported, every row operation shown step by step. |
| **Eigenvalues & eigenvectors** | Characteristic polynomial via Faddeev–LeVerrier. Rational roots are found exactly; degree‑2 factors are solved in closed form, so irrational and complex eigenvalues come out exact (`(1±√5)/2`, `±i`). Algebraic vs geometric multiplicity reported, defective eigenvalues flagged. |
| **Four fundamental subspaces** | Column space, row space, null space, left null space — bases, dimensions, and the rank–nullity check. |
| **Diagonalization** | `A = P D P⁻¹`, verified exactly. Non-diagonalizable matrices get an explanation of which λ has geometric < algebraic multiplicity. |
| **Gauss–Jordan inverse** | Shows `[A │ I] → [I │ A⁻¹]` with every row operation. Singular matrices identified. |
| **Determinant** | Row reduction (with the triangular form, swap count and diagonal product) for numbers; division-free cofactor expansion for symbolic matrices, so the answer stays a clean polynomial. |
| **Dot & cross product** | Norms, the angle between vectors, orthogonality check, and the parallelogram area. |
| **Projection onto a vector** | `proj_v u = (u·v)/(v·v) · v`, with the coefficient, signed scalar component, orthogonal remainder, and a check that the remainder is ⟂ `v`. |
| **Projection onto a vector space** | Projects a vector onto the column space of a matrix (dependent columns are fine — a pivot basis `B` is extracted). Solves the normal equations `(BᵀB)x̂ = Bᵀb`, shows `p = Bx̂`, the error `e = b − p`, the distance `‖e‖`, and the projection matrix `P = B(BᵀB)⁻¹Bᵀ`. |
| **Projection matrix** | `P` for the column space of a matrix, with `P² = P`, `Pᵀ = P`, rank = trace checks and the complement `I − P`. |

Pick the direction with the **Projection** selector (*A onto B* or *B onto A*): the first matrix is the vector being projected, the second is the vector or matrix it is projected onto. Projections are over real vectors; entries containing `i` are rejected. With symbolic entries the divisor (`v·v`, Gram-matrix pivots) is reported under **Assumes**.

## Symbolic algebra

Expressions are held as a ratio of multivariate polynomials over exact rational coefficients. Canonical rewrites keep that form normal, which makes "is this entry zero?" an exact structural test — and *that* is what makes pivoting in RREF, determinants and inverses trustworthy rather than a floating-point guess.

Identities applied automatically:

```
sin(u)² + cos(u)² = 1        √(u)² = u          i² = −1
cosh(u)² − sinh(u)² = 1      √(q²) = q          √(1 − cos(u)²) = sin(u)
```

`tan`, `cot`, `sec` and `csc` are rewritten to `sin`/`cos` on input (and printed back as `tan` where that is the whole expression), so trigonometric identities collapse on their own:

```
det [ cos θ  −sin θ ]  =  cos²θ + sin²θ  =  1
    [ sin θ   cos θ ]
```

Exact values are known for every multiple of π/6 and π/4, so `sin(pi/3)` becomes `(1/2)√3`.

### What you can type in a cell

| | |
|---|---|
| Numbers | `7`  `-2.5`  `3/4`  `1e-2` |
| Symbols | `x`  `y`  `z`  `a`  `n1` |
| Greek | `alpha` → α, `theta` → θ, `lambda` → λ, … (or paste `α`, `θ` directly) |
| Arithmetic | `x + 2y`  `3*x`  `2x`  `(x+1)(x-1)`  `x/y`  `x^3`  `x^(-1)` |
| Trigonometry | `sin(x)` `cos(x)` `tan(x)` `cot(x)` `sec(x)` `csc(x)` |
| Inverse trig | `asin(x)` `acos(x)` `atan(x)` |
| Hyperbolic | `sinh(x)` `cosh(x)` `tanh(x)` |
| Other | `sqrt(x)` `exp(x)` `ln(x)` `abs(x)` |
| Constants | `pi` (or `π`), `i` (imaginary unit) |

Implicit multiplication works (`2x`, `3sin(t)`, `(x+1)(x-1)`). `i` and `pi` are reserved names.

### Variables and substitution

Type assignments such as `x = 2, theta = pi/4` into the **Variables** box. **Substitute** bakes them into a matrix, and results show a `≈` numeric value wherever one can be computed.

### Honest about the generic case

Elimination has to choose pivots, and a symbolic pivot like `x` is only nonzero for *most* values of `x`. Whenever a non-constant pivot is used, the result carries an explicit note:

> **Assumes:** `x ≠ 0` and `x − 1 ≠ 0` — a pivot was taken to be nonzero, so the result is the generic case.

Two further limits are stated in the UI rather than hidden:

- **Eigenvalues of a symbolic matrix** are only available up to a degree‑2 characteristic polynomial; beyond that no general closed form exists, so the polynomial is shown and you are invited to substitute values.
- `√(q²)` is taken as the **principal root** `q`, the usual convention, rather than `|q|`.

## Input conveniences

- Paste a whole matrix into any cell (rows on separate lines; entries separated by spaces, commas or `|`), or use **Paste…**
- Arrow keys and Enter move between cells; cells widen to fit expressions
- **Identity / Zeros / Random / Clear** fills, transpose in place, copy between A and B
- Result matrices carry **→ A** / **→ B** buttons to feed them into the next operation
- Toggle exact fractions vs decimals at any time
- Nineteen built-in examples, numeric and symbolic

Matrices up to 12×12 are supported through the UI.

## Files

| File | Purpose |
|---|---|
| `fraction.js` | Exact rationals on BigInt, plus integer-root helpers. |
| `symbolic.js` | The computer-algebra layer: atoms, polynomials, canonical rewrites, simplification, parser, printer, numeric evaluation. |
| `core.js` | Linear algebra over expressions — RREF, determinant, inverse, subspaces, characteristic polynomial, eigen decomposition, diagonalization, vector products, projections. |
| `app.js` | UI: input grids, result rendering, formatting, examples. |
| `index.html`, `style.css` | Page and styling. |

Everything runs in Node too:

```js
const K = require('./core.js');
const A = K.parseMatrix([['cos(t)', '-sin(t)'], ['sin(t)', 'cos(t)']]);

K.display(K.det(A).value);                  // "1"
K.inverse(A).inverse;                       // the transpose, exactly
K.eigen(A).eigenvalues.map(v => K.display(v.value));
                                            // ["cos(t) + i·sin(t)", "cos(t) − i·sin(t)"]
K.fourSubspaces(A);                         // column/row/null/left-null bases
const v = (...s) => s.map(K.Expr.parse);
K.projectOntoVector(v('1','2','3'), v('4','5','6')).proj;               // (128/77, 160/77, 192/77)
K.projectOntoColumnSpace(K.parseMatrix([['1','0'],['1','1'],['1','2']]), v('6','0','0')).xhat;  // (5, −3)
K.display(K.det(K.parseMatrix([['1','1','1'],['x','y','z'],['x^2','y^2','z^2']])).value);
                                            // the Vandermonde determinant
```

## Accuracy

Everything that can be exact is exact. The only numerical fallback is the eigenvalues of a **numeric** matrix whose characteristic polynomial has degree ≥ 3 with no rational roots — there is no formula for those, and the output is labelled as numerical when it happens.
