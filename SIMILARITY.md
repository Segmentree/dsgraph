# dsgraph — Component Similarity Pipeline

> The rigorous structural core behind component **typing**, **bundling**, **hierarchy**,
> and **composition**. DESIGN.md §2a summarizes this and points here; this file is the
> full spec. Phases 6–10 (DESIGN.md §16) implement it.
>
> **One-line summary.** Canonicalize components into ordered, token-**key**-labeled trees →
> embed (pq-grams) → ANN → exact Zhang–Shasha (key-driven relabel cost) → Louvain for
> **types**; PMI-weighted page co-occurrence → Louvain for **bundles**; containment on the
> side for **hierarchy**; cover-by-bases for **composition**. *Vectors for speed, the
> metric for truth.*

---

## 1. Definitions

The generative intuition — *a design system generates a space from a set of bases* — is
kept for reasoning about composition, but the object actually compared is a **canonical,
ordered, labeled tree**, not a point in a vector space: scalar multiplication and
subtraction are meaningless for UI components.

### 1.1 Token — key vs. value

A **token** is a styling primitive (`color`, `padding`, `radius`, `font`, `icon`, `size`,
`border`, `background`, …) with a **key** (the slot) and a **value** (the fill).

- **The key identifies the component; the value is instance-level.** Two buttons differing
  only in color are the **same** component, instantiated twice. **All component comparison
  is over keys, never values.**
- **Structural-value exception.** A small allowlist of keys whose *value* changes structure
  rather than appearance — `display` (`none`/`flex`), `position`, `flex-direction` — is
  folded into the node label. Everything else is keys-only.

> This is the other half of the **two-subsystem** split (DESIGN.md §2a): **values + ΔE**
> answer *drift* (does design's blue == code's blue, §7); **keys + structure** answer
> *typing / hierarchy / composition* (this file). Orthogonal, both kept.

### 1.2 Component — an ordered labeled tree

A **component** is, recursively, a node carrying a **set of token keys** (its own slots) and
an **ordered sequence of child components** (possibly empty). Formally a **labeled ordered
tree**: each node's label is `(node-type, {token keys})`; child order is layout / z-order
(this orderedness is what keeps edit distance polynomial). A non-trivial component has key-
or child-cardinality ≥ 1.

### 1.3 Base, non-base, design space, design system

| Term | Definition |
|---|---|
| **Base** | A component not expressible as a composition of others — a generator / atom (typically near-leaf). |
| **Non-base** | Any component expressible as a composition of ≥ 2 bases — an internal tree of bases. |
| **Design space** | The set of all components generable by composing the bases. |
| **Design system** | A **minimal generating set** of bases — the smallest base set whose compositions span the design space. |

### 1.4 Two orthogonal similarity axes

| Axis | Question | Source | Yields |
|---|---|---|---|
| **Intrinsic** | *What is this component?* | its own tree (structure) | **component types** (button, card, input) |
| **Extrinsic** | *What company does it keep?* | co-occurrence across pages | **usage bundles** (contacts kit, checkout kit) |

Neither reduces to the other; every component has one coordinate on each. Being structurally
a *button* while contextually in the *contacts bundle* is not a contradiction.

### 1.5 Distance measures and their roles

| Measure | Formula | Structure? | Metric? | Role |
|---|---|---|---|---|
| Jaccard | `\|A∩B\|/\|A∪B\|` | no | yes | sanity check / cheap pre-filter only |
| Cosine / angular | `A·B/(‖A‖‖B‖)` | no | angular only | sanity check only |
| **Tree edit distance** (Zhang–Shasha) | min insert/delete/relabel cost | **yes** | **yes** | **primary intrinsic measure** |
| **Containment** | `\|A∩B\|/\|A\|` | no | no (directional) | base / specialization hierarchy |

Edit distance subsumes the token measures in expressiveness but **cannot** express asymmetry
(containment) or co-occurrence (extrinsic) — so it is *the one* structural measure, not the
*only* measure.

---

## 2. Stage 0 — Canonicalize (mandatory)

Raw design-tool and JSX trees are full of incidental nesting; without normalization, edit
distance spends its budget on noise.

1. Collapse single-child wrapper frames.
2. Strip redundant groups / auto-layout artifacts.
3. Normalize each node label to `(node-type, {token keys})`, applying the structural-value
   allowlist (§1.1).
4. Fix child order canonically (layout order).

Output: **one clean ordered labeled tree per component**, on both the code and Figma sides
(Phase 6).

---

## 3. Stage A — Intrinsic axis → component types

**A1 — cheap per-tree features (O(n), computed once).** Node count `n`, type histogram
(count per node-type), depth. These double as **valid edit-distance lower bounds**:
`|n_A − n_B| ≤ d_edit` and `L1(hist_A, hist_B) ≤ d_edit`. *(Token similarity is NOT a valid
filter — same shape, different tokens can be structurally close yet token-distant.)*

**A2 — embed (pq-grams).** Slide a `(p, q)` window (p ancestors × q consecutive children)
over the tree, padding edges with a null label `*`; count pattern occurrences → fixed-length
vector. pq-gram distance approximates edit distance, O(n) per tree, respects child order.
*(The A1 histogram is a free crude embedding; A4 pivot-distances a free exact-metric one.)*

**A3 — ANN.** Index the pq-gram vectors with **HNSW**; retrieve top-k structural candidates
per component → small candidate set, sublinear lookup.

**A4 — exact confirmation (Zhang–Shasha).** Run exact ordered tree edit distance only on ANN
survivors. **Relabel cost is driven by token-key difference** between nodes (keys, not
values). Prune obviously-far pairs first with the A1 lower bounds. *Fallback when the corpus
is too homogeneous for A1 to thin it:* metric indexing (VP-tree / pivot table) — valid
because edit distance is a true metric.

**A5 — cluster.** Build the structural similarity graph (edge weight = inverse confirmed edit
distance) → **Louvain / Leiden** → emergent component **types**, no manual thresholds.

> **Scale note.** For a corpus of hundreds of components, exact Zhang–Shasha + A1 pruning is
> tractable directly; **A2–A3 (pq-grams + HNSW) are added only when corpus size demands**
> (Phase 7 ships exact-first). Learned tree embeddings (recursive / graph NN trained so
> `‖φ(A)−φ(B)‖ ≈ d_edit`) are reached for **only if** pq-grams + ANN stop keeping up.

---

## 4. Stage B — Extrinsic axis → usage bundles

**B1 — incidence.** Build `M[component, page]`; each component's row is its page fingerprint.
**Pages come from both sides** (DESIGN.md §16 Phase 8): code routes (the Router /
`composed-of` tree — which components render under each route) and Figma top-frames.

**B2 — reweight.** Apply **PMI** or **TF-IDF** to rows to kill the stopword effect
(ubiquitous buttons/headings co-occur with everything).

**B3 — cluster.** Build the co-occurrence graph from reweighted rows → **Louvain / Leiden** →
**usage bundles** ("show me everything contacts-related").

Stage B needs **no tree machinery** — only incidence — so it is independent of Phases 6–7.

---

## 5. Stage C — Hierarchy (containment)

Compute **asymmetric containment** `C(A,B) = |A∩B| / |A|` on token-**key** sets.

- `C(A,B)=1` and `C(B,A)<1` ⇒ **A is a base/subset, B specializes it**.
- Directional and non-metric, so it lives **outside** the edit-distance + clustering
  machinery — a hierarchy computed on the side.

Containment over the key-sets (and child-sets) yields the **base / non-base** partition and,
by reduction, the **minimal generating set** (§1.3).

---

## 6. Stage D — Composition / coverage solver

Given a **target** (an existing component, or a captured Figma node, canonicalized to a tree):
express it as a **minimal combination of bases** from the design system, and report the
**residual bespoke glue** that no base covers.

```
cover(target, bases):
    decompose target's canonical tree into maximal subtrees that match a base
        (match = exact, or edit-distance within ε with all relabels key-compatible)
    greedily/optimally select a minimal base set covering the matched subtrees
    residual = subtrees with no base match            # the genuinely-new layout/glue
    return { bases_used, residual, coverage = covered_nodes / total_nodes }
```

This is the rigorous form of *"can I build this from what we already have?"* — and the fix
for the value-based shortcut: coverage is judged on **keys + structure** (asymmetric,
containment-style), not symmetric value Jaccard.

---

## 7. How the verdict consumes the engine (Phase 10)

`context` / expressibility re-expressed on the engine outputs:

- **intrinsic type** → *what kind of thing is the intent* (which existing type to reuse).
- **extrinsic bundle** → *what it should travel with* (siblings to include).
- **containment** → *base vs specialization* (reuse a base, or a specialization of it).
- **composition (Stage D)** → *reuse / extend / introduce* with the covered bases + the
  residual glue named explicitly.
- **value bridge (§7, drift)** → whether the intent's *values* already exist as tokens
  (reuse) or need a new token (introduce) — the orthogonal value subsystem.

Output: a reuse / extend / introduce decision **with evidence**, for an intent given as a
**description or a design**.
