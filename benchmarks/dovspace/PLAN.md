# Dovspace-Bench Lite v0.1: design and verification protocol

## Purpose and scope

Measure independently verifiable work against a small, entirely fictional PM + document + TypeScript environment. The unit of evaluation is a task outcome, not a model's final message or an Agent generation status. This package is separate from the running product and does not create implementation-tracking business tasks, approvals, or benchmark UI pages.

v0.1 includes twelve versioned definitions, the six-case smoke selection, real isolated PM authority, the existing Agent Chat integration, Raw/Knowledge/Dovspace arms, cross-session interventions, independent graders, hard safety gates, admission-time budgets, explicit calibration, and JSON/Markdown evidence. The ordinary run path never substitutes a deterministic reference driver for a missing model.

Out of scope: dashboards, production workloads/data, public leaderboards, automatic publishing, a replacement Session/Run persistence model, multiple vendor/plugin implementations, and a general-purpose production Agent sandbox. Future vendor/plugin expansion is a separate phase, not an unimplemented success path inside v0.1.

## Architecture decisions

1. **Reuse the current product authority.** Markdown is authoritative for PM core objects and relationships. A dedicated PostgreSQL instance owns identity, authorization, receipts, events and other PM facts. Agent Chat keeps its own private persistence; no cross-store atomic transaction or unified persistence model is asserted. See the [Markdown ADR](../../docs/architecture/adr/0003-markdown-core.md), [context](../../docs/architecture/context.md), and [Agent guide](../../docs/guides/agent-chat.md).
2. **Use real isolation, not cwd as a sandbox.** The host supervisor alone can see grader/reference code and PM authority. Each tested runtime has a separate OS/container boundary, private Agent state, a public fictional work area, and a capability-limited PM/provider broker. It receives no Docker socket, PostgreSQL credentials, host HOME, production endpoint, or benchmark gold/grader mount. Submitted code executes separately from the trusted grader.

   The outer Agent container deliberately relaxes Docker seccomp/AppArmor/system-path masks (`seccomp=unconfined`, `apparmor=unconfined`, `systempaths=unconfined`) to permit the inner native Bubblewrap namespace/mount/proc boundary. Native descendants inherit those reduced kernel filters; Bubblewrap does not restore them. Nonroot, network-none, read-only, private PID, capability-drop-all and no-new-privileges remain required; privileged mode, SYS_ADMIN and host namespaces/authority/socket mounts remain forbidden. Actual effective policy and inner denial probes are recorded and hashed into environment/proof evidence. The separate Node code grader retains default Docker profiles. This is a defense-in-depth reduction with increased kernel attack surface, not production multi-tenant certification.
3. **Keep operation identity.** Every PM access has an explicit actual workspace/project/entity target. Writes preserve revision and original operation identity. An unknown response must be reconciled against the original receipt before further writes; it is not permission to repeat the write under another ID.
4. **Use matched fresh resets.** Each task/arm/repeat receives a newly provisioned database, directories and Agent state. Raw source content must have the same semantic reset hash despite different real IDs/timestamps. Budget and permission hashes are compared within each task; provider/model/options and actual `environmentHash` values are fixed across the entire experiment. Environment evidence binds immutable image identities, the staged dirty product-source byte manifest and lockfile hash, not merely Git HEAD. Effective model-request settings hashes are also compared whenever actual model evidence exists; an observed call with missing proof cannot establish fair effective settings. Missing/unavailable proof or changed environments invalidates comparison. Arm order rotates within serial matched blocks.
5. **Materialize the treatment; keep raw access equal.** All three arms use the same real Agent Chat/runtime/tool capabilities and original documents. Raw receives no generated knowledge/context. Knowledge and Dovspace receive `.dovspace/knowledge-index.json` (source paths, headings, exact passages and content hashes) plus executable lexical retrieval through `node .dovspace/search.mjs QUERY`, built from supplied sources without answer-key selection. Dovspace additionally persists its own model-authored PM plan/handoff and receives `.dovspace/resume-context.json` after a checkpoint, derived only from that run's prior artifacts and independently verified original authorized receipts. A distinct resumed Session can reuse the index and persisted context; native chat cursors/messages are not copied. Raw retains its own original files/handoffs and equivalent tool rights. No prior arm's state, hidden evaluator or gold answer is shared. This compares real materialized knowledge/workflow support, not a separate external raw CLI or an invented product memory service.
6. **Separate control, observation and grade.** Limits are enforced by the runtime/provider transport before further work is accepted. Usage comes from observable trusted records; missing values remain null. Independent graders inspect authority, artifacts, code execution and trusted process transitions; model self-reports are not evidence of successful PM writes or interruption.

## Task matrix and proof obligations

The canonical runnable v0.1 smoke selection is **K02 K03 D01 D02 L02 L04**. The other six are complete task definitions, not executable implementations in v0.1; CLI execution rejects them before fixture mutation rather than substituting an easier task. Executable grading for all twelve belongs to the separate next-phase scope.

| ID | Definition | Primary independent obligation | Smoke |
| --- | --- | --- | --- |
| K01 | Fragmented knowledge organization | Organize thirty noisy/duplicate/stale notes into a structured KB/index/needed ADRs with fact coverage, deduplication and provenance | No |
| K02 | Historical decision tracing | Correct currently effective choice, temporal change order and reasons, with supporting citations rather than obsolete authority | Yes |
| K03 | Knowledge update and conflict handling | Apply new evidence to the current KB, retain explicitly superseded history and preserve unrelated knowledge | Yes |
| K04 | Cross-Session knowledge reuse | A related development task reuses saved constraints, decisions and failed-attempt evidence without repeating known invalid work | No |
| D01 | Requirement-to-project planning | Requirement coverage, nonduplicate actual PM issues, valid dependencies and verifiable acceptance criteria plus retained plan artifact | Yes |
| D02 | Issue-to-real-feature implementation | Hidden feature fail-to-pass and regression pass-to-pass execution against actual TypeScript changes and Issue/code consistency | Yes |
| D03 | CI diagnosis and knowledge retention | Diagnose and actually repair a reproducible CI defect without hiding errors; store evidence-backed incident knowledge | No |
| D04 | Cross-Agent/Session development handoff | A new Session finishes partial code/tests, preserves correct decisions and avoids invalid repeated work with complete handoff | No |
| L01 | Requirement-to-complete-feature delivery | Executable plan, implementation, functional tests, consistent docs and authorized PM synchronization | No |
| L02 | Interruption, compression and recovery | Real interruption/new Session/context compression/lost response; original identity and receipts reconciled without duplicate completed work | Yes |
| L03 | Mid-development requirement change | Replan for a changed constraint, retain still-valid work, meet the revised objective and expose observed rework | No |
| L04 | Multi-stage cross-Session full delivery | Requirements, KB research, decision, actual Issue, plan, code/tests/review/docs/PM/final artifacts; at least two Sessions and a real interruption/handoff | Yes |

Each task exposes an instruction, actual target manifest, allowed tools, budget, phases and required evidence. Hidden grader implementations/reference answers never enter the tested Agent mount. Task text and versions are available through `bench:list --json` and `tasks/index.ts`; this table is an overview, not a second authoritative task definition.

## Scoring and measurement

- **Knowledge:** current facts, exact original quotations, provenance, and separation of superseded history. No answer-as-source circular citation.
- **State:** real PM authority and receipts before/after the run, scoped mutation expectations, preserved unrelated objects and relationships. Output JSON claiming a write is not authority.
- **Code:** a real isolated execution of hidden functional and regression tests plus integrity checks. The unmodified Retry-After baseline must fail the feature tests while retaining regression passes; the correct reference must pass both.
- **Process:** trusted transport/runner records of interruption acknowledgement, different Session identity, interventions and original-operation reconciliation. Merely writing “resumed” does not count.
- **Safety:** any required safety failure, unauthorized/unrelated mutation, destructive boundary violation, unresolved unsafe operation, or invalid code integrity vetoes final success regardless of checkpoint credit.

`success` is true only when all required independent checks and the safety gate pass. Checkpoint score is descriptive partial credit, never a substitute for success. All attempted runs stay in the primary denominator, including task, model, platform and grader failures. Detailed underlying failure kinds are retained.

**Human intervention** means an unplanned human instruction/approval supplied to the tested Agent after launch; scheduled response loss, concurrent edits, decision changes and Session changes are runner controls, not human assistance. **v0.1 rework is a narrow failed-PM-retry proxy:** repeat failures with identical normalized tool/target/revision/arguments and unchanged authority revision. Read-only receipt recovery and intentionally lost-response original operations are excluded. The numerator counts qualifying repeats; the denominator counts attributable completed PM mutation attempts. Aggregate proportion is total count / total denominator only with complete observations and a positive denominator; otherwise null with observation coverage. It does not measure all semantic/code rework, extra tokens/tool calls, or claimed revisions, and must not be presented as total human effort.

Token/cost totals are null when any required observation is missing; known subtotals and observation coverage remain separately available. USD per verified success includes failed-attempt costs and is null for zero successes or incomplete cost data. User-supplied price schedules and reservation caps are controls, not a supplier invoice. n=2–3 repeats are smoke-scale observations; descriptive rates/intervals cannot establish general superiority or production readiness.

## Verification protocol

The main integrator, after all owned slices land, runs the checks in the [README](README.md). No green result is claimed by this design document.

1. Exercise help/list and invalid task/arm/model/budget cases before runtime mutation.
2. Reset three sequential isolated real fixtures. Require identical semantic hashes and different real identities; confirm guarded destruction only touches owned resources.
3. Probe the actual Agent/code boundaries: no grader/gold/host HOME/authority/database/Docker socket, no production host network, no symlink/hardlink artifact escape.
4. Run explicit grader calibration: complete references pass; incomplete, stale, fabricated, unsafe and code-cheating artifacts fail for their intended reason. Retain baseline feature-fail/regression-pass evidence.
5. Run all six smoke cases against an explicitly configured real fixed model, then matched Raw/Dovspace (optional Knowledge) repetitions with identical settings, limits and permissions. Missing provider access is a recorded prerequisite failure, not an excuse to relabel calibration as model evaluation.
6. Inspect every admitted run's result/trace/Markdown/PM diff/Git diff, safety gate, usage nulls, detailed error evidence and redaction. Regenerate experiment reports without starting inference.
7. Keep observed outcomes separate from prerequisites, skipped/unrun cases and implementation claims. The product's live Web/PM service is neither restarted nor validated by a benchmark-only change.

## Methodology references and licensing provenance

Checked **2026-11-10** against the following pinned repository revisions and available pinned root license texts. These are **methodology references only**: no upstream code, tasks, prompts, datasets, gold artifacts or evaluator implementations were imported. All benchmark fixtures and cases here are original synthetic material under the repository's own [AGPL-3.0-only license](../../LICENSE). A repository root software license does not establish redistribution permission for a separately hosted dataset.

| Reference (pinned source) | Commit SHA | Observed root license / restriction |
| --- | --- | --- |
| [MemoryArena](https://github.com/ZexueHe/MemoryArena/tree/6cd9de14b71915e39ac742a20dc33785e14b6aab) | `6cd9de14b71915e39ac742a20dc33785e14b6aab` | No detected license; license endpoint absent. **Do not copy.** |
| [LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2/tree/2cc8c540bdb87fe6761629b585e727e1c4704520) | `2cc8c540bdb87fe6761629b585e727e1c4704520` | [Apache-2.0](https://github.com/xiaowu0162/LongMemEval-V2/blob/2cc8c540bdb87fe6761629b585e727e1c4704520/LICENSE) |
| [TheAgentCompany](https://github.com/TheAgentCompany/TheAgentCompany/tree/98b68ef82a47690c316f42fddb05baafaab56851) | `98b68ef82a47690c316f42fddb05baafaab56851` | [MIT](https://github.com/TheAgentCompany/TheAgentCompany/blob/98b68ef82a47690c316f42fddb05baafaab56851/LICENSE) |
| [FeatureBench](https://github.com/LiberCoders/FeatureBench/tree/08b25d95421f65d4600d387c5cf74e5bb3756a20) | `08b25d95421f65d4600d387c5cf74e5bb3756a20` | [MIT](https://github.com/LiberCoders/FeatureBench/blob/08b25d95421f65d4600d387c5cf74e5bb3756a20/LICENSE) |
| [AppWorld](https://github.com/StonyBrookNLP/appworld/tree/42b5bcf3cd334fee33f0c37c02070a9f5807add5) | `42b5bcf3cd334fee33f0c37c02070a9f5807add5` | [Apache-2.0](https://github.com/StonyBrookNLP/appworld/blob/42b5bcf3cd334fee33f0c37c02070a9f5807add5/LICENSE) |
| [MCPMark](https://github.com/eval-sys/mcpmark/tree/cd45b7f57923b9b3985467f5139927575f83141c) | `cd45b7f57923b9b3985467f5139927575f83141c` | [Apache-2.0](https://github.com/eval-sys/mcpmark/blob/cd45b7f57923b9b3985467f5139927575f83141c/LICENSE) |
| [KNOWS-benchmark](https://github.com/alexgill321/KNOWS-benchmark/tree/fb55a8cd3cb3bf01991c76b158725995f0b26584) | `fb55a8cd3cb3bf01991c76b158725995f0b26584` | [Apache-2.0](https://github.com/alexgill321/KNOWS-benchmark/blob/fb55a8cd3cb3bf01991c76b158725995f0b26584/LICENSE) |
| [frontier-evals](https://github.com/openai/frontier-evals/tree/b78dab1da774a6456b1ed9c48c9ff194ee3ff36d) | `b78dab1da774a6456b1ed9c48c9ff194ee3ff36d` | [MIT](https://github.com/openai/frontier-evals/blob/b78dab1da774a6456b1ed9c48c9ff194ee3ff36d/LICENSE.md) |
| [AgentDojo](https://github.com/ethz-spylab/agentdojo/tree/089ed468cf3ed0322acc66b0211f26d9d90dbf60) | `089ed468cf3ed0322acc66b0211f26d9d90dbf60` | [MIT](https://github.com/ethz-spylab/agentdojo/blob/089ed468cf3ed0322acc66b0211f26d9d90dbf60/LICENSE) |
| [MCP conformance](https://github.com/modelcontextprotocol/conformance/tree/c37eec888e1c6ff140af79987a40008548b7cc5f) | `c37eec888e1c6ff140af79987a40008548b7cc5f` | [Mixed transition](https://github.com/modelcontextprotocol/conformance/blob/c37eec888e1c6ff140af79987a40008548b7cc5f/LICENSE): Apache-2.0 for new/consented code, retained MIT for unconsented originals, CC-BY-4.0 for non-spec documentation. Not blanket MIT. |

Concrete inspirations are limited to layering agent/environment/memory (MemoryArena), result-first evaluation with secondary subcheckpoints (TheAgentCompany), validating actual code patches (FeatureBench), versioned real tool environments (MCPMark), and step-level evaluator failure analysis (KNOWS). KNOWS evaluates real Google Workspace document/spreadsheet/slide artifacts with programmatic and optional LLM/VLM rubric checks; this package neither imports those tasks nor claims to implement that service integration. License findings are provenance, not blanket approval to redistribute upstream datasets or publish a benchmark leaderboard.
