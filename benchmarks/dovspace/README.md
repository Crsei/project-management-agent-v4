# Dovspace-Bench Lite v0.1

A small, original synthetic benchmark for grounded knowledge work, real PM planning, TypeScript delivery, and interrupted cross-Session work. It drives the existing **Agent Chat** and independently checks artifacts and actual PM authority. A finished generation, a CLI exit, checkpoint credit and business task completion are different facts.

**Scope:** twelve complete task definitions; **six executable v0.1 cases: K02 K03 D01 D02 L02 L04**. Non-smoke definitions are listed as `definition-only` and cannot be executed as easier substitute tasks. All-twelve execution and multi-provider/plugin parity are later, separate scope. There is no benchmark dashboard or production-service deployment step. The full task matrix, acceptance obligations and pinned methodology/license provenance are in [PLAN.md](PLAN.md).

## Architecture and trust boundary

```text
host benchmark supervisor (trusted; grader/reference code stays here)
  ├─ fresh owned PostgreSQL container + actual PM API + private Markdown authority
  ├─ private Agent Chat state per independent fixture
  ├─ controlled PM/provider broker: explicit targets, original receipts, fixed model, limits
  ├─ isolated tested Agent runtime: fictional docs + TypeScript repo + artifact directory
  └─ separate isolated submitted-code execution → trusted independent graders → reports
```

Core PM objects/relationships are authoritative **Markdown**, while PostgreSQL owns identity, authorization, receipts and PM auxiliary facts. Agent Chat retains its existing private persistence. This package does not unify Sessions/persistence or claim a cross-storage transaction. See the current [context](../../docs/architecture/context.md), [Markdown ADR](../../docs/architecture/adr/0003-markdown-core.md), [domain applicability](../../docs/domain-design/README.md#7-当前适用性历史计划与验证), [PM guide](../../docs/guides/project-management.md), and [Agent guide](../../docs/guides/agent-chat.md).

The fixture contains three fictional projects, 20–30 issues, 30–50 documents, intentionally stale/conflicting decisions and original TypeScript code. A reset provisions actual authority and returns real IDs/revisions; semantic hashes canonicalize generated identities/timestamps only for reset comparison. Raw identities and original operation/receipt linkage remain evidence. All PM calls use explicit targets. Unknown writes must reconcile their original operation identity, not resend under a new key.

The tested process does **not** receive the host repository, hidden graders/answers, PM authority roots, PostgreSQL credentials, Docker socket, production services or the user's HOME/provider login. A working directory is not a sandbox: the runtime boundary is an actual container/OS boundary with restricted networking and explicit capability transport. A successful prerequisite check is not evidence of paid inference.

**Agent isolation tradeoff:** the outer Agent container explicitly uses `seccomp=unconfined`, `apparmor=unconfined` and `systempaths=unconfined` so its in-image native Bubblewrap can establish the tested process's private mount/PID/proc boundary. Native descendants inherit these reduced kernel filters; Bubblewrap does not restore Docker's default seccomp/AppArmor policies. Isolation therefore depends on the namespace/mount allowlist, nonroot/capability restrictions and host kernel, with increased kernel attack surface. The container remains network-disabled, read-only, private-PID, `cap-drop=ALL` and `no-new-privileges`, with no privileged mode, `SYS_ADMIN`, host namespaces, host authority roots or Docker-socket mount. Actual outer policy and inner denial probes must be inspected and recorded. The separate submitted-code grader retains default Docker security profiles and does not use this relaxation. Effective isolation policy is included in environment/proof hashes; changes invalidate matched comparisons. The verified host lacks Docker swap-limit accounting, so the configured memory cap is not a strict combined RAM-and-swap cap. This benchmark boundary is not a production multi-tenant security certification.

### Controlled arms

| Canonical arm | Supplied support | Held constant |
| --- | --- | --- |
| `raw` | Original source docs, repo, task/history and its own prior model-written files; no generated knowledge/context | Same real Chat transport, fixed provider/model/options, sources, code, actual PM permissions, tool capabilities, budgets and planned interventions |
| `knowledge` | Raw inputs plus materialized source-derived `.dovspace/knowledge-index.json` and executable lexical retrieval `node .dovspace/search.mjs QUERY` | Same controls; index stores source paths/headings/exact passages/content hashes, not expected answers |
| `dovspace` | Knowledge support plus actual PM planning/execution and persisted plan/handoff reuse; `.dovspace/resume-context.json` is built only from this run's prior artifacts and verified original authorized receipts | Same controls; new Session is real, prior native cursor/messages are not copied; no other arm's generated state is reused |

The runtime is deliberately held constant so that materialized knowledge/workflow support is the treatment. This is not an external raw CLI comparison, an independent new memory service, or proof of production Agent multi-tenancy. All original raw sources remain accessible in every arm.

## Prerequisites

Use an **unprivileged Linux operator**, Node **24.21.0**, pnpm **11.9.0**, the existing root-installed dependencies/native modules, Git, and Docker Engine at `unix:///var/run/docker.sock`. The Agent runtime uses Bubblewrap installed **inside its built image**; it does not bind a host Bubblewrap binary. Submitted code runs in a separate network-disabled, nonroot, read-only Node container with private PID/capability/seccomp restrictions; pure-function grading additionally uses an inner VM boundary. Code grading requires neither host `/usr/bin/bwrap` nor nested Bubblewrap. Root execution is rejected by that grader. Ports **3224/4194/4325/55444** are not benchmark targets.

From the repository root, prepare dependencies using the normal [development toolchain](../../docs/guides/development.md). The benchmark package declares no duplicate dependencies and changes no root package metadata/lockfile:

```sh
node scripts/doctor.mjs
pnpm install --frozen-lockfile
```

Prepare the public runtime image and PostgreSQL image explicitly. The runtime image installs a user-selected **exact** Codex version, not a host CLI/home or an authenticated private image:

```sh
# Set CODEX_VERSION to the exact @openai/codex version you intend to compare.
: "${CODEX_VERSION:?Set an exact available @openai/codex version}"
docker build --build-arg CODEX_VERSION="$CODEX_VERSION" \
  -f benchmarks/dovspace/isolation/Agent.Dockerfile \
  -t dovspace-bench-agent:local benchmarks/dovspace/isolation
docker pull postgres:16-alpine
docker pull node:24.21.0-bookworm
```

For reproducible published runs, use immutable image digests with `--agent-image`/`--code-image`/`--postgres-image`, retain the build/version evidence, and use an immutable supplier model identifier rather than a rolling model alias. The separate code image is Node-only; it does not need the Agent/Codex source/runtime. Development image tags alone are not a complete environment pin. No build/install/pull happens implicitly during a benchmark run. The Agent image must provide the configured absolute container `--provider-binary` (default `/usr/local/bin/codex`).

A live run also needs an explicitly supplied public HTTPS OpenAI-compatible API **base** such as `https://api.openai.com/v1`, a credential for that endpoint, the exact model identifier/options, and a declared price schedule/output cap. The broker appends `/responses` or `/chat/completions`; do **not** provide a URL already ending in `/responses`. Host-local/private provider endpoints are forbidden. Provider credentials available to implementation subagents do not configure this product runtime.

No command loads `.env`, an existing business database, browser login, global provider home or ambient `OPENAI_API_KEY`. Only a credential variable explicitly named by `--api-key-env` is read. Do not place a credential in a command argument or config JSON. No fixture/reference/calibration mode is a silent live-model fallback.

## Commands

Run the following commands from the repository root. `pnpm --dir` sets the package working directory; do not add an extra `--` before CLI flags.

### Discover definitions and verify isolated resets

```sh
pnpm --dir benchmarks/dovspace bench --help
pnpm --dir benchmarks/dovspace bench:list
pnpm --dir benchmarks/dovspace bench:list --json
pnpm --dir benchmarks/dovspace bench:fixtures:reset --repeat 3
```

`fixtures reset` creates, seeds, snapshots and destroys a fresh real isolated fixture on each repeat. It writes `outputs/reset-UUID/reset.json` and `reset.md`, requiring equal semantic hashes and distinct fixture identities. It does not leave a live shared fixture for subsequent arms. A provisioning/cleanup error is retained as failure; incomplete cleanup is never reported as confirmed destruction.

### Explicit deterministic grader calibration

```sh
pnpm --dir benchmarks/dovspace bench:calibrate --agent-image dovspace-bench-agent:local --code-image node:24.21.0-bookworm --output outputs/calibration/local
```

Calibration uses intentionally correct and incorrect **trusted synthetic reference artifacts** to test graders. It runs real Docker-isolated code tests, including baseline feature-fail/regression-pass and correct-reference feature/regression-pass evidence. Missing Docker/code-image isolation fails explicitly; code tests cannot be skipped to manufacture success. No host Bubblewrap is required for code calibration. Output is `calibration.json` + `calibration.md`, labelled **`grader-calibration`**, with `agent:null` and `model:null`. These are not real model runs, cannot be selected as an arm, and cannot be imported into model comparison reports.

PM authority/transport records used for calibration are explicitly synthetic trusted reference evidence: they test scoring, not actual runtime recovery. The independent real isolated fixture and interruption/receipt-recovery smoke must be exercised separately.

### Explicit controlled protocol calibration

```sh
pnpm --dir benchmarks/dovspace bench:protocol:calibrate \
  --agent-image dovspace-bench-agent:local --code-image node:24.21.0-bookworm
```

This separate entry deliberately selects a **controlled native JSON-RPC peer**, not an LLM. It provisions real PostgreSQL/Markdown PM authority and the isolated real Agent Chat runtime, performs a committed PM write whose response is actually dropped, acknowledges an actual interruption, starts a distinct Session and reconciles the original receipt without duplicate mutation. Trusted checks and `result.json`, `trace.jsonl`, `report.md`, PM/Git diffs and retained artifacts are written under `outputs/protocol-UUID/`.

The result is explicitly **`protocol-calibration`**, `modelEfficacy:null`, `inferencePerformed:false`. It evaluates the exercised runtime/recovery protocol only, not model reasoning, paid inference, vendor authentication or Raw/Dovspace task efficacy. It refuses paid-provider configuration and is never selected by an ordinary run, grader calibration, missing credential, or comparison arm. A protocol result cannot be imported as a model A/B result. Passing is determined only by the command's actual checks; this documentation makes no passing claim. The optional `--outputs-root` spelling belongs to this standalone protocol entry and accepts an absolute reserved `outputs` subtree.

### Select real model inputs explicitly

Set the following nonsecret variables to your actual fixed endpoint/model/settings and current declared prices; the shell assertions prevent accidentally using empty inputs. These example variable names have no implicit special meaning to the benchmark:

```bash
: "${DOVSPACE_BENCH_ENDPOINT:?Set a public HTTPS API base ending in /v1}"
: "${DOVSPACE_BENCH_MODEL:?Set the exact immutable model identifier}"
: "${DOVSPACE_BENCH_INPUT_USD_PER_MILLION:?Set the declared input price}"
: "${DOVSPACE_BENCH_OUTPUT_USD_PER_MILLION:?Set the declared output price}"
: "${DOVSPACE_BENCH_MAX_OUTPUT_TOKENS:?Set a positive maximum output token count}"
: "${DOVSPACE_BENCH_MAX_COST_USD:?Set a positive per-run USD cap}"
# Explicit authorization: this reads only the credential you type, with no echo.
read -r -s -p 'Benchmark provider API key: ' DOVSPACE_BENCH_API_KEY
printf '\n'
export DOVSPACE_BENCH_API_KEY
BENCH_MODEL_ARGS=(
  --provider-endpoint "$DOVSPACE_BENCH_ENDPOINT"
  --model "$DOVSPACE_BENCH_MODEL"
  --model-options '{"reasoningEffort":"xhigh"}'
  --api-key-env DOVSPACE_BENCH_API_KEY
  --price-input-per-million "$DOVSPACE_BENCH_INPUT_USD_PER_MILLION"
  --price-output-per-million "$DOVSPACE_BENCH_OUTPUT_USD_PER_MILLION"
  --max-output-tokens "$DOVSPACE_BENCH_MAX_OUTPUT_TOKENS"
  --max-cost-usd "$DOVSPACE_BENCH_MAX_COST_USD"
  --agent-image dovspace-bench-agent:local
  --code-image node:24.21.0-bookworm
)
```

Use model options supported by the explicitly selected model/provider; unsupported settings must fail rather than silently change models or reasoning level. Keep this same array/config unchanged throughout a matched experiment. Prices are an explicit budget/reservation input, not a claim about a subscription invoice.

### Run one task, repeated smoke, and fair A/B/C

```bash
pnpm --dir benchmarks/dovspace bench:run --task K02 --arm dovspace "${BENCH_MODEL_ARGS[@]}"
pnpm --dir benchmarks/dovspace bench:smoke --arm dovspace --repeat 2 \
  --experiment smoke-01 "${BENCH_MODEL_ARGS[@]}"
pnpm --dir benchmarks/dovspace bench:compare --tasks smoke --arms raw,dovspace \
  --repeat 2 --experiment ab-01 "${BENCH_MODEL_ARGS[@]}"
pnpm --dir benchmarks/dovspace bench:compare --tasks K02,K03 --arms raw,knowledge,dovspace \
  --repeat 3 --experiment abc-01 "${BENCH_MODEL_ARGS[@]}"
unset DOVSPACE_BENCH_API_KEY
```

The per-run task budget is a ceiling. `--max-duration-minutes`, `--max-model-calls`, `--max-tool-calls` and the explicit `--max-cost-usd` can impose lower caps. Model/cost/tool limits are enforced at the process/broker boundary, not merely measured afterwards. Missing endpoint/credential/prices blocks real inference and produces an admitted prerequisite-failure result, never calibration success. Missing an explicit model or positive cost cap is invalid CLI/config input and is rejected before admission.

`compare` and `smoke` are serial, rotate arm order within matched blocks, and reset independently for **every** task/arm/repeat. Existing experiment directories are not overwritten by a new experiment. Mixed model/settings, task/fixture versions, budgets, permissions, semantic reset hashes, actual runtime environments, reused fixture/run IDs or unequal arm counts mark the comparison **invalid** and suppress an advantage claim. `reproducibility.environmentHash` binds actual immutable image identities, the staged product-source byte manifest, lockfile hash and effective isolation policy; a Git commit alone is insufficient for this dirty working tree. Non-smoke `run`/`compare --tasks all` is rejected in v0.1; `bench:list --json` still exposes all twelve definitions with availability.

When actual request evidence exists, `reproducibility.effectiveModelSettingsHash` must be valid and equal across attempts; configured model/options hashes alone are insufficient. Observed model calls without effective-settings proof invalidate comparison. Missing proof remains null rather than an inferred match.

`--config PATH` accepts an explicit **nonsecret JSON object** using the keys in `benchmark.config.ts`; CLI flags override it. `providerApiKey` in config is rejected. `--runtime-root` must remain inside `benchmarks/dovspace/.runtime`; all run, experiment, report and calibration output stays inside `benchmarks/dovspace/outputs`. `--output-root` selects a reserved run-output subtree, while `--output` selects a report/calibration/experiment directory there. Source/control directories and symlink or hard-link output redirection are refused. Relative root/output options resolve from the benchmark directory. There is no dotenv/service-URL fallback.

### Regenerate reports without inference

```sh
pnpm --dir benchmarks/dovspace bench:report --experiment ab-01
# For an individual existing run, substitute the actual emitted run directory:
pnpm --dir benchmarks/dovspace bench:report --run-result outputs/RUN_ID/result.json
# Multiple real run results can be aggregated; all fairness checks still apply:
pnpm --dir benchmarks/dovspace bench:report \
  --run-result outputs/RAW_RUN_ID/result.json \
  --run-result outputs/DOVSPACE_RUN_ID/result.json --experiment imported-01
```

Imported run files are schema-validated; report generation does not launch a provider or rerun graders. It cannot turn missing/contradictory independent checks into verified success. A calibration JSON file is not a valid real-model result.

## Evidence layout and interpretation

```text
outputs/<runId>/
  result.json        # full independent grade, safety, usage, failure evidence, reproducibility
  trace.jsonl        # redacted trusted runner/transport/provider/isolation events
  report.md
  pm-diff.json
  git.diff
  artifacts/
outputs/experiments/<experimentId>/
  summary.json       # design, fairness issues, per-arm/task summaries, null coverage
  comparison.md
  task-results.json # self-contained complete real-model run results, not only links
outputs/calibration/<name>/
  calibration.json
  calibration.md
```

Every admitted run retains evidence even if isolation, provider, runtime or grader execution fails. Invalid task/arm/config is rejected before admission rather than emitting a fake attempted task. Cleanup only targets resources proven owned by this supervisor; if identity or cleanup cannot be proven, failure and retained private resources are reported rather than deleting an unrelated container/directory.

Four report-level failure groups are **task / model / platform / grader**. Detailed underlying kinds retain knowledge/state/code/process/safety/budget/tool/permission/model/runtime distinctions. Platform/model/grader errors remain in the primary attempted-run denominator and are visible separately; there is no success-rate improvement by silently dropping failed infrastructure attempts.

Verified success requires every required independent Knowledge/State/Code/Process check that applies, plus safety and zero unexpected mutations. A safety violation vetoes weighted checkpoint credit. `humanInterventions` counts unplanned operator actions, excluding scheduled benchmark controls. v0.1 `rework` is a **narrow PM retry proxy**: repeated failed mutations with identical normalized tool/target/revision/arguments and unchanged authority revision, excluding read-only receipt reconciliation and intentionally lost-response originals. Count / attributable completed mutation attempts is a weighted proxy proportion, not total semantic/coding rework. Incomplete observation or a zero denominator yields null, never an invented ratio.

Unknown token/cost/cache/call counts remain **null**, not zero. A complete aggregate total/mean is null if any corresponding observation is unknown; known subtotal and coverage are separate. **Cost per success = all attempted-run cost / verified successes** only when costs are fully observed and at least one success exists; otherwise it is null with `no_successes` or `unknown_cost`. Reservations are not billed cost. Descriptive rates and intervals at **n=2–3** cannot establish statistical superiority, production readiness, multi-tenancy or broad model ranking.

## Verification commands for the integrator

After all code has landed, run once from the repository root:

```sh
pnpm --dir benchmarks/dovspace typecheck
pnpm --dir benchmarks/dovspace test
pnpm --dir benchmarks/dovspace test:integration
pnpm --dir benchmarks/dovspace lint
pnpm check:docs
pnpm --dir benchmarks/dovspace bench --help
pnpm --dir benchmarks/dovspace bench:list --json
pnpm --dir benchmarks/dovspace bench:fixtures:reset --repeat 3
pnpm --dir benchmarks/dovspace bench:calibrate --agent-image dovspace-bench-agent:local --code-image node:24.21.0-bookworm --output outputs/calibration/verification
pnpm --dir benchmarks/dovspace bench:protocol:calibrate --agent-image dovspace-bench-agent:local --code-image node:24.21.0-bookworm
node --conditions=development benchmarks/dovspace/runners/code-executor-security.ts --code-image node:24.21.0-bookworm
```

`test` enumerates trusted source unit tests explicitly; `test:integration` explicitly selects the real Docker/PM lifecycle tests. `lint` names only owned source directories, and TypeScript excludes `.runtime`/`outputs`. Never replace these with recursive `node --test` or broad output-tree lint/build commands: submitted/generated repo tests are untrusted and must never execute on the host. The package runs native TypeScript; it has no emitted product build or Web deployment step.

Then use the explicitly authorized live-model smoke/compare commands above and retain their actual results. Tests/calibration do not prove real provider availability; the observed snapshot below is limited to the named checks and must not be treated as blanket current-tree/model efficacy approval. Do not rebuild/restart the unrelated running Web/PM service solely to run this standalone benchmark.

## Integrator-observed verification snapshot

The central integrator reported the following local results on **2026-11-10**. These cover the exercised working-tree snapshot, not future edits or paid-provider efficacy. Generated evidence paths below are local outputs, not files bundled with a fresh checkout.

| Check | Observed result | Scope / evidence |
| --- | --- | --- |
| TypeScript | Passed | Central integrator's package typecheck |
| Trusted unit suite | 118 passed, 0 skipped | Explicit source-test selection, not submitted/generated tests |
| Real lifecycle integration | 2 passed, 0 skipped | Real Docker/PM resets and unauthorized-mutation detection |
| CLI fixture reset ×3 | Passed | Three distinct fixture IDs, equal semantic content, confirmed destruction; `outputs/reset-8d01c5d3-2922-47ad-9ae1-c10dfd4cd05e/reset.json` |
| Independent grader calibration | 60/60 passed: 6 correct + 54 negative | Real Docker code execution plus explicitly synthetic PM/transport reference evidence; `outputs/calibration/verified-20261110-final/calibration.md` |
| Missing-provider comparison | 2 attempts, 0 observed model requests, 0 successes; fairness invalid | Expected prerequisite failure, not a real-model A/B score |
| Standalone code-executor security regression | 4/4 passed | Actual isolated execution: legitimate result, import-denial boundary, poisoned serializer, independent invocation errors; `outputs/code-security-1878bd59-a732-4545-8bb2-cb4fc0d50be7/result.json` |
| Controlled protocol calibration | 11/11 passed | Actual isolated Agent/PM, two fresh Sessions, committed response loss, active interruption, original receipt recovery, no replay or unexpected mutation; `outputs/protocol-8ace2892-7e99-49ed-95ff-104df9ee891b/report.md`. Controlled native peer, **no inference** |
| Native planning/idempotency smoke | Passed | Three real Issues and dependency DAG, original-operation replay without duplicates, independent state checks and zero unexpected changes; `outputs/native-plan-e36999ed-75e1-4023-a7f8-a45788db680f/result.json`. Direct real PM API, **no model** |
| Real-model six-case smoke / A/B/C | Not established | Requires explicit authorized endpoint, credential, fixed model/settings and pricing; no paid-inference efficacy claim |

The three-reset semantic hash was `25f4266deaf09c02510835f390dd7915f776e57a073e12a5dbfc3bf082ca6dba`; each reset contained 27 entities and 28 receipts. The separately built runtime probe observed Node 24.21.0, Codex CLI 0.167.0 and Bubblewrap 0.8.0 in image `sha256:ea7c4e096055ab4a6f3847bd4f2c72e726c92ff18437ec1b7a9d7ea756fc3aac` (`dovspace-bench-agent:bench-20261110`). This proves those version probes, not provider authentication or model inference, and does not assert that the convenience default image tag is installed.

The protocol run also observed the real PM endpoint accept the platform's signed terminal signal; its exact payload and linked execution were used to classify the corresponding SQL row. This is not a blanket exemption for automation data. Owned benchmark containers and private runtime directories were empty after verification; the temporary native-planning smoke script was removed.

Methodology source pins, observed license restrictions (including unlicensed MemoryArena and mixed-license MCP conformance), original-data policy and the complete twelve-case definitions are recorded in [PLAN.md](PLAN.md#methodology-references-and-licensing-provenance). No third-party benchmark code/datasets were copied; repository software licensing is not permission to redistribute someone else's dataset.
