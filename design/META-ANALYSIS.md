# Meta-Analysis Authoring — Methodology Spec

> **Status:** research complete, design draft. This is the methodology + implementation
> spec for a feature that lets graphtask author literature reviews, systematic reviews,
> and meta-analyses — with the graph as the auditable evidence base and the paper as a
> rendered view of it.
>
> **What "verified" means here.** Every load-bearing claim below was produced by two
> agentic research passes and adversarially fact-checked against its *primary source*
> (2–3 independent skeptic votes per claim, refute-biased). Run 1: 141 claims extracted,
> 25 verified (budget-capped), 21 confirmed. Run 2: the 92 highest-value unverified
> claims re-checked against fetched primary sources — **82 confirmed, 10 corrected.**
> The 10 corrections are folded in inline and collected in **§6 (Do-Not-Encode Ledger)**.
> Formula-level claims were checked symbol-by-symbol. Where a specific formula was *not*
> individually verified in this research, it is marked `[delegate]` — the stats module
> should mirror a vetted implementation (metafor `escalc`) rather than hand-derive it.

---

## 0. The two non-negotiable rules

Everything in this spec exists to serve two rules. If we violate either, the output is
worse than useless — it is *confidently wrong and looks authoritative*.

1. **The LLM never computes the statistics.** Extraction produces a structured table of
   effect sizes + variances (each anchored to a source location). A **deterministic
   compute module** does all pooling, heterogeneity, bias, and plotting. The paper renders
   numbers *from* that module's output; the model never writes a pooled estimate, CI,
   I², or p-value as free text.

2. **The dependence model is chosen a priori, never by results.** The canonical source
   (Pustejovsky & Tipton 2022) calls model-shopping across working models "the
   meta-analytic equivalent of p-hacking." The tool must *fix the working model up front*
   (ideally recorded in the protocol) via the §1.3 decision tree, then run a rho
   sensitivity analysis — it must **not** let a user pick the model that gives the nicest
   forest plot. This is a guardrail we *enforce in the workflow*, not an option we offer.

A third rule follows from the product being a *paper*, not a build artifact:

3. **Full automation is a goal; the human gate is a review board at the end.** We DO attempt a
   fully-autonomous mode: the system produces the entire meta-analysis end-to-end and emits a
   preprint (arXiv-style) delivered to a human **review board** (currently Kevin) who signs off
   before anything is treated as final or published externally. The gate is not "a human does
   the work"; it's "a human board approves the finished artifact." The one non-negotiable that
   makes the board able to function: **the automated output must carry its own uncertainty** —
   commensurability-confidence scores, anchored-vs-unanchored labels, batch-effect flags — so
   the reviewer can judge it. An output that strips uncertainty into a bare confident number is
   the failure mode, *not* automation itself. (Assisted, human-in-the-loop mode is expected to
   yield better results and is built too — see §8.6.)

---

## 1. The statistics core (the deliverable)

### 1.1 Effect-size families to support

The module must compute a common effect metric per outcome type and carry its **sampling
variance** (everything downstream is inverse-variance weighted). Support:

| Data shape | Effect size | Notes |
|---|---|---|
| Continuous, 2 groups | **SMD → Hedges *g*** (small-sample-corrected *d*) | `g = d · J`, `J` = small-sample correction. `[delegate]` |
| Continuous, raw units comparable | **Mean difference (MD)** | Only when all studies share the outcome scale. |
| Binary | **log OR**, **log RR**, **risk difference** | Mantel–Haenszel and Peto available for sparse 2×2 (metafor supports both). |
| Correlational | **Pearson *r* → Fisher *z*** | Pool in *z*, back-transform for reporting. `[delegate]` |
| Proportions | **logit / arcsine-transformed proportion** | |
| Time-to-event | **log hazard ratio** | |

**Engineering call:** do **not** re-derive variance formulas by hand. Mirror the semantics
of metafor's `escalc` (the de facto reference; it computes effect sizes + variances for all
of the above). This sidesteps the single largest fabrication surface. Cochrane Handbook
Ch. 6 §6.5.2.10 is the authoritative reference for *combining* means/SDs across arms
(verified: Ch. 23 explicitly defers those formulas to Ch. 6). `[verified pointer]`

### 1.2 Pooling, heterogeneity, and their honest interpretation

**Fixed-effect (equal-effect) model** — inverse-variance weights `w_k = 1/s²_k`; pooled
effect `θ̂ = Σ(θ̂_k · w_k) / Σ w_k`. Assumes one true effect. `[verified: Harrer et al. Formula 4.2]`

**Random-effects model** — weights `w*_k = 1/(s²_k + τ²)`, estimating `μ`, the mean of a
*distribution* of true effects. Decomposition (note where the error term sits — this was a
verified correction):
- True effect of study *k*: `θ_k = μ + ζ_k`
- **Observed** estimate: `θ̂_k = μ + ζ_k + ε_k` — sampling error `ε_k` attaches to the
  *observed estimate θ̂_k*, **not** to the true effect. `[verified: Harrer Formulas 4.5–4.7]`

**τ² (between-study variance) estimator** — this choice matters and has a verified,
*non-obvious* recommendation:
- **REML** — first choice for **continuous** outcomes; it is metafor's default.
- **Paule–Mandel** — good first choice for **binary** outcomes (absent extreme sample-size variation).
- **DerSimonian–Laird** — most commonly used historically, but **biased when studies are
  few and heterogeneity is high**; keep it available only for *replicating results from
  other software*.
- ⚠️ *Do not encode "Paule–Mandel for both" — that was a mis-attribution (the "both"
  recommendation is Veroniki et al. 2016, not Harrer et al.'s own guidance).* See §6.
`[verified w/ correction: Harrer et al.]`

**Knapp–Hartung adjustment** — use a *t*-distribution (not normal) for the pooled-effect
test/CI, to propagate uncertainty in τ̂². Recommended in most random-effects analyses; it
usually widens CIs slightly and **reduces false-positives, especially when studies are few.**
Default it ON. `[verified: Harrer et al.]`

**Prediction interval** — report alongside the CI. The CI is the uncertainty of the *mean*
effect; the **prediction interval is the range a new study's true effect could fall in** —
the honest expression of heterogeneity. metafor supports it.

**Heterogeneity statistics — and how to *not* misread them:**
- Report **τ²** (absolute between-study variance), **Q** (test), and **I²** (% of variance
  due to heterogeneity, not chance).
- I² is a *ratio*, not an absolute amount, and inflates with study precision — never
  describe it as "the amount of heterogeneity." Pair it with τ² and the prediction interval.

### 1.3 THE DEPENDENCY PROBLEM — the decision tree (crown jewel)

This is the "break the experiments apart, recombine the similar-enough pieces" problem. It
is the highest-stakes and best-specified part of the whole feature. **Every claim in this
section survived 3–0 adversarial verification.**

#### 1.3.1 The four sources of dependence
1. Multiple **outcomes** measured on one sample.
2. One outcome at multiple **timepoints**.
3. Multiple **treatment arms** vs a shared control.
4. Multiple **correlations** from one sample.

#### 1.3.2 The four strategies → five methods (Becker 2000)
`ignore` · `combine` · `sub-classify` · `model`, instantiated as:
1. **Aggregate / composite** (Borenstein et al. 2009) — average dependent effects to one per study.
2. **Shifting unit of analysis** (Cooper 1998) — subgroup, then average within subgroup.
3. **Multivariate** meta-analysis (Kalaian & Raudenbush 1996).
4. **Multilevel / three-level** meta-analysis (Van den Noortgate et al. 2013/2015).
5. **Robust Variance Estimation (RVE)** (Hedges, Tipton & Johnson 2010).

#### 1.3.3 The equivalences that make the choice tractable (Pustejovsky & Chen 2024)
The "aggregate first vs model the dependency" choice is **less fraught than it looks**,
because the ad-hoc shortcuts are *exactly* special cases of the formal models:
- **Averaging to one effect per study (inverse-variance weighted) is likelihood-equivalent
  to fitting the multivariate Correlated-Effects (CE) model** on the raw effects —
  identical ML/REML point estimates and model-based SEs. `[verified 3–0]`
- **Cooper's shifting-unit-of-analysis is exactly the Subgroup-Correlated-Effects (SCE)
  model** (Theorem 2), provided predictors don't vary across estimates within the same
  subgroup of a study; study-level aggregation is the `G = 1` special case. `[verified]`
- Therefore aggregation is *justified exactly when the corresponding working model is
  appropriate* — and that's **testable** (LRT of CE vs a model adding within-study
  heterogeneity; or compare Q between raw-effect and aggregated-effect models). `[verified]`
- **Limits of the equivalence** (verified): it holds only for *likelihood-based* estimation
  and *study-level* predictors. It breaks for the robumeta moment estimator, generalized-Q
  CIs, and Hartung–Knapp; and only the integrative (multilevel/multivariate) models can
  include predictors that vary *across effect sizes within a study*. That last point is the
  reason to prefer modeling over aggregation when moderators live at the effect level.

#### 1.3.4 The modern default: CHE + RVE
When the correlations among effect sizes are unknown (the usual case), the default working
model is **Correlated-and-Hierarchical Effects (CHE)** with **Robust Variance Estimation**.
Verified model equations:

```
Hierarchical (HE):   T_ij = x_ij·β + u_j + v_ij + e_ij
                     Var(u_j)=τ²,  Var(v_ij)=ω²,  Var(e_ij)=s_ij²,  Cov(e_hj,e_ij)=0

Correlated (CE):     T_ij = x_ij·β + u_j + e_ij
                     Var(u_j)=τ²,  Var(e_ij)=s_j²,  Cov(e_hj,e_ij)=ρ·s_j²
                     weight w_ij = 1 / (n_j·(τ̂² + s_j²))          [robumeta default ρ = 0.80]

CHE:                 T_ij = x_ij·β + u_j + v_ij + e_ij
                     Var(u_j)=τ² (between-study), Var(v_ij)=ω² (within-study),
                     Var(e_ij)=s_j²,  Cov(e_hj,e_ij)=ρ·s_j²   [constant sampling correlation]
```
CHE is positioned as the **first-choice working model when correlations are unknown.** `[verified 3–0]`

**Why RVE is safe (the key result):** RVE yields **unbiased meta-regression coefficients and
valid SEs / tests / CIs even when the working covariance model is misspecified.** A more
accurate working model buys *efficiency (precision)*, not *validity* — which is precisely
why we can fix one working model a priori and not agonize over the "true" covariance. `[verified 3–0]`

**The catch (verified refinement):** RVE validity is *asymptotic in the number of
clusters/studies*. With few studies (**danger zone ≈ ≤ 40**) or highly imbalanced designs,
naive RVE undercovers. **Default to CR2 + Satterthwaite small-sample corrections**
(clubSandwich) and **warn when clusters are few.** For very small study counts, the stack
also offers cluster wild bootstrapping (wildmeta).

#### 1.3.5 The a-priori decision tree (Pustejovsky & Tipton 2022, Fig. 1)
Encode this literally as the workflow's model-selection step:
1. **Assume a within-study sampling correlation ρ** (a single value; robumeta default 0.80,
   worked examples use 0.6).
2. **Pick a random-effects structure** (HE / CE / CHE).
3. **Decide whether to add levels** (e.g. CHE+ for extra nesting).

Then **ρ sensitivity analysis is required**: vary ρ across `0.0 → 0.95`. Verified empirical
behavior: **coefficient estimates stay stable; the variance-component (τ²/ω²) estimates
become substantially sensitive above ρ ≈ 0.8.** Report the sensitivity, don't hide it.

#### 1.3.6 Multi-arm & factorial trials (Cochrane Handbook Ch. 23 — all verified 3–0)
- **Preferred fix for a multi-arm study in a pairwise MA:** *combine* all relevant
  experimental arms into one group and all relevant comparators into one group. For
  dichotomous outcomes, **sum sample sizes and event counts** across arms; for continuous,
  combine means/SDs via Ch. 6 §6.5.2.10. `[verified]`
- **What to avoid:** entering several comparisons that reuse the *shared comparator group*
  more than once — that "double-counts" participants → **unit-of-analysis error** from
  unaddressed correlation. `[verified]`
- **Splitting the shared control** into sub-groups only *partially* fixes it (comparisons
  stay correlated) → **not generally recommended.** `[verified]`
- **2×2 factorial trial:** if both comparisons are relevant, *both full comparisons* can be
  entered **without accounting for double-counting** (caveat: revisit if an important
  interaction exists — empirically rare, ~6% of re-analyzed factorial trials). `[verified]`

#### 1.3.7 Reference implementation (the module should match this)
```
1. Choose working model via the Fig. 1 decision tree (a priori).
2. Build covariance:  clubSandwich::impute_covariance_matrix()  (or metafor::vcalc())
3. Fit:               metafor::rma.mv()  — REML variance components, fully
                      inverse-variance weight matrices.
4. Robust inference:  clubSandwich::coef_test() / conf_int() / Wald_test()
                      (equivalently metafor::robust(..., clubSandwich = TRUE));
                      predict() for CIs, anova() for coefficient sets.
```
This improves on original robumeta in two verified ways: **REML** variance components (vs
method-of-moments) and **fully inverse-variance** weights (vs approximate diagonal weights).
Open-source stack to match: `clubSandwich`, `wildmeta`, `POMADE` (power), `metaselection`.

> **Three-level models:** a *valid option* for nested dependence, **not the mandated
> default**, and a likelihood-ratio test is **not required** to justify one (both over-strong
> claims were refuted — see §6). Model: `θ̂_ij = μ + ζ_(2)ij + ζ_(3)j + ε_ij`, two τ²
> components, fit `rma.mv(random = ~ 1 | cluster/effect)`.

### 1.4 Heterogeneity exploration
- **Subgroup analysis** and **meta-regression** (PRISMA Item 13e requires *describing* these).
- Practical guardrails: enough studies per moderator level; test the *interaction*, don't
  just compare within-subgroup significance. Aggregation restricts moderators to
  *between-study* predictors only — another reason to model when moderators are effect-level.

### 1.5 Publication bias & small-study effects — the TRUST LEDGER

The most important verified finding for this section: **no bias-correction method dominates;
report several as a sensitivity analysis, never a single "corrected" point estimate.**
(Landmark 432-condition simulation, Carter et al. 2019, and McShane et al. 2016 both say so.)

| Method | Verified verdict | Gate / condition |
|---|---|---|
| **Random-effects pooling alone** | Under strong bias + null effect: **Type-I error ≥ 98%**, spurious effect ≈ 0.33. **Cannot be trusted when bias is plausible.** | — |
| **Trim-and-fill** | Most-used, **corrects only marginally** — Type-I error stayed > 70% under strong bias. Unreliable when heterogeneity is large. | Don't present its output as a bias-*corrected* estimate. |
| **p-curve / p-uniform** | **Break under heterogeneity**: with τ = 0.2 + strong bias, Type-I error > 40% (k=10), 98% (k=60). Only OK under rigid significance selection + homogeneity. | Gate on a low-heterogeneity check. |
| **PET-PEESE** | Poor when **few studies (K<20) AND small samples AND I² > 80%** (conditions co-occur). But still better than naive RE under those same conditions. | Not the sole adjustment; needs ≥ ~20 studies. |
| **3-parameter selection model** | Recommended **minimum** realistic model (allows non-sig publication + heterogeneity). | Use for *sensitivity*, exploring estimates across assumed selection severities. |
| **Funnel plot asymmetry** | **NOT diagnostic of bias** — ≥ 5 competing causes (true heterogeneity, small-study methodological effects, artefactual SE–effect correlation, chance). | Tooling must **never label asymmetry as "bias."** |
| **Egger's test** | Standard test; on **SMD** it inflates false-positives (SMD & its SE aren't independent) → use the **modified SE** regressor (Pustejovsky & Rodgers 2019). | Rule of thumb **K ≥ 10** (a *default/warn*, not a hard gate — see §6). |
| **Peters' test** | Route **binary** outcomes here instead of Egger. | |
| **Contour-enhanced funnel** | Overlays significance contours (p = 0.01/0.05/0.1) so the analyst can separate bias-driven from other asymmetry. | Interactive control: toggle contours. |
| **ROB-ME** (Cochrane) | Structured missing-evidence tool, 8 signalling questions. **Highly desirable, not mandatory.** | |

⚠️ **Under dependence, standard bias methods must be adapted** — do not naively apply
Egger/trim-and-fill/selection models to multilevel data (Rodgers & Pustejovsky 2020;
Chen & Pustejovsky 2025/26 corrected selection models; `metaselection`). `[verified]`

### 1.6 Sensitivity & influence diagnostics
- **Leave-one-out** (recompute the pooled estimate dropping each study — the flagship
  interactive control).
- **Baujat plot** (contribution to heterogeneity vs influence on the pooled result).
- **GOSH plot** (distribution of estimates across all study subsets — reveals clusters/outliers).
- **Influence diagnostics** (Cook's distance, etc.). metafor provides all of these.

---

## 2. Reporting-standards wrapper (what the paper must contain)

**PRISMA 2020** is the governing standard (verified): a **27-item checklist** (7 sections)
+ expanded item-level checklist + **12-item abstract checklist** + a **four-phase flow
diagram**. Statistical items the template must surface:
- **13d** — synthesis model (fixed vs random), heterogeneity method(s) (τ, I²), **software**.
- **13e** — methods to explore heterogeneity (subgroup, meta-regression).
- **13f** — sensitivity analyses.
- (Numeric τ²/I² *values* are reported under results Item 20b.)

**PRISMA 2020 flow diagram** (verified): three phases (Identification → Screening →
Included), with `n=` count fields for every stage — records identified (per source),
duplicates removed, records screened, records excluded, reports sought / not retrieved,
reports assessed, **reports excluded with reasons**, studies included. **4 official
templates** (new vs updated review × databases-only vs databases+other-sources). Distributed
**CC BY 4.0** — reusable in our tool with attribution. A **PRISMA2020 Shiny app** already
auto-generates these (interactivity precedent).

**Risk of bias / certainty:**
- **Per study:** Cochrane **RoB 2** (RCTs) / **ROBINS-I** (non-randomized) — domain-based,
  replacing generic quality scores.
- **The review itself:** **AMSTAR 2** (ROBIS is an alternative).
- **Per outcome:** **GRADE** → one of **High / Moderate / Low / Very Low**, across 5
  domains (risk of bias, inconsistency, indirectness, imprecision, publication bias).
  GRADEpro GDT is the reference tool (imports from RevMan; emits Summary-of-Findings tables).
- **Storage implication:** RoB is *per-study / per-domain*; GRADE is *per-outcome*.

**Registration:** **PROSPERO is recommended, not a mandatory pre-extraction gate** (refuted
as a hard requirement — see §6). Offer it; don't block on it.

---

## 3. Visualization inventory + the interactive-viz design

The user's vision: **not static R-generated figures — live, exploratory data tools** (think
RStudio / Tableau / Claude artifacts / d3). The research captured, per figure, *which
parameter an analyst manipulates while exploring* — that column **is** the interactive spec.

| Figure | What it shows | Standard | **Live controls to expose** |
|---|---|---|---|
| **Forest plot** | Per-study effect + CI, pooled diamond, weights | PRISMA's principal figure | model (FE/RE) toggle · τ² estimator · Knapp-Hartung on/off · **leave-one-out** · sort (effect/precision/year) · subgroup pivot · show prediction interval |
| **Subgroup / cumulative / caterpillar forest** | Grouped or sequentially-accumulated pooling | Common | choose moderator to group by · cumulative order variable |
| **Funnel plot (contour-enhanced)** | Effect vs precision; small-study effects | Optional but expected when K≥10 | toggle significance contours · overlay trim-and-fill imputed studies · switch asymmetry test (Egger/Peters) |
| **PRISMA 2020 flow diagram** | Record flow with counts | **Required** | auto-filled from graph node counts; live as screening proceeds |
| **RoB traffic-light + weighted summary (robvis)** | Per-study×domain judgments / domain distribution | Required (RoB) | switch tool (RoB2/ROBINS-I/…) · weighted vs unweighted · show/hide overall |
| **L'Abbé plot** | Event rates treatment vs control (binary) | Optional | reference line · point size = weight |
| **Baujat plot** | Heterogeneity contribution vs influence | Optional | click a point → exclude & recompute |
| **GOSH plot** | Pooled estimate across all study subsets | Optional | lasso a cluster → identify the studies driving it |
| **Meta-regression bubble plot** | Effect vs continuous moderator, bubble = precision | Optional | choose moderator · fit line + CI band |
| **Orchard plot** | Summary + CI + **prediction interval** + all effects as precision-scaled points; multiple moderator "trunks" | Optional (PRISMA-EcoEvo) | moderator facets · heteroscedastic variances · marginal vs conditional estimates |
| **Network geometry + SUCRA / rankograms** | NMA structure + treatment rankings | Required for NMA | model type · leave-one-out · reference treatment |
| **ρ-sensitivity curve** | Coefficients & variance components vs assumed ρ | (our addition) | **ρ slider 0.0→0.95** — the §1.3.5 required analysis, made tactile |

**The interaction model that unifies these** (and is the actual novelty): every figure is a
*live view over the graph's extracted effect-size table*. Moving a control (drop a study,
switch the model, drag the ρ slider) **re-runs the deterministic stats module and re-renders
in place** — the forest plot, the pooled diamond, I², and the paper's Results prose all
update together, because they all read from the same computed output. That is the
RStudio-not-static-PNG experience, tied to a knowledge graph and an auto-drafted paper.

---

## 4. Interactivity precedents & the white space

Verified precedents (what live interaction already exists):
- **MetaInsight** (web/Shiny, netmeta): switch FE/RE, **deselect studies via checkboxes and
  re-run the NMA in real time**, network-geometry + league tables. Motivated explicitly by
  "existing NMA software needs too much programming."
- **robvis** (R + Shiny web app): interactive RoB traffic-light / summary; 7 tools.
- **PRISMA2020 Shiny app**: interactive flow-diagram generation.
- **GRADEpro GDT**: web, imports from RevMan, auto-builds evidence tables.
- **JASP / jamovi**: GUI meta-analysis modules (metafor-backed).
- **WebPlotDigitizer / metaDigitise**: extract data points from *published figures* — the
  bridge for studies that only report a plot.

**The gap (our opening):** every precedent is a *single-purpose* interactive tool bolted
onto a static dataset. **None ties live exploration to (a) a living evidence graph with
per-number provenance, (b) automatic double-extraction/verification, and (c) an
auto-regenerating PRISMA paper.** That integrated loop — explore → the graph and the paper
move with you → every point traces to a source quote — is what graphtask can be that
metafor+Shiny cannot.

---

## 5. How this maps onto graphtask (≈70% of the substrate already exists)

The E15 node fields live in `tasks.meta` (JSONB, validated in `src/markdown.js`), so an
evidence ontology is nearly free — no migration.

| Systematic-review need | Existing primitive |
|---|---|
| Inclusion / exclusion criteria | `metaFilter.js` — Mongo-style DSL over node meta (`type='rct' AND confidence ≥ 0.6`) |
| "Which included studies still need verifying" | `frontier.js` — load-bearing **AND** (stale `verified_at` OR low confidence) = the re-extraction queue |
| Conflicting findings in the literature | `inconsistency.js` + `supports`/`contradicts` edges — surfaces disagreement as a structural "merge conflict," never auto-resolves → Discussion section |
| Provenance + verification stamp | E15 node meta: `type` / `confidence` / `verified_at` |
| Roll back a bad extraction pass | `run_id` on batch-upsert; dedup a study across rounds → `external_id` |
| The paper itself | a `reports` row — point-in-time render, decoupled from the graph, shown in reader mode with auto-TOC + staleness banner |
| Retrieval for writing | dense + lexical search, `contextPack` |

**New pieces required (5):**
1. **Scholarly-source connector** — OpenAlex / Europe PMC / Crossref (real, reproducible
   search + OA full-text). *Google Scholar has no API and blocks bots — not a systematic
   backend; fine for the human to hand-pick exemplars.*
2. **Deterministic stats module** — §1, mirroring escalc/metafor/clubSandwich semantics.
   The one genuinely new engine, and the one the LLM must never substitute for.
3. **PRISMA report template** — §2 structure, flow diagram, evidence tables, GRADE table.
4. **Interactive-viz layer** — §3, live views over the extracted table.
5. **Double-extraction + reconciliation + adversarial-verify workflow** — two blind
   extractor passes per study; reconcile; only reconciled + source-anchored numbers get
   `verified_at`.

**Evidence ontology (node `type` conventions over E15 meta):** `Protocol`, `Study`,
`Sample`, `Outcome`, `EffectEstimate` (carries metric, value, variance, n, and a mandatory
**source anchor** — quote / table-cell / page; no anchor ⇒ not eligible for pooling),
`Claim`. Edges: `supports` / `contradicts` between evidence and claims; `related to` for
same-sample links (the dependence structure the stats module reads).

---

## 6. Do-Not-Encode Ledger (verified refutations / corrections)

Encoding any of these as a hard rule would be *wrong* — each was refuted or corrected under
adversarial checking. Keep them as defaults/warnings, not gates.

1. **PROSPERO registration is NOT a mandatory pre-extraction gate** — recommended. (refuted 0–3)
2. **Three-level models are NOT the mandated default** for nested dependence — one valid
   option among five. (refuted 0–3)
3. **A likelihood-ratio test (`anova()`) is NOT required** to justify a three-level model. (refuted 0–3)
4. **PRISMA Item 14 does not name the funnel plot as a required exemplar** the way the
   extractor claimed. (refuted 0–3)
5. **τ² estimator: it's REML-for-continuous / Paule–Mandel-for-binary** — NOT "Paule–Mandel
   for both" (that's Veroniki et al. 2016, mis-attributed to Harrer et al.). (corrected)
6. **K ≥ 10 for funnel-asymmetry tests is a rule of thumb ("should"), not a hard "must."**
   Default to skip/warn below 10; don't hard-block. (corrected)
7. **Cochrane Ch. 13 expresses no single preferred bias method** and doesn't mention
   trim-and-fill; statistician consultation is tied specifically to *selection models*. (corrected)
8. **ROB-ME is "highly desirable" (MECIR C73), not mandatory**, and not the only allowed tool. (corrected)
9. **CR2 small-sample corrections:** Tipton & Pustejovsky 2015 (**Tipton** is first author);
   CR2 itself traces to Bell & McCaffrey 2002. Strongly recommended, not a universal
   requirement. (corrected)
10. **Random-effects sampling error `ε_k` attaches to the observed estimate**
    `θ̂_k = μ + ζ_k + ε_k`, not to the true effect `θ_k = μ + ζ_k`. (corrected — matters for a formula spec)
11. **Pustejovsky & Chen 2024 equivalences cover aggregating / subgrouping / shifting-unit —
    NOT "select one effect and discard the rest."** (corrected)

---

## 7. Suggested build order

- **Phase A — Evidence spine (Tier 1 systematic review).** Evidence ontology on E15;
  scholarly connector; screening via `metaFilter`; extraction with mandatory source anchors +
  double-extraction/reconciliation; PRISMA flow diagram + report template; RoB per study;
  qualitative synthesis. *Every number traceable before any pooling exists.*
- **Phase B — Deterministic stats module (Tier 2).** §1 in code (delegating effect-size
  math to escalc semantics), CHE+RVE dependency path, τ² estimators, Knapp-Hartung,
  prediction intervals, the bias trust-ledger, sensitivity diagnostics. Forest/funnel first.
- **Phase C — Interactive-viz layer.** §3 live views; leave-one-out, ρ-slider, model toggle;
  the "graph + paper move with you" loop.
- **Phase D — GRADE + polish.** Per-outcome GRADE, Summary-of-Findings tables, NMA if wanted.

---

## 8. Cross-study component recombination (the "dissect and recombine" idea)

> A separate research pass (25–0 on the core, plus a 51-confirmed / 6-corrected buildability
> pass; the 6 "refutations" were all **my** citation mis-mappings, not content errors). This
> section answers: *is there a name for pooling procedurally-commensurable pieces across
> topically-unrelated papers, is it valid, and can LLMs drive it?*

### 8.1 The idea, precisely
Stop treating a paper as an atomic, topic-labeled unit. **Decompose each study into its
methods and sub-experiments** (model system, materials, protocol, timeframe, assay, and each
individual arm/contrast). Then match across papers on **procedural commensurability at the
sub-experiment level, not on topic** — and pool the pieces that are "the same thing measured
the same way," assembling a sample no keyword search could gather because the source papers
have unrelated titles and questions.

### 8.2 Is there a term? — closest matches, and where this goes beyond them (all verified)
- **Component Network Meta-Analysis (CNMA)** is the closest *named method*: it decomposes
  multicomponent interventions into components and estimates each. It can *technically*
  "reconnect a disconnected network" via shared components — the nearest published analogue —
  **but its own developers call the disconnected case "questionable,"** resting on an
  additivity assumption that *cannot be tested there*; they advise it only with strong prior
  arguments, else analyze sub-networks separately. *(Cite CNMA to Rücker et al. 2020 /
  Efthimiou et al. 2022 / Rücker's BMC Med Res Methodol methods paper — **not** to
  `sim.70068`, which is a transitivity paper.)*
- **Virtual Control Groups (VCGs)** are the closest *real-world practice* — and they're in the
  exact preclinical domain: reuse historical control arms **stratified/matched by strain, age,
  study duration, vehicle** (literally the component-matching envisioned), 3Rs-motivated
  (~25% animal reduction). Verified limits: substituting virtual controls **reproduces the
  original *statistical* findings only "poorly-to-moderately,"** is validated only at the
  *coarse-conclusion* level, replaces only a *proportion* of controls, is control-group
  specific, and is confined to *homogeneous study types*.
- **Retrospective data harmonization** (Maelstrom): "inferential equivalence" of measures from
  different-purpose cohorts — but a *hard* precondition is design compatibility, and in
  practice **only 11.8% of surveyed initiatives validated their harmonized data** (practice
  diverges sharply from guidance).
- **NMA / IPD**: link *randomized* trials through shared comparators; validity rests on
  **transitivity/exchangeability** (no systematic difference in effect-modifier distributions),
  which is a *judgment call, not a statistical test*.
- **Verdict:** the full cross-purpose vision **extends beyond CNMA and every established
  method** — all of them stay inside a single *connected, same-outcome, design-compatible*
  network; the vision pools arms linked *only by procedural sameness* across unrelated papers.
  **No established methodology sanctions the full case.** That's the white space — and it means
  the feature must be *more* careful than existing methods, not less.

### 8.3 The validity line — when recombination is valid vs. a fabrication engine
The powerful version and the garbage version look identical until you ask: **does the pooled
contrast preserve within-study randomization?** (Phillippo et al. 2018 / NICE DSU TSD 18, verified.)

- **Anchored** (link two studies through a *shared comparator*, compare *relative* effects):
  **"should always be preferred."** Requires only *conditional constancy of relative effects*
  (balance the effect modifiers).
- **Unanchored** (pluck arm A, compare directly to arm B — no shared comparator): a **last
  resort**, valid only with no connected randomized network or single-arm studies. Requires the
  far stronger *conditional constancy of absolute effects* — you must **know and adjust for
  ALL effect modifiers AND prognostic variables.** Results that don't demonstrate the
  adjustment compensates for the missing comparator **"should be disregarded entirely."**
- Even the *adjusted* unanchored method (MAIC) is **not reliably better than naive** — under
  low covariate overlap + high covariate strength it's *worse*, and **more data does not fix
  residual bias** (2025 simulation, verified). 89% of NICE population-adjusted comparisons are
  unanchored MAICs — i.e., the risky mode is the common one.

**Why "identical protocol" still isn't identical (quantified, verified):**
- **Batch effects** (Leek et al. 2010): **32.1–99.5%** of measured features associate with mere
  *processing date*; the technical signal *typically dominates the biological one*. The
  procedural dimensions that cause this — lab, reagent lot, instrument, technician, date — are
  *exactly what a cross-study pooling tool would have to match on.*
- **The killer example** (Haibe-Kains et al. 2013, CGP vs CCLE): two labs assayed the **same
  471 cell lines with the same 15 drugs**. Gene expression agreed (median Spearman **0.85**),
  but **drug response did not** — median IC50 correlation **0.28**, AUC **0.35**, only **1 of
  15 drugs** above 0.6. Models trained on one lab failed on the other. Cause: assay,
  concentration range, curve-fit differences. **Same material, same drugs, different lab →
  non-commensurable phenotypes.** This is the empirical ceiling on the whole idea.
- The motivating example is *in-vitro*, where studies often **aren't randomized at all** — so
  there's no within-study anchor to lean on. SYRCLE makes *baseline similarity between groups*
  a checked item *for exactly this reason* (verified).

### 8.4 Can LLMs drive this? — honest verdict (three independent evals, verified)
**No — assist, don't drive.** Consistent across all sources:
- LLMs **cannot autonomously replace human extraction**; positioned only as a *second reviewer
  with human oversight*.
- **Text/string fields extract well; numeric fields — the values you must pool — are the least
  reliable.** Hallucination is real and measured: GPT-4 fabricated an "RCT" design the abstract
  never stated; ChatGPT-4o **agreed 92.4%** overall but **fabricated 5.2%** of cases,
  concentrated on *unreported* items (agreement dropped to **77.2%** there — it *infers* rather
  than flagging missing data). Not replicable even at temperature 0.
- Accuracy is **highly setup-dependent**: o3 75.3%, GPT-4o ~61.6% on one dataset but **96.3%**
  in a favorable batch/external-validation setup — so architecture matters enormously.
- **End-to-end automated meta-analysis is unsolved** (2025 PRISMA review, 978→54 studies): 57%
  of automation targets early-stage tasks, only 17% advanced synthesis; higher-order synthesis
  is underdeveloped. Automation *assists* human judgment; it doesn't replace it.

**Important scope note on that verdict:** every eval above measured *unguarded, autonomous*
extraction judged against a human standard. It is NOT a reason to abandon automation. With
source-anchoring, double-extraction + reconciliation, stronger models (e.g. Opus 4.8 at high
effort), and a review-board gate, hallucination becomes a **tracked, gated quantity, not a
disqualifier** — and the *hallucination rate itself is a first-class product metric* the tool
surfaces (per-field extraction agreement, % inferred-vs-stated, reconciliation disagreement).
So: we attempt full automation AND we measure exactly how often it errs. The guardrails aren't
there because automation is forbidden; they're there so the automated output can be *trusted or
distrusted with evidence*.

⇒ Net: source-anchoring + double-extraction + reconciliation + review-board sign-off (§0, §5)
are load-bearing. The model *proposes* commensurability and drafts the paper; the statistics
and the review board *dispose* — with the extraction-error rate on the page.

### 8.5 Formal substrate for decomposition (verified)
- **OBI** (Ontology for Biomedical Investigations): **2500+** logically-defined, ID-bearing
  terms for assays, devices, objectives, at multiple granularities; positioned as a
  *cross-dataset integration standard* and interoperable with the OBO Foundry (GO, ChEBI, …).
  **The leading candidate canonical schema** for the "study card."
- **EXPO**: a general, domain-independent experiment ontology that **demonstrably surfaced
  cross-domain commensurability** (it made a high-energy-physics and a phylogenetics experiment
  comparable) — a proof-of-concept for the exact "find commensurable pieces across unrelated
  fields" move.
- **ISA framework** (Investigation/Study/Assay) — pragmatic tabular metadata standard;
  lighter-weight complement to OBI for the arm/assay decomposition.

### 8.6 The white space (verified) and the feature's honest ambition
- The **CAMARADES** preclinical toolchain covers search, screening (SyRF/Rayyan), extraction
  (Auto-STEED), and risk-of-bias (SYRCLE) — but has **no tool for meta-analysis statistics, for
  multiple experiments within a paper, or for cross-study arm pooling.** Verified gap.
- **No system does component-level cross-study recombination.** The opening is real.

**Two operating modes (both built):**
- **Autonomous mode** — the system runs the whole pipeline end-to-end and produces a complete
  preprint delivered to the review board. This is an explicit goal, not a stretch.
- **Assisted mode** — a human is in the loop during screening/extraction/matching; expected to
  yield better results, and the source of ground-truth for measuring autonomous mode's error rate.

**The load-bearing principle for *either* mode:** the output is an *uncertainty-carrying,
auditable artifact*, never a bare confident number. It always ships with its commensurability
scores, anchored-vs-unanchored labels, batch-effect flags, and per-field extraction agreement —
that is precisely what lets the review board judge an autonomously-produced preprint. "Discovery
+ evidence-mapping engine" describes the *artifact* (it shows its work and its doubt); it does
NOT mean "don't automate." Concretely, on top of the graphtask substrate:
1. **Decompose** each study into an OBI/EXPO-style structured **study card** (model system,
   materials, protocol steps, timeframe, assay, arms/contrasts) — every field *source-anchored*
   (§0). Study card = a typed node cluster; procedural components = node meta / linked nodes.
2. **Match** — propose candidate poolable pieces across topically-unrelated papers on procedural
   dimensions (strain/age/passage/vehicle/assay/concentration-range/readout). The matcher is a
   query over the graph; a **commensurability edge** carries a *match score*.
3. **Gate before pooling** — prefer *anchored* (relative, within-study) contrasts; classify any
   *unanchored* recombination as **observational + low-certainty**; enforce procedural-match
   thresholds; surface batch/lab confounding explicitly; require SYRCLE-style baseline-similarity
   checks. (Rides `metaFilter` + a new "anchored?" predicate.)
4. **Human sign-off** on the matched set and every extracted number (double-extraction +
   reconciliation → the `verified_at` stamp; unverified pieces sit in the `frontier` queue).
5. **Present** the recombined dataset with an explicit **commensurability-confidence score** and
   the CGP/CCLE caveat that identical-material ≠ identical-measurement. Never render an
   unanchored between-study contrast as if it were a randomized result.

This is publishable-grade *if and only if* it refuses to over-claim. Built the other way, it's
a fabrication engine with a beautiful forest plot.

## Sources (verified primary references)

- Page et al. 2021, **PRISMA 2020** — BMJ 372:n71 / n160.
- **PRISMA 2020 flow diagram** templates — prisma-statement.org (CC BY 4.0).
- **Cochrane Handbook v6.5** — Ch. 23 (multi-arm/factorial), Ch. 13 (reporting bias), Ch. 6 (effect-size formulas).
- Pustejovsky & Tipton 2022, **CHE working models / RVE** — Prevention Science 23:425–438.
- Pustejovsky & Chen 2024, **aggregate-vs-model equivalences** — JEBS 49(6):1013–1043.
- Tipton & Pustejovsky 2015, **CR2 small-sample RVE** — JEBS 40(6):604–634.
- Harrer, Cuijpers, Furukawa & Ebert, **Doing Meta-Analysis with R** — doing-meta.guide.
- Viechtbauer, **metafor** — wviechtb.github.io/metafor (escalc, rma.mv, robust, plots).
- **clubSandwich / wildmeta / POMADE / metaselection** — Pustejovsky group R stack.
- Carter, Schönbrodt, Gervais & Hilgard 2019, **bias-method simulation** — AMPPS.
- McShane, Böckenholt & Hansen 2016, **selection models** — Perspectives on Psych Science 11(5).
- Stanley & Doucouliagos / Hilgard 2017, **PET-PEESE** conditions.
- Nakagawa et al. 2023, **orchaRd 2.0 / orchard plot** — MEE.
- McGuinness & Higgins 2021, **robvis** — Res Synth Methods 12(1):55–61.
- **MetaInsight** 2019 — Res Synth Methods (jrsm.1373).
- **GRADE / GRADEpro GDT** — gradepro.org.
- RoB 2 / ROBINS-I / AMSTAR 2 — per Kolaski et al. 2023, Systematic Reviews.

**§8 — cross-study component recombination:**
- Component NMA — Rücker et al. 2020 (Biometrical J.), Efthimiou et al. 2022 (Stat. Med. 10.1002/sim.9372), CNMA methods review (BMC Med Res Methodol 10.1186/s12874-023-01959-9). *(Not `sim.70068`, which is Spineli et al. 2025 on transitivity.)*
- Phillippo et al. 2018, **anchored vs unanchored / NICE DSU TSD 18** — Medical Decision Making 38(2):200–211 (10.1177/0272989X17725740).
- MAIC simulation 2025 — Applied Health Economics & Health Policy (10.1007/s40258-025-00952-1).
- Leek et al. 2010, **batch effects** — Nature Reviews Genetics (nrg2825).
- Haibe-Kains et al. 2013, **CGP vs CCLE inconsistency** — Nature 504:389–393 (nature12831).
- **Virtual Control Groups** — proof-of-principle (EuropePMC MED/32242633, 2020) + toxicology validation (ScienceDirect S0273230024000734 / S0273230024000333, 2024).
- Preclinical SR/MA primer — Nature Reviews Methods Primers (s43586-024-00347-x, 2024); **SYRCLE** RoB (BMC Med Res Methodol 10.1186/1471-2288-14-43); **CAMARADES** toolchain (camarades.ch/tools).
- Maelstrom retrospective harmonization — Int. J. Epidemiology 46(1):103.
- LLM extraction reliability — PMC12823200 (2025, o3/GPT-4o); arXiv 2405.14445 (GPT-4, fabrication); PLoS ONE 0313401 (ChatGPT-4o, 5.2% hallucination); automated-MA review arXiv 2504.20113.
- Experiment ontologies — **OBI** (obi-ontology.org), **EXPO** (J. R. Soc. Interface 10.1098/rsif.2006.0134).
