# Matrix Calculator

A dependency-free web matrix calculator for matrices of **any dimension**, using **exact rational arithmetic** (BigInt fractions) — no floating-point error in RREF, inverses, determinants, subspaces, or rational eigenvalues.

Open `index.html` in any browser. There is no build step, no install, and no server required.

## Features

| Operation | Notes |
|---|---|
| **Matrix multiplication** | `A × B`, `B × A`, plus `A + B`, `A − B`, transpose. Dimension mismatches are reported in plain language. |
| **RREF** | Pivot columns highlighted, rank and free columns reported, and every row operation shown step by step (`R2 ← R2 − 3·R1`, …). |
| **Eigenvalues & eigenvectors** | Characteristic polynomial via Faddeev–LeVerrier. Rational eigenvalues and their eigenvectors are exact; irrational quadratics get closed forms (e.g. `1/2 ± (1/2)√5`); complex and higher-degree irrational roots fall back to a numeric solver. Algebraic vs geometric multiplicity reported, defective eigenvalues flagged. |
| **Four fundamental subspaces** | Column space, row space, null space, left null space — with bases, dimensions, and the rank–nullity check. |
| **Diagonalization** | `A = P D P⁻¹`, verified exactly. Non-diagonalizable matrices get an explanation of which λ has geometric < algebraic multiplicity. Complex cases diagonalize over ℂ numerically. |
| **Gauss–Jordan inverse** | Shows `[A │ I] → [I │ A⁻¹]` with every row operation. Singular matrices are identified. |
| **Determinant** | Via row reduction, showing the triangular form, swap count, and diagonal product. |
| **Dot & cross product** | Dot gives norms and the angle between vectors (with an orthogonality badge); cross gives the vector, an orthogonality check, and the parallelogram area. |

## Input

- Entries accept integers, decimals, or fractions: `7`, `-2.5`, `-3/4`, `1e-2`
- Paste a whole matrix into any cell (rows on separate lines, entries separated by spaces or commas), or use the **Paste…** button
- Arrow keys and Enter move between cells
- **Identity / Zeros / Random / Clear** fills, transpose in place, and copy between A and B
- Result matrices carry **→ A** / **→ B** buttons to feed them straight into the next operation
- Toggle between exact fractions and decimals at any time
- Ten built-in examples cover every feature

Matrices up to 12×12 are supported through the UI.

## Files

| File | Purpose |
|---|---|
| `core.js` | All the mathematics. Exact `Frac` arithmetic on BigInt, matrix operations, RREF, determinant, inverse, subspaces, characteristic polynomial, eigen decomposition, diagonalization. Runs in the browser (`window.MatrixCore`) and in Node (`module.exports`). |
| `app.js` | UI: input grids, result rendering, formatting, examples. |
| `index.html`, `style.css` | Page and styling. |

`core.js` has no dependencies and can be used on its own:

```js
const K = require('./core.js');
const A = K.parseMatrix([['1', '2'], ['3', '4']]);
K.det(A).value.toString();        // "-2"
K.inverse(A).inverse;             // exact fractions
K.eigen(A).eigenvalues;           // values, multiplicities, eigenvectors
K.fourSubspaces(A);               // column/row/null/left-null bases
```

## Accuracy

Everything that *can* be exact *is* exact. Eigenvalues are only computed numerically when the characteristic polynomial has no rational root and cannot be resolved in closed form — those results are labelled as numeric in the output.
