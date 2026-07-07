# Amends — Product Requirements Document

**Version:** 0.3
**Date:** July 6, 2026
**Status:** Pre-implementation. Supersedes v0.2 after a third adversarial review round (multi-model).
**Launch scope:** **M1 — JavaScript**: Node.js + browser (React and other popular JS frameworks).

> Naming note: the PRD version and the launch milestone are now separate tracks. The document is versioned (v0.3); launch milestones are named (M1, M2, …). "v0.1" no longer refers to two different things.

---

## 1. What Amends is

Amends is open-source remediation infrastructure that turns runtime incidents into evidence-backed GitHub pull requests, using the developer's own repo, CI, and AI agent.

**No observability required. Amends captures the minimum remediation context needed to produce a validated fix PR.**

One-line pitch: *your app makes amends for its bugs.*

Amends is not an observability platform. It does not compete for dashboards, tracing, APM, metrics, profiling, alerting, or event storage. It competes on exactly one thing: **the remediation loop after an incident exists** — incident evidence → validated fix PR. On that loop, it wins by doing what hosted platforms structurally cannot: fully self-hosted, bring-your-own agent and model gateway, GitHub-native audit trail, and a published case-file protocol.

Strategic identity, stated once:

> **Capture is commodity. Agents are commodity. Case-file compilation + the evidence gate + the GitHub-native remediation loop is the product.**
>
> The protocol is source-neutral. The product is Amends-native. ("Source-neutral internally, Amends-native externally.")

### 1.1 Non-goals

- No hosted SaaS in v1 (see §13 for the explicit commercial boundary)
- No dashboards, metrics, APM, tracing, session replay, or profiling — ever, in the OSS core
- **No third-party observability integration in M1 positioning or launch scope.** Core protocols remain source-neutral (§5.6) so future adapters can compile external incidents into Amends capture events without changing the remediation loop. Adapters are architecture, not roadmap.
- No provider issue syncing (commenting back to Sentry/GlitchTip issues, status mirroring, user import) — future consideration only; high glueware risk
- No infrastructure/IaC fixes — application code only
- No "self-healing" claims for native mobile, ever (see §12)

## 2. Core philosophy: propose, prove, ask

> **The system builds a case file, proposes a fix, validates it, and asks for permission.**

Three principles:

1. **The case file is the product.** Most production bugs are hard because context is missing, not because intelligence is missing. The case file is a versioned, published protocol (§5), not an internal format.
2. **Evidence-gated fixing.** No code-change PR without a counterfactual validation artifact — one that demonstrably fails against the resolved original revision and passes against the proposed patch (§7). Language discipline: Amends produces *validated* or *evidence-backed* fix PRs, never "proven fixes."
3. **Autonomy is a tiered, user-controlled dial.** Default mode is `pr`. The strength of the evidence sets the ceiling on autonomy; the configured mode sets the requested ceiling; the effective autonomy is the minimum of the two (§7.2). Auto-merge is an explicit opt-in. Auto-deploy is post-v1 (§7.2).

## 3. System architecture

Five stages. (v0.2 had four; COMPILE and RECONCILE are now first-class because symbolication, canonical identity, and "silence is not an event" each need an architectural home.)

```
1. CAPTURE    An SDK — or, in the future, a source adapter — emits a
              normalized capture_event (§5.1). M1 ships only Amends JS capture.

2. INGEST     Receives capture events, verifies trust class (§8.2), runs the
              shared scrub pipeline (§9), computes the provisional fingerprint
              (§5.5), updates occurrence state, creates/updates the work item,
              and emits run-requested signals when trigger thresholds cross (§8.3).

3. COMPILE    In the Action, against the repo: resolves the release to a
              repository revision (§5.4), symbolicates where possible (§6.2),
              computes the canonical Amends fingerprint (§5.5), selects the
              representative occurrence, enriches with repo context and intent
              files, and writes the case_file (§5.1).

4. FIX        The GitHub Action checks out the resolved revision, runs the
              agent adapter under guardrails (§3.4, §8), requires counterfactual
              validation (§7.1), classifies evidence mechanically (§7.2), and
              opens the PR.

5. RECONCILE  A scheduled workflow (cron): post-deploy silence detection and
              auto-close, stale thin-case closure, canonical re-key/merge of
              work items (§5.5), pass-1 instrumentation cleanup (§6.3), and
              budget rollups (§10). Exists unconditionally — absence of events
              is not an event, so no label can trigger this work.
```

### 3.1 Repository layout (monorepo)

```
amends/
├── schema/                        # THE PROTOCOL — two versioned specs
│   ├── capture-event.schema.json  # what a source emits (§5.1)
│   ├── case-file.schema.json      # capture event + compiler enrichment (§5.1)
│   ├── amends-protocol.md         # prose spec: both schemas, registries,
│   │                              # fingerprint algos, versioning policy
│   ├── examples/                  # browser-typeerror, node-api-500,
│   │                              # thin-casefile-needs-instrumentation, ...
│   └── conformance/               # scenario suite any source adapter must pass
├── sdk/
│   └── js/                        # npm: browser + Node in one package
├── cli/                           # npm: `amends init`, `amends validate-config`,
│                                  # `amends upload-sourcemaps`
├── relay/                         # self-hosted ingest template (Workers/Vercel)
├── action/                        # the GitHub Action (COMPILE + FIX + RECONCILE)
│   ├── action.yml
│   ├── prompts/                   # instrument-pass and fix-pass prompts
│   └── agents/                    # adapters: claude-code, copilot, aider, custom
└── examples/
    └── demo-app/                  # deliberately buggy Next.js app for the demo
```

Future SDKs (Python is next, §12) sit beside `sdk/js` and must pass the same conformance suite: identical scenarios in, **semantically equivalent capture events out** — equivalence is asserted over canonicalized, required, normalized fields, not byte-for-byte output (timestamps, runtime versions, key ordering, and optional context legitimately vary). The conformance suite is what lets community contributors add sources without core-team audit of their capture logic.

### 3.2 GitHub Issues: the M1 work item and the canonical index

The case file references its human-facing record through a neutral object, so the GitHub Issue is the M1 *implementation* of the work item, not the conceptual model:

```jsonc
"work_item": {
  "kind": "github_issue",        // open registry
  "id": "1234",
  "url": "https://github.com/org/repo/issues/1234",
  "external_refs": []            // future: provider issue links
}
```

Lifecycle:

- Capture event arrives → ingest computes the **provisional fingerprint** (§5.5)
- Existing open work item for that fingerprint → occurrence state updated
- New fingerprint → issue filed with the scrubbed summary, labeled `amends`
- Trigger threshold crossed → ingest emits `repository_dispatch` (or applies a `amends:run-requested` label) → the Action runs. **The label is a signal, never an authorization**: before running the agent, the Action independently re-derives eligibility — trust class, occurrence threshold, and budget — from its own recorded state. Anyone with issues:write can apply a label; nobody with issues:write can thereby spend the budget.
- After COMPILE, the Action writes a **structured metadata comment** (machine-readable, HTML-comment-delimited) into the issue containing: canonical fingerprint (algo + value), provisional-fingerprint aliases, release resolution result, occurrence snapshot, and tier. **This makes the GitHub Issue the canonical index** — the queryable mapping from canonical identity to work item that ingest and RECONCILE consult. Without this write-back, canonical fingerprints would be born and die inside Action runs.

Issues are not storage for everything:

| Concern | Where it lives |
|---|---|
| Human-facing case record, audit trail, **canonical index** | GitHub Issue (+ metadata comment) |
| Provisional dedupe + occurrence counters (concurrency-safe) | Relay state store (KV) |
| Oversized case files, raw payloads (`source.raw_ref`) | Restricted Action artifacts, keyed by fingerprint |
| Source maps | Restricted Action artifacts keyed by release revision (§6.2) |

```yaml
relay_state_store:
  default: provider-native KV where available (Workers KV, Vercel KV)
  fallback: issue-based state — EXPLICITLY LOSSY: counters approximate,
            dedupe best-effort; documented as degraded, not "slower KV"
  advanced: user-configured object/KV store
```

**Scrubbing happens before issue creation, always.** Issue bodies are visible to every repo collaborator, copied into notifications, and durable. Raw payloads live only in restricted artifacts; the issue gets the scrubbed summary. (Full privacy policy: §9.)

### 3.3 Ingest transports

**Invariant: the default production transport must not place repo-write credentials in the application runtime.**

- **Browser → relay (required).** Browsers cannot hold tokens. The relay is a minimal self-hosted ingest template — deliberately not promised as "tiny" — deployed to the user's own account via deploy button (Cloudflare Workers, Vercel). Responsibilities: receive client payloads, enforce origin allowlist / per-IP rate limits / payload caps, verify ingest keys where presented, scrub, provisionally fingerprint, dedupe via state store, and write the work item. The relay does **not** symbolicate — heavyweight source-map work belongs to COMPILE (§6.2), not an edge function.
- **Node → relay (recommended for production).** Server events carry a per-source **ingest key** (issued by `amends init`, stored as an app secret, revocable — §8.2), which grants authenticated-transport trust. One pipeline, one state store, one scrub point, no GitHub credentials on app servers.
- **Node → GitHub directly (degraded/simple mode).** Supported for development and low-stakes setups, documented as degraded, with hard constraints: the token must be a fine-grained token scoped to **issues:write only** — it cannot touch code, workflows, or PRs, which is what makes this mode defensible at all. Dedupe is best-effort (issue-based state), rate limiting is the SDK's own throttle, and — because issues:write includes labels, and labels signal runs — the Action's revalidation rule (§3.2) is the backstop that keeps this mode from being a spend-trigger. The phrase "the server SDK talks to GitHub directly" is hereby removed from the conceptual architecture; this is a documented fallback, not a peer path.

### 3.4 Bring-your-own agent, bring-your-own model backend

Two independent abstraction layers. Amends never talks to a model itself.

**Layer A — agent adapters:** Claude Code, Copilot CLI, aider, `custom` command. The adapter contract is a documented spec so the community can add adapters without core changes.

- **Inputs:** repo checkout at resolved revision, case file path, model config.
- **Outputs:** branch/diff, exit code, structured result JSON — which **must include a usage block**:

```jsonc
"usage": {
  "input_tokens": null,
  "output_tokens": null,
  "estimated_usd": null,
  "usage_source": "reported | estimated | unavailable"
}
```

Honesty rule: if an adapter cannot report usage, Amends falls back to run-count budgets and marks cost as `estimated` or `unavailable` in the accounting comment (§10). Cost accounting is a contract requirement precisely because Amends never sees the model call.

**Layer B — model backends:** each adapter routes inference to the user's choice: direct vendor APIs, **AWS Bedrock** (auth preferably via GitHub OIDC → IAM role, no long-lived keys), Google Vertex, Azure OpenAI, or **any OpenAI-compatible endpoint** (`base_url` + key) — covering internal enterprise gateways and self-hosted models.

**Enterprise/VPC note:** the Action runs on self-hosted GitHub runners inside the customer network with inference to a private gateway endpoint. Nothing assumes GitHub-hosted runners or public model APIs.

## 4. Positioning vs. hosted AI remediation (one table, then we stop talking about it)

| | Hosted platforms (e.g. Sentry Seer) | Amends |
|---|---|---|
| Control plane | Vendor-operated by default | User-operated by default |
| Model / agent choice | Vendor-controlled or vendor-mediated | Yours — BYO agent, model, gateway, runner |
| Context source | Platform telemetry | Case-file protocol + repo at resolved revision |
| Audit trail | Platform UI | GitHub Issues + PRs in your repo |
| Instrumentation | Assumes their SDK footprint | Agent adds it via PRs, compounds *(Phase 2, §6.3)* |
| Cost model | Per-seat / per-event pricing | Your own API spend, budgeted and visible |

(The former "data leaves your infra: yes/no" row is retired — it was falsifiable: GlitchTip is self-hosted and self-hosted Sentry exists. The defensible differentiator is control and auditability, not a blanket data claim.)

The roadmap must never contain "platform X has feature Y, we need Y."

## 5. The protocol — two schemas, published

The protocol has **two boundaries**, because it does two different jobs and mixing them was v0.2's biggest structural flaw:

- **`capture_event`** — what a source knows at capture time. Produced by the Amends SDK today; by other adapters in the future. Contains no repo-derived data.
- **`case_file`** — a capture event's group, enriched by the compiler with everything the repo knows: resolved revision, symbolicated frames, canonical fingerprint, diffs, intent files, validation hints.

The question "what must a third-party source produce?" now has a one-word answer: a capture_event.

### 5.1 Schemas (v0.3, versioned in /schema)

**capture_event** (abridged):

```jsonc
{
  "schema_version": "0.3",
  "source": {                              // PROVENANCE — required
    "provider": "amends",                  // open registry: amends | sentry | glitchtip | ...
    "adapter": "amends-js-sdk",
    "adapter_version": "0.1.0",
    "source_kind": "runtime_event",        // open registry
    "source_object_id": "evt_...",
    "source_group_id": null,               // provider grouping key, if any (alias only, §5.5)
    "trust": {                             // two axes — §8.2
      "transport": "ingest_key | signed_webhook | anonymous",
      "origin": "server_runtime | browser | ci_trusted_ref | human_report | provider_forwarded"
    },
    "ingested_at": "2026-07-06T14:03:00Z",
    "raw_ref": "artifact://..."            // original payload, restricted artifact
  },
  "environment": "production",             // open string; conventional values:
                                           // production, staging, preview, development
  "release": {
    "declared": "web@1.4.2",               // whatever the source knows
    "sha": "abc123"                        // native SDKs capture this directly; else null
  },
  "occurrence": {                          // ONE concrete runtime failure
    "id": "occ_...",
    "observed_at": "2026-07-06T14:00:00Z",
    "error": { "type": "TypeError", "message": "...", },
    "stack": {
      "raw": [ /* frames as captured */ ],
      "symbolicated": null,                // sources may arrive pre-symbolicated
      "symbolication": { "status": "unavailable", "provider": "none" }
    },
    "trail": [                             // kind: open registry (navigation, http, ...)
      { "t": -4.2, "kind": "navigation", "detail": "/checkout" },
      { "t": -1.1, "kind": "http", "detail": "POST /api/pay → 500",
        "observed_by": "browser_breadcrumb" }   // §8.3
    ],
    "logs": [ /* structured entries: {scope, fields, level, t} — defined by shape,
                 not by producer API */ ],
    "runtime": { "platform": "browser", "versions": { } },  // platform: open registry
    "env_meta": [ /* allowlisted env var NAMES only — §9 */ ]
  },
  "user_report": { "text": "...", "contact_optional": null }  // UNTRUSTED — §8.1
}
```

**case_file** (abridged — everything above, grouped and enriched):

```jsonc
{
  "schema_version": "0.3",
  "group": {                               // the recurring logical bug
    "fingerprints": { /* provisional aliases + canonical — §5.5 */ },
    "occurrence_count": 7,
    "first_seen": "...", "last_seen": "...",
    "affected_revisions": ["abc123"],
    "environments": ["production"]
  },
  "representative_occurrence": { /* one capture_event occurrence, selected by
                                    the compiler — the latest is not always the
                                    most representative */ },
  "related_occurrences": [],               // optional, capped — token bloat and
                                           // privacy surface both scale with this
  "release": {
    "declared": "web@1.4.2",
    "revision": "abc123",                  // the resolved repo revision
    "resolution": { "status": "resolved",  // resolved | unresolved
                    "method": "env_git_sha" /* registry: tag_rule, mapping_file,
                                               provider_release, manual */ },
    "deployed_at": "2026-07-06T14:00:00Z",
    "diff_from_last_good": "abc122..abc123"   // compiler-derived; last_good =
                                              // most recent revision with zero
                                              // occurrences of this canonical
                                              // fingerprint
  },
  "work_item": { /* §3.2 */ },
  "intent_refs": [ "intents/checkout.md" ], // compiler-resolved; never a
                                            // capture-time field
  "validation": { /* hints for the evidence gate: test command, artifact type
                     candidates */ }
}
```

Group and occurrence are defined in Amends' own language: a **group** is the recurring logical bug Amends is trying to remediate; an **occurrence** is one observed runtime failure belonging to it. (The terms are used because they are precise, not because incumbents own the category.)

All enums shown as registries are **open**: documented conventional values, extension permitted, unknown values preserved rather than rejected.

### 5.2 Context by cost tier

| Tier | Items | Provided by |
|---|---|---|
| Free (derived from repo at revision) | recent commits, lockfile dependency versions, diff from last-known-good | Compiler — sources never ship these |
| Cheap (captured at error time) | stack, route, minimal breadcrumbs, allowlisted env-var names, runtime info | Source (SDK) |
| Expensive (deliberate design) | ring-buffer logs, repro hints, product intent | Source + repo conventions |

### 5.3 Product intent files

`intents/*.md` in the repo declare invariants per route/feature ("checkout must never double-charge; degrade to cart-save on payment failure"). The compiler resolves route → intent refs; the agent must read referenced intent files before proposing a fix — this prevents "fixed the crash by removing the safety check."

### 5.4 Release resolution discipline

> **A code-change PR requires a resolved repository revision.** If the declared release cannot be resolved to a checkout, output is limited to a diagnostic comment or an instrumentation PR (targeting the default branch HEAD, clearly labeled as unverified-against-origin).

Native Amends SDKs capture a Git SHA at build time by default (`AMENDS_RELEASE=$GITHUB_SHA`). External sources may declare release names, image digests, package versions, or provider release IDs; the compiler resolves these to a revision via a **user-declared mapping** in `amends.yml` (tag rule, mapping file, or provider-release rule) — resolution is configuration, not magic.

After a fix deploys, capture reports under the new revision; when a canonical fingerprint stops appearing, RECONCILE auto-closes the issue with a comment. That observable closure is the product's proof of life — and the demo's closing shot.

### 5.5 Identity: two-stage fingerprinting

The v0.2 design (fingerprint at ingest, before symbolication) was broken: minified frames change every build, so every deploy would re-mint fingerprints, auto-close would fire on everything, and never-fix-your-own-fix would lose its identity backbone. But pure post-symbolication fingerprinting leaves the relay unable to dedupe or rate-limit. Hence two stages:

```jsonc
"fingerprints": {
  "provisional": {
    "algo": "raw-stack-v1",
    "value": "sha256:...",
    "computed_by": "relay",
    "release_scoped": true       // DELIBERATE: hash includes the release.
                                 // Cross-release identity is exclusively
                                 // canonical's job; provisional only needs to
                                 // group within one deploy.
  },
  "canonical": {
    "algo": "amends-symbolicated-stack-v1",   // versioned; Amends-owned
    "value": "sha256:...",
    "computed_by": "compiler",
    "status": "computed | pending | unavailable"
  },
  "source_aliases": [            // provider grouping keys — correlation ONLY
    { "provider": "sentry", "kind": "issue_id", "value": "12345" }
  ]
}
```

Rules:

- **The canonical fingerprint is Amends-owned identity.** Its algorithm is versioned (evolution expected — see fingerprint-stability open question); it is computed from normalized, symbolicated frames + error type + function-name normalization. Provider issue IDs and grouping keys are **aliases** — providers merge, split, and regroup issues, so they can never be identity. Not pluggable, not user-selectable.
- **Dedupe, auto-close, never-fix-your-own-fix, and cross-release logic all key on canonical identity.**
- **Merge/re-key flow (spec'd, because it is the messiest flow in the system):** the same bug across two releases produces two provisional fingerprints → two work items, until COMPILE computes canonical identity for the newer one and consults the canonical index (§3.2). On a match with an existing work item: the newer issue is closed as duplicate with a redirect comment; occurrence counts are reconciled into the surviving group (summed, with per-release breakdown preserved); the relay KV entry for the newer provisional fingerprint is re-pointed at the surviving work item; the surviving issue's metadata comment gains the new provisional alias. RECONCILE performs the same merge for any duplicates that slipped through.

### 5.6 Source adapter boundary

The case-file protocol is source-neutral. **M1 ships exactly one source: the native Amends JavaScript SDK.** Future adapters may compile other incidents into capture events. Two future adapter shapes are named so the protocol does not preclude them — **neither is launch scope, neither is committed:**

1. **Sentry-envelope-compatible ingest endpoint** — apps already instrumented with Sentry-compatible SDKs point their DSN at the Amends relay. Highest leverage, deceptively expensive: compatibility is a surface area, not a parser.
2. **Provider webhook/API import** — an existing Sentry/GlitchTip/Bugsink install forwards selected issues/events. Smaller, additive.

Adapter contract (the entire surface for a community adapter):

- Produce a valid `capture_event` (conformance suite enforces semantic equivalence).
- Declare a trust class on both axes (§8.2); webhook adapters must implement signature verification, and unsigned webhooks are `anonymous` transport regardless of provider.
- Normalization only — adapters never scrub (the shared pipeline does, on every source including external ones), never fingerprint canonically, never touch the repo.

**Mapping is intentionally lossy.** `capture_event` is designed on Amends' terms; provider payloads map into it with loss, and `source.raw_ref` preserves the original in a restricted artifact. The alternative — shaping the schema so provider envelopes map losslessly — would silently import a provider's event model as the protocol. This is decided; adapter PRs do not relitigate it.

Source adapters are not observability integrations. They do not make Amends a dashboard, event store, tracing system, or alerting tool. They translate an incident into a remediation case.

### 5.7 Protocol strategy (honest version)

Publishing a schema does not create a moat; other tools emitting it does. The spec ships with both JSON Schemas, a prose spec, worked examples, conformance tests, and a versioning policy — so that SDKs, self-hosted error tools, coding agents, and CI tools have a low-friction reason to emit or accept it. Necessary, not sufficient; the loop has to be worth joining first.

## 6. Capture (M1: JavaScript — Node + browser)

Real codebases have few logs and poor error handling. Amends does not require either — but the M1 SDK is **brutally scoped**. The schema is the product; the SDK is a thin emitter of capture events.

### 6.1 M1 SDK capture list (complete — everything else is later)

- Unhandled errors: `window.onerror`, `unhandledrejection` (browser); `uncaughtException`, `unhandledRejection`, framework middleware for Express/Next/Fastify (Node)
- React error boundary component (`<AmendsErrorBoundary>`) for render-path errors
- Release SHA (injected at build: `AMENDS_RELEASE=$GITHUB_SHA`)
- Current route/path (route templates over raw URLs where the framework exposes them)
- Minimal breadcrumbs: navigation events + last N HTTP request paths/statuses (via fetch/XHR wrap), each tagged with `observed_by`
- User-report widget: text box + optional contact, attached to the active case
- `amends.log(scope, fields)` — structured, high-priority in the case file
- Scrub-by-default pipeline participation (§9)
- Ring buffer (~100 events, in-memory, serialized only on error)

**Explicitly NOT in M1:** broad `console.*` capture, input values, request/response bodies, click/keystroke trails, OpenTelemetry bridging, session tracking. Each returns only with a privacy review.

### 6.2 Source maps: Phase 1 plumbing, symbolication in COMPILE

Browser is in scope, so symbolication is core: unsymbolicated minified frames make the flagship demo fail on any real app.

- Build step: `amends upload-sourcemaps --release $GITHUB_SHA ./dist` (CLI package, §3.1), or the user's CI workflow uploads maps as part of its existing build
- Storage: restricted GitHub Action artifacts keyed by release revision (default); user-configured private storage (advanced). Artifact retention limits are documented; expired maps degrade symbolication status to `unavailable`, they do not break the loop
- **Symbolication happens in COMPILE**, where the maps live and compute is cheap — never in the relay (edge CPU/memory limits make per-error source-map parsing a non-starter)
- Sources that arrive pre-symbolicated (future adapters) skip the pipeline: `stack.symbolication.status` + `provider` say so
- Maps are never public, never attached to issues

### 6.3 The two-pass instrumentation loop (Phase 2, designed for now)

Instrumentation is a first-class **output** of the loop:

1. Case file too thin → agent cannot meet the evidence gate.
2. **Pass 1 — instrumentation PR:** agent states its top 2–3 root-cause hypotheses in the PR description and adds only the `amends.log()` calls that discriminate between them. Log-only diffs are low-risk, fast to approve, and build reviewer trust before the agent touches logic.
3. Recurrence returns the same canonical fingerprint with richer data.
4. **Pass 2 — fix PR:** counterfactual artifact + fix + mechanical cleanup of pass-1 logging (`keep_instrumentation: true` retains it).

Budgets: never loop pass 1 (`max_rounds: 1`); still thin after one round → escalate to a human with the hypotheses; fingerprint never recurs → RECONCILE closes it after `thin_case_stale_days` with an explanation.

Long-run identity: **a system that makes codebases progressively more diagnosable, and fixes what it can validate.** Instrumentation compounds into exactly the logging real failures demanded.

## 7. Evidence-gated fixing and autonomy tiers

### 7.1 The gate

> A code-change PR requires a **counterfactual validation artifact**: one the Action has verified to FAIL against the resolved original revision and PASS against the proposed patch. Both runs happen in CI, not on the agent's word.

**Environment-invariance rule:** the two verification runs may differ **only in the code diff under test** — same pinned toolchain, same compiler/test configuration, same seeds, network-isolated. An artifact that "passes" because the patch also loosened `tsconfig` or swapped a test runner is a fake counterfactual, and the verification job rejects diffs that touch verification configuration.

The artifact type is secondary; the counterfactual check is primary. Acceptable artifacts: unit test, integration test, Playwright/user-flow test, API replay script, fixture-based regression test, build/typecheck reproduction. **Build/typecheck reproductions are capped at Tier 1** — the shipped revision built by definition, so a static repro only demonstrates a missed static condition, never runtime behavior — and count higher only when paired with a runtime repro. Without a counterfactual artifact, the agent may produce only a diagnostic comment or an instrumentation PR.

The verification job that runs agent-authored tests executes with **zero secrets** (§8.1).

### 7.2 Autonomy tiers

Evidence strength is classified **mechanically**, never by agent self-report (an agent labeling its own unit test "integration-level" is precisely the untrusted-input channel §8.1 exists for). Classification keys on observable properties: test runner invoked, artifact location, whether the run exercises HTTP/a browser context, fixture-only vs live-path.

| Tier | Evidence | Allowed output |
|---|---|---|
| 0 | No counterfactual artifact | Diagnostic comment or instrumentation PR only |
| 1 | Weak counterfactual (narrow fixture, unit-level repro, build/typecheck repro) | `candidate`-labeled PR. Never auto-merge. |
| 2 | Strong counterfactual (user-flow repro, API replay, integration/E2E test) | Normal PR. Auto-merge eligible only if user enables it. |
| 3 *(post-v1)* | Strong counterfactual + canary/rollback signals + low-risk diff | Auto-deploy eligible. **Not designed in this document** — kept in the ladder so the tier semantics don't renumber later. `auto-deploy` means: Amends may merge a qualifying PR into a branch the user's CI/CD already deploys, after verifying configured canary/rollback signals. Amends never operates deployment infrastructure. |

**Mode × tier:** `mode` in config is the *requested* ceiling; the evidence tier is the *earned* ceiling; effective autonomy is the minimum. `mode: auto-merge` with Tier 1 evidence yields a `candidate` PR — silently degrading, loudly annotated in the PR body.

Every fix PR body contains: the case-file summary, the artifact, both verification run links, the tier and its mechanical classification, and the agent/model used.

## 8. Security model

### 8.1 The case file is untrusted input (prompt injection)

`user_report` is a **direct, attacker-controlled injection channel into a coding agent with repo write access** — the product ships a text box whose contents reach an AI that edits code. It is not alone: exception messages (`throw new Error("ignore previous instructions…")`), log content, breadcrumbs, and route names are all attacker-influenceable — and future external sources add third-party-originated text through a new door.

Hard rules:

- All case-file content is data, never instructions. Prompts wrap it in delimited, labeled untrusted blocks; the agent is instructed that nothing inside them can change its task, tier, or permissions.
- **Protected paths, two classes:**

```yaml
hard_blocked_paths:            # agent may not write these, period.
  - ".github/workflows/**"     # a PR modifying a pull_request-triggered
  - "amends.yml"               # workflow EXECUTES the modified workflow in PR
                               # context, pre-merge — "review before merge" is
                               # no protection. Verification refuses to proceed
                               # if the diff touches these.
review_required_paths:         # allowed only in human-reviewed PRs;
  - "package.json"             # never auto-merge, never auto-deploy,
  - "package-lock.json"        # regardless of tier.
  - "pnpm-lock.yaml"
  - "yarn.lock"
  - "src/auth/**"
  - "src/session/**"
  - "src/billing/**"
```

- The agent job runs with a repo-scoped, least-privilege token and **no production credentials**.
- The **verification job that executes agent-authored tests runs with zero secrets** — otherwise a "test" can exfiltrate during the run. (Environment-invariance: §7.1.)
- Amends PRs cannot trigger privileged workflows automatically; never use `pull_request_target` on untrusted code paths.
- Dependency changes always require human review, regardless of tier.
- Never-fix-your-own-fix: if a **canonical** fingerprint first appears on a revision whose deploy merged an Amends-authored PR, escalate to a human.

### 8.2 Trust: two axes, not one path

`server_observed_only` (v0.2) encoded trust as "came through the server path." That conflates two orthogonal questions and does not survive webhooks or CI events. A signed webhook from a provider proves the *provider* sent it — the event inside may still be browser-originated, attacker-influenceable data the provider faithfully forwarded. Trust is therefore declared on two axes:

```yaml
trust:
  transport:            # is the sender who it claims to be?
    ingest_key: authenticated       # per-source key, issued by `amends init`,
                                    # stored as app secret, revocable
    signed_webhook: authenticated
    anonymous: unauthenticated      # browser, unsigned webhook
  origin:               # where did the signal originate?
    server_runtime: high
    ci_trusted_ref: high            # CI on main/protected branch — NOT fork PRs,
                                    # which execute attacker-authored code
    browser: low
    human_report: low
    provider_forwarded: inherits the underlying origin, never the transport
```

Escalation (`immediate:` triggers, §8.3) requires **authenticated transport AND high origin**. Events with no ingest key are automatically anonymous/low. The relay is a public endpoint — origin allowlists do not authenticate non-browser clients, and per-IP rate limits do not stop distributed junk; event authenticity for anonymous browser traffic is an acknowledged, unsolved limit of all browser telemetry, which is exactly why it can never escalate and why budgets are trust-partitioned (§8.3).

### 8.3 Triggering and budget protection

Untrusted text must never control spend or priority — and untrusted *volume* must never exhaust it.

```yaml
triggers:
  min_occurrences: 3            # crossing emits repository_dispatch /
                                # run-requested label; Action revalidates (§3.2)
  environments: ["production"]  # default: preview/staging noise never spends
  immediate:                    # severity escalation
    require_trust:
      transport: authenticated  # HARD requirement — both axes
      origin: high
    routes: ["/checkout/*", "/billing/*", "/auth/*"]
    error_classes: ["PaymentError", "AuthError", "DataLossError"]
    http_signals:               # a 502/503 usually originates at proxy/infra
      status_codes: [500, 502, 503]        # layers the app SDK never observes;
      observed_by: ["server_runtime"]      # observed_by says who actually saw it
  untrusted_user_text:
    may_enrich_case_file: true
    may_trigger_agent_run: false
    may_raise_priority: false
```

**Trust-partitioned budget (anti-starvation):** an attacker who can fabricate plausible browser errors past `min_occurrences` doesn't just spend money — once the daily run cap is hit, they *starve real bugs*, turning the cost cap into a remediation-DoS lever. Therefore:

```yaml
cost_controls:
  max_agent_runs_per_day: 10
  reserved_for_high_trust: 5    # low-trust fingerprints can never consume
                                # these; high-trust runs draw from either pool
  max_agent_runs_per_fingerprint_per_day: 1
  cooldown_minutes_per_fingerprint: 180
```

When the shared pool is contended, high-trust fingerprints schedule first.

## 9. Privacy defaults

Scrub-by-default: the **shared scrub pipeline** runs before anything leaves the app (SDK-side), again at ingest on every source — including future external adapters, whose providers' own scrubbing is config-dependent and not to be relied on — and its output is what reaches issue bodies:

- Never capture input values; capture that an input event occurred at most
- Scrub URL query params by default; route templates over raw URLs where possible
- Headers by allowlist only; request/response bodies only by explicit opt-in (not in M1 at all)
- Hash or redact user identifiers; PII pattern scrubbing (emails, cards, tokens) on all text fields including user reports
- Route-level denylist defaults: checkout, billing, account, auth, health
- Field-level redaction rules configurable in `amends.yml`
- Payload size caps enforced client-side before submission
- **Env vars: allowlisted names only, never values.** Names alone leak infrastructure shape (`STRIPE_WEBHOOK_SECRET` as a *name* is information) into issue bodies visible to every collaborator — so even names are opt-in via allowlist, not capture-all
- Issue bodies get the scrubbed summary; raw payloads live only in restricted artifacts

## 10. Cost controls (first-class guardrail)

Every agent run spends the user's money, and error volume is partially attacker-controlled. `max_prs_per_day` caps visible output, not spend; the run budget caps spend; the trust reserve (§8.3) protects the budget's purpose.

```yaml
cost_controls:
  max_agent_runs_per_day: 10
  reserved_for_high_trust: 5
  max_agent_runs_per_fingerprint_per_day: 1
  cooldown_minutes_per_fingerprint: 180
  max_case_kb: 200                    # size-based: tokenizer-neutral across backends
  max_monthly_estimated_usd: 100      # enforced from adapter-reported usage where
                                      # usage_source is reported/estimated; run-count
                                      # budgets are the floor when unavailable
  require_manual_approval_after_budget_exceeded: true
```

Visible accounting — every agent invocation posts an issue comment with: agent/model used, the adapter usage block (§3.4) including `usage_source`, why the run was allowed (which trigger, which trust class, which budget pool), and remaining daily budget. RECONCILE posts budget rollups. Docs include a plain "what this costs" page. Surprise-billing an open-source user's API account is a launch-killing failure mode.

## 11. Configuration (consolidated)

```yaml
# amends.yml
agent: claude-code              # claude-code | copilot | aider | custom
model:
  provider: bedrock             # anthropic | bedrock | vertex | azure | openai-compatible
  model_id: anthropic.claude-sonnet-4-6
  region: us-east-1
  # base_url: https://llm-gateway.internal.corp/v1   # openai-compatible
  # credentials via repo secrets or OIDC — never in this file

mode: pr                        # issue-only | pr | auto-merge
                                # (auto-deploy: post-v1, §7.2; mode is the
                                # requested ceiling — evidence tier can lower it)

release_resolution:             # §5.4 — required for non-SHA declared releases
  method: env_git_sha           # env_git_sha | tag_rule | mapping_file
  # tag_rule: "v{version}"
  # mapping_file: .amends/releases.json

triggers: { ... }               # §8.3
cost_controls: { ... }          # §10 — spend budgets
limits:                         # output + blast-radius (distinct taxonomy from spend)
  max_prs_per_day: 5
  max_files_changed: 10

hard_blocked_paths: [ ... ]     # §8.1
review_required_paths: [ ... ]  # §8.1

instrumentation:
  enabled: true
  keep_instrumentation: false
  max_rounds: 1

close:                          # two policies — they mean different things
  fixed_fingerprint_silence_days: 7     # post-fix-deploy silence → auto-close
  thin_case_stale_days: 14              # thin case never recurred → close w/ explanation
```

## 12. Platform strategy

| Layer | Cross-platform? |
|---|---|
| capture_event + case_file schemas + conformance suite | Yes — the protocol |
| Compiler + fix agent + validation + PR workflow | Yes — operates on a repo |
| Capture SDK / source adapters | Per-source, thin, conformance-tested |
| Symbolication | Per-platform (source maps now; dSYM/R8 later); state carried in-schema |
| Deploy observation | Breaks on native mobile |

- **M1: JavaScript** — Node servers + browser (React first-class via error boundary; framework middleware for Express/Next/Fastify). Full loop closes.
- **M2: Python** (Django/Flask/FastAPI). Architecturally the cheapest addition — server-side ingest-key transport, no symbolication (tracebacks are readable, `symbolication.status: unavailable` by design), capture is `sys.excepthook` + middleware. The compiler and agent layers are unchanged. Shipping a second source against the conformance suite is what proves the schema is a protocol, not an implementation detail.
- **Later: native mobile** — positioned as **"self-diagnosing"** only (validated PR waiting in the repo). The loop cannot close through App Store/Play review latency. Pass-1 instrumentation only where OTA updates exist (Expo Updates; JS layer only).

## 13. Commercial boundary

**The OSS product must be fully usable, forever, for: one repo, one relay, one GitHub integration, one BYO agent.** No feature required for that loop will be withheld or degraded.

A future hosted product may offer convenience on top: managed relay, artifact/source-map storage, org-level policy and approvals, multi-repo grouping, compliance logs, spend dashboards. None of it is being built now; declaring the boundary now prevents the OSS audience from feeling tricked later.

License: Apache-2.0 (patent grant matters in this space).

## 14. Build order (fix orchestration first)

The hardest, most valuable component is proven first, in isolation, against hand-written inputs:

1. **GitHub Action** that takes a *hand-written sample case file* and produces an evidence-gated PR (counterfactual verification with environment-invariance, mechanical tier classification, protected-path classes, zero-secret test job)
2. Both schemas + examples + conformance suite (semantic equivalence)
3. Demo app (Next.js) with deliberate production bugs
4. **CLI**: `amends init` (scaffolds workflow, `amends.yml`, ingest keys), `validate-config`
5. Minimal JS SDK per §6.1 — Node first via degraded direct mode (issues-only token) for development speed; relay-recommended path lands at step 7
6. COMPILE stage: release resolution, source-map upload (`amends upload-sourcemaps`) + symbolication, canonical fingerprinting + index write-back
7. Relay template + KV state + ingest keys (browser path complete; Node recommended path complete)
8. Issue lifecycle: provisional dedupe, occurrence state, threshold dispatch, merge/re-key
9. RECONCILE scheduled workflow: auto-close (both policies), duplicate sweep, budget rollups
10. Diagnostic mode output when the evidence gate can't be met
11. Cost accounting comments (adapter usage contract)
12. *(Phase 2)* instrumentation loop, additional agent adapters, Python SDK

**The make-or-break demo:** bug deployed → error captured with release SHA → issue filed → threshold crossed → Action resolves + checks out the bad revision → agent writes an artifact that fails there → fixes code → artifact passes → PR opens with case file + both verification runs + tier → merge/deploy → new release stops producing the canonical fingerprint → RECONCILE auto-closes the issue.

## 15. Success metrics

- Time from `npx amends init` to first validated PR on the demo app (target < 30 min)
- % of agent runs that meet the evidence gate (tier ≥ 1)
- % of fix PRs merged without modification
- Canonical fingerprints auto-closed after fix deploy (loops observably closed)
- Duplicate work items per canonical fingerprint (merge/re-key health — should trend to ~1)
- Instrumentation PRs approved vs. rejected (trust signal)
- Mean agent spend per closed fingerprint; % of runs with `usage_source: reported`
- Adoption proxies: installs, stars, third-party schema emitters (the protocol metric)

## 16. Decisions taken this revision, and open questions

**Decided (recorded so they are reversible deliberately, not relitigated accidentally):**

1. Node's recommended production transport is the relay/ingest endpoint; direct-to-GitHub survives only as a documented degraded mode with an issues:write-only fine-grained token and Action-side trigger revalidation.
2. Tier 3 / auto-deploy stays defined in the ladder, marked post-v1; no canary/rollback design in this document.
3. Provisional fingerprints are deliberately release-scoped; cross-release identity is exclusively canonical.
4. The canonical index lives in issue metadata comments (GitHub as the index). Alternative considered: a mapping file committed to a branch — rejected for now (write contention, noisy history); revisit if metadata comments prove fragile.
5. §5.6 names both Sentry-compatible adapter shapes as future possibilities and commits to neither.
6. Provider grouping keys are aliases, never identity. Not pluggable.
7. capture_event → case_file mapping from external sources is intentionally lossy, with `raw_ref` preservation.

**Open:**

1. Canonical fingerprint algorithm details: function-name normalization rules, framework-frame filtering, and the migration path when `amends-symbolicated-stack-v1` → `v2` re-keys existing groups.
2. Monorepos: `amends.yml` per package vs per repo; agent checkout scoping; release identity when one repo ships multiple deployables.
3. Should pass-1 instrumentation PRs ever auto-merge by default (log-only diffs), or does that undermine the trust-building ritual?
4. OIDC recipes beyond AWS: Vertex and Azure equivalents, documented end-to-end.
5. Relay state fallback semantics: exactly which behaviors degrade (documented per-behavior) when no KV is available.
6. React Native / Expo: is the OTA-updatable JS layer close enough to browser semantics to ride the JS SDK, or is it its own capture target?
7. Issue-comment accounting granularity: per-run comments could get noisy on chatty fingerprints — collapse into an edited summary comment maintained by RECONCILE?
8. Ingest key lifecycle details: rotation cadence, multi-environment keys, key-per-service vs key-per-repo.
9. Same-day registrations still pending: npm org, GitHub org, `amends.dev`.
