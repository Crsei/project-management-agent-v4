# Dovspace-Bench Lite v0.2

A small, original synthetic benchmark for grounded knowledge work, real PM planning, TypeScript delivery, and interrupted cross-Session work. It drives the existing **Agent Chat** and independently checks artifacts and actual PM authority. A finished generation, a CLI exit, checkpoint credit and business task completion are different facts.

**Scope:** twelve complete task definitions; **nine executable cases: K02 K03 K04 D01 D02 D04 L02 L03 L04**. The original six-case smoke selection remains **K02 K03 D01 D02 L02 L04**. K01/D03/L01 remain `definition-only` and cannot execute as easier substitute tasks. All-twelve execution and multi-provider/plugin parity remain separate scope. There is no benchmark dashboard or production-service deployment step. Full definitions, proof obligations and pinned methodology/license provenance are recorded in the repository-local `PLAN.md`, which is not distributed with the public tree.

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
| `knowledge` | Raw inputs plus materialized source-derived `.dovspace/knowledge-index.json` and executable lexical retrieval `node .dovspace/search.mjs QUERY` | Same controls; index v2 stores source paths/headings/exact passages/content hashes, labels retrieval as `needs_review` (or `stale` on hash mismatch), and exposes clipping; no expected answers |
| `dovspace` | Knowledge support plus `.dovspace/stage-brief.json` and persisted plan/handoff reuse; `.dovspace/resume-context.json` v2 is built only from this run's prior artifacts/memory and verified original authorized receipts | Same PM planning/execution tools in every arm; stage brief is explicitly source-derived, not a fabricated product HTTP response; original operations remain `unknown` until requester-bound reconciliation; no copied native cursor/messages or another arm's state |

The runtime is deliberately held constant so that materialized knowledge/workflow support is the treatment. This is not an external raw CLI comparison, an independent new memory service, or proof of production Agent multi-tenancy. All original raw sources remain accessible in every arm.

Raw is **not a memory-erasure arm**: it retains its own model-authored artifacts, including the K04-required saved memory. K04 matched comparisons measure generated source/context support with versus without that treatment, not “all memory versus none”. `pm_task_brief` / `pm_search_knowledge`, when registered in the isolated product runtime, are equally allowed in all arms and retain the original PM authorization; the benchmark does not depend on a production Delivery association.

### Added executable guidance scenarios

- **K04:** the first live Session researches current constraints/decisions and a cited failed uncapped-delay approach into `knowledge/session-memory.json`. Only an independently validated memory checkpoint admits interruption and a fresh Session; the related full Retry-After development requirement arrives then. Independent graders require unchanged saved memory, exact source hashes/citations, complete reuse-to-source/test mappings, real feature fail-to-pass and regression pass-to-pass, and unchanged PM authority. Stale decisions, missing constraints, forged provenance and uncapped implementations fail.
- **D04:** every arm begins with the same genuinely partial decimal-seconds implementation, correct `cappedBackoff` helper and original partial tests. A predecessor inventories completed/remaining work, saves original target/revision/write identity and performs one scoped partial-work PM sync. Its actual committed response is lost; the active Agent is interrupted. A distinct Session of the **same fixed Provider/model** must preserve correct code/tests/decisions, finish remaining HTTP-date/invalid-header feature work and real tests, retain complete handoff/receipt evidence, and synchronize delivery once. Original-receipt reconciliation is an additional safety check, not a replacement for feature/handoff scoring.
- **L03:** the first Session implements the actual accepted **server-replacement** Retry-After rule and real tests. Frozen halfway source/test bytes are independently executed in the code sandbox before the runner changes the original public requirement to **server-minimum**. The new requirement/format is not supplied in the initial task prompt. The fresh successor must re-read/replan, preserve the exact still-valid helper, implement all revised/unchanged obligations, update tests/docs/authorized PM evidence, and report hashes plus the deterministic positional changed-line count from the real checkpoint/final sources. The grader separately re-executes both original halfway behavior and final revised behavior; stale plans, omitted acceptance or invented rework fail.

Task and fixture versions are now `0.2.0` / `dovspace-lite-0.2.0`; do not mix them with the historical six-case results. Source-context protocol v2 and observed generated bytes, distinct Sessions, requirement-change count and L03 changed-source lines are retained in `result.guidance` and reports. Generated bytes are not provider token usage; line changes are not total semantic rework. Missing historical observations remain unknown.

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

For reproducible published runs, use immutable image digests with `--agent-image`/`--code-image`/`--postgres-image`, retain the build/version evidence, and use an immutable supplier model identifier rather than a rolling model alias. The separate code image is Node-only; it does not need the Agent/CLI source/runtime. Development image tags alone are not a complete environment pin. No build/install/pull happens implicitly during a benchmark run. The Agent image must provide the configured absolute container `--provider-binary`: `/usr/local/bin/codex` for Codex or `/usr/local/bin/omp` for OMP. Provider/model availability is verified separately; selecting OMP never falls back to Codex.

The default ordinary-API path needs an explicitly supplied public HTTPS OpenAI-compatible API **base** such as `https://api.openai.com/v1`, its explicitly selected API key, the exact model identifier/options, and a declared price schedule/output cap. The broker appends `/responses` or `/chat/completions`; do **not** provide a URL already ending in `/responses`. Host-local/private provider endpoints are forbidden. Provider credentials available to implementation subagents do not configure this product runtime.

No command loads `.env`, an existing business database, browser login, global provider home or ambient `OPENAI_API_KEY`. Ordinary API auth reads only the variable explicitly named by `--api-key-env`. The separate native-account path below must be explicitly selected; a model name or native API label never enables host authentication. Never put a credential in an argument or config JSON. No fixture/reference/calibration mode is a silent live-model fallback.

### Explicit existing native OMP account

This path remains **product CLI → isolated real Agent → image OMP18.15.0 → fixed broker → trusted-host SDK relay → native Codex provider**. It is not a standalone host pilot. It selects exactly `openai-codex/gpt-6.1-sol` with `modelOptions.thinking: "xhigh"` and API `openai-codex-responses`, not a same-named ordinary API model.

The host SDK accesses only the explicitly selected existing OAuth row through supported `AuthStorage.oauth.accounts()` / `accessById()` APIs. The durable row ID and SHA256 account fingerprint must both match before and after access resolution; no ranking, sibling account rotation, API-key fallback, alternate model or alternate origin is allowed. Only the SDK handles refresh and persistence. Relay egress allows the official Codex Responses endpoint and, only when the SDK needs it, the official OAuth token endpoint. Direct connections check/pin public DNS; redirects and ambient proxy inheritance are disabled. No discovery or usage probe is forwarded to the account.

The image receives only its fixture capability. Host HOME, SDK installation, auth database, account IDs and tokens are not mounted/copied into the tested Agent. A separate host-only private socket carries broker requests to the relay; it is outside every fixture mount. Tokens stay in relay memory/HTTPS headers and are never returned over IPC, written to result/config JSON, or logged. Host SDK access paths are CLI-only and excluded from exported configurations. The selected SDK may perform its normal store migrations/refresh persistence; shutdown allows its bounded refresh-persistence drain rather than killing a token exchange midway.

If the working operator OMP uses a local HTTP proxy, explicitly set `hostAuthBoundary.httpProxy` in the nonsecret config to that verified endpoint (for example `"http://127.0.0.1:17891"`; replace the port with the actual configured one). Only literal `127.0.0.1` or `[::1]`, an explicit valid port, and no credentials/path/query/fragment are accepted. The trusted host relay uses HTTP CONNECT for both inference and SDK token refresh, retains normal HTTPS certificate verification, and delegates target DNS to the explicitly trusted proxy. Failure does not fall back to direct access or another proxy. The Agent container gains neither proxy access nor credentials. The selection is included in auth-boundary, environment and effective-settings evidence; keep it identical across matched runs. Inspect the working OMP process's selected proxy configuration, not just a sanitized tool shell: absence from the latter does not prove that OMP uses direct access.

Native transport is fixed to HTTPS/SSE. All configured native model roles use the exact selector; retries/model fallback, prewalk/context promotion and automatic compaction are disabled in this private native-account fixture. The actual context window remains **500000**, not a fabricated trigger window. This does **not** provide native compaction acceptance or close its separate product-observation/source-maintenance prerequisite.

The native Codex contract parses successful `stream:true` responses as SSE even when the upstream supplies a generic media type; non-success JSON error responses remain JSON. Every SSE data frame still undergoes the existing JSON/model/tool checks, and only terminal native usage can settle a reservation. The response trace retains the observed Content-Type; a successful HTTP status alone is not model or task acceptance.

**Prices and limits:** the exact18.15.0 bundled Sol catalog declares input/output/cache-read/cache-write rates **$2/$10/$0.10/$0 per million tokens**, maximum output **128000**, and `omitMaxOutputTokens: true`. Its API does not enforce a requested output cap. Native configuration therefore reserves the full catalog output limit for every request and never injects a fictitious smaller `max_output_tokens`. The broker also conservatively reserves input cost from request size before account egress. For example, a 482501-byte request reserves `((482501*4+1024)*2 + 128000*10)/1000000 = $5.142056`; a $0.60 run cannot admit it. Per-run limits apply to calls, tools, duration and catalog-estimated USD. Missing/incomplete usage keeps its reservation. A known zero cache-write rate permits the estimate without inventing an unreported cache-write token count.

`costUsd` is explicitly a **versioned catalog estimate**, not observed subscription billing; `actualSubscriptionBillingUsd` stays `null`. Canonical request IDs, product Session/generation linkage, actual terminal usage/raw usage, fixed settings and reservation evidence remain in the existing broker trace. An operator must separately reserve the complete experiment at per-run caps; the following $10 example grants no account or whole-experiment authorization.

Use a separate, private, exact official SDK installation; do not modify the project's dependencies or a global installation. On Linux x64, the following explicit setup installs no package hooks and keeps its own integrity lock:

```sh
SDK_ROOT="$(mktemp -d /tmp/dovspace-native-sdk-XXXXXX)"
chmod 700 "$SDK_ROOT"
npm install --prefix "$SDK_ROOT" --ignore-scripts --save-exact --no-audit --no-fund \
  @oh-my-pi/pi-ai@18.15.0 @oven/bun-linux-x64@1.4.4
OMP_BUN="$SDK_ROOT/node_modules/@oven/bun-linux-x64/bin/bun"
```

The official packages are [`@oh-my-pi/pi-ai@18.15.0`](https://registry.npmjs.org/@oh-my-pi/pi-ai/18.15.0) and [`@oven/bun-linux-x64@1.4.4`](https://registry.npmjs.org/@oven/bun-linux-x64/1.4.4). Retain the private `package-lock.json` integrity records. The relay requires all six OMP SDK packages to be18.15.0 and Bun≥1.4.4, and records the actual SDK versions, lock SHA256, catalog SHA256 and Bun version. The earlier importable17.4.0 catalog is not an exact-model substitute. Missing or unsupported SDK/catalog/auth APIs fail closed; nothing is downloaded automatically at execution.

First obtain nonsecret metadata. Catalog mode is strictly offline and does not open an account. Account-list mode uses the SDK's local metadata API without refresh, usage probes or inference; it outputs row IDs/fingerprints only, not tokens/email/account IDs. Supply an existing owned credential-store path explicitly; no HOME/profile/auth path is inferred.

```sh
: "${AUTH_STORE:?Explicit existing host OMP agent.db path}"
pnpm --dir benchmarks/dovspace bench native-account-catalog \
  --omp-sdk-root "$SDK_ROOT" --omp-bun "$OMP_BUN" \
  --output outputs/native-account/catalog.json
pnpm --dir benchmarks/dovspace bench native-account-list \
  --omp-sdk-root "$SDK_ROOT" --omp-bun "$OMP_BUN" --omp-auth-store "$AUTH_STORE" \
  --output outputs/native-account/accounts.json
```

Select the authorized row explicitly, then generate a nonsecret **CLI config** from that catalog (the CLI fills unchanged task ceilings). Both metadata files and the config use exclusive creation: choose a new output directory for another setup, rather than overwriting evidence.

```sh
: "${ACCOUNT_ROW_ID:?Explicit authorized row from the SDK metadata}"
: "${AGENT_IMAGE:?Inspected immutable image containing omp/18.15.0}"
node --input-type=module -e '
import {readFileSync,writeFileSync} from "node:fs";
const [catalogFile,accountsFile,row,output,image]=process.argv.slice(1);
const catalog=JSON.parse(readFileSync(catalogFile,"utf8"));
const accounts=JSON.parse(readFileSync(accountsFile,"utf8"));
const selected=accounts.accounts.find(value=>value.accountRowId===Number(row));
if (!selected || accounts.sdkLockSha256!==catalog.sdkLockSha256 || accounts.catalogSha256!==catalog.catalogSha256) throw new Error("Explicit account/catalog mismatch");
writeFileSync(output,JSON.stringify({
  controlTransport:"cli",provider:"omp",providerApi:catalog.model.api,
  providerEndpoint:catalog.model.baseUrl,model:catalog.model.id,modelOptions:{thinking:"xhigh"},
  ompModel:catalog.ompModel,prices:catalog.prices,agentImage:image,
  hostAuthBoundary:{kind:"omp-native-account",provider:"openai-codex",...selected,
    sdkVersion:catalog.sdkVersion,sdkLockSha256:catalog.sdkLockSha256,catalogSha256:catalog.catalogSha256},
  budget:{maxCostUsd:10}
},null,2)+"\n",{mode:0o600,flag:"wx"});
' benchmarks/dovspace/outputs/native-account/catalog.json \
  benchmarks/dovspace/outputs/native-account/accounts.json "$ACCOUNT_ROW_ID" \
  benchmarks/dovspace/outputs/native-account/config.json "$AGENT_IMAGE"

# This is the first actual task request, not a paid preflight. Requires account/budget authorization.
pnpm --dir benchmarks/dovspace bench:run --task K02 --arm dovspace \
  --config "$PWD/benchmarks/dovspace/outputs/native-account/config.json" \
  --omp-sdk-root "$SDK_ROOT" --omp-bun "$OMP_BUN" --omp-auth-store "$AUTH_STORE"
```

Do not add `--api-key-env` or change the native endpoint/account fingerprint/output reservation. Model discovery/setup occurs before the first task prompt; missing exact model availability cannot silently select another model. The existing broker query-string guard remains unchanged, and no account discovery is used to repair fixture catalog discovery. Study manifests additionally freeze the same public auth selection/SDK/catalog evidence and complete-design budget; host SDK access paths are supplied separately at execution. Boundary regression tests do not constitute a successful native-account/product/model run: actual isolated smoke, cost/usage/cancellation/error capture, cleanup and source-bound verification must still be exercised and reported.

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

### Actual native OMP with a controlled HTTP provider

The OMP path uses the installed native executable, the existing product Provider adapter and generation-owned PM Host Tools. It does **not** replace OMP with the controlled JSON-RPC peer above. Native Skills and optional observer plugins remain disabled; the existing permission extension is the only host-generated extension exposed read-only to the tested process.

For an offline local-binary experiment, prepare a **new narrow build context containing only the reviewed `omp` executable**, not its installation directory, HOME, Sessions or credentials. Record its origin, SHA256 and exact `omp/VERSION` output. The supplied recipe verifies the digest and version; this does not certify the executable as an official upstream release:

```sh
: "${BASE_IMAGE:?Set the inspected immutable local Agent image ID sha256:...}"
: "${OMP_SHA256:?Set the reviewed executable SHA256}"
: "${OMP_VERSION:?Set the exact native version, without omp/}"
: "${OMP_CONTEXT:?Set the private directory containing only omp}"
# Classic Docker builder resolves a local image ID. Some BuildKit versions
# interpret sha256:... as a registry name even with --pull=false.
DOCKER_BUILDKIT=0 docker build --pull=false --network=none \
  --build-arg BASE_IMAGE="$BASE_IMAGE" --build-arg OMP_SHA256="$OMP_SHA256" \
  --build-arg OMP_VERSION="$OMP_VERSION" \
  -f benchmarks/dovspace/isolation/Omp.Agent.Dockerfile \
  -t dovspace-bench-agent:omp-local "$OMP_CONTEXT"
pnpm --dir benchmarks/dovspace bench:protocol:omp \
  --agent-image dovspace-bench-agent:omp-local --code-image node:24.21.0-bookworm
```

This explicit **`omp-controlled-http`** scenario creates real isolated PM authority, reads a Task Brief through native Host Tools, inspects the actual subsequent provider request, then exercises committed response loss, active cancellation, a fresh Session, current-authority rereading and original receipt recovery. The HTTP producer is deterministic: `inferencePerformed:false`, model efficacy and tokenizer usage remain unknown. It refuses paid-provider inputs and is never a missing-provider fallback.

The broker records exact forwarded-request hashes/byte counts, tool schema/result observations, canonical PM operations, terminal or missing usage, and separate monotonic timing intervals. Exported bodies are redacted structured JSON, **not verbatim raw requests**. `content/details` or `content/structuredContent` alone never establishes duplicate model consumption. Private reports use owner-only directories/files; `PI_REQ_DEBUG` files in an untrusted working directory are not required.

Native compaction is **not** established by this scenario. The current product host rejects `/compact` and does not project native auto-compaction lifecycle events; fresh-Session handoff must not be relabeled as compaction. PMT08 remains unknown until actual native compaction and post-compaction requirements are independently observed. Session/persistence design still follows existing Agent Chat and is not unified by this benchmark.

### Product CLI control and observation lane

Select `--control-transport cli` to drive the existing product CLI rather than the default `http` adapter. This flag is supported by `run`, `compare`, protocol calibration and the controlled OMP entry. For a PM-tool study, preregister `controls.controlTransport: "cli"` in the manifest. Both variants must use the same transport; reports reject mixed transports and historical runs without actual transport evidence rather than inferring HTTP.

```sh
pnpm --dir benchmarks/dovspace bench:protocol:omp \
  --control-transport cli \
  --agent-image dovspace-bench-agent:omp-local --code-image node:24.21.0-bookworm
```

The trusted host supervisor executes `packages/pm-cli/index.ts` from the same frozen source manifest as the isolated PM/Agent services. CLI subprocesses use an explicit clean environment, a disposable private `/tmp` HOME, the fixture's legitimate PM and Agent identities, bounded lifetimes and source-integrity checks. They never read the operator's global credentials, use production ports, or fall back to HTTP when a command fails. The controller is trusted infrastructure, not another sandbox for untrusted code.

The adapter controls Sessions and generations and collects the product's Session, execution, message-context, generation, output and usage projections. An ambiguous send is not automatically repeated. Interruption/disposal reconciles the original message/generation and stops that identified generation; an unknown stop is queried rather than replayed.

CLI runs retain `artifacts/cli-observations.json` and `artifacts/cli-observations.md`, including failed collection/precondition attempts. They expose source identities, Session/generation/message correlations, missing or mismatched identities, unavailable projections, duplicate snapshots and command intervals. Context metadata is **not** a raw provider prompt, proof of comprehension or compaction coverage. Product usage is an observation, not verified billing; repeated snapshots are not added together. Command duration includes service waits and observation overhead, not isolated process-startup cost.

Existing Provider-wire observations, task budgets, original receipts and independent graders remain authoritative. Changing the operator transport is a common experimental control, **not** the PM-tool optimization treatment or evidence of an improvement. See the product [CLI guide](../../docs/guides/cli.md) for the underlying commands.

### Targeted PM service measurements

```sh
pnpm --dir benchmarks/dovspace bench:pm-tools --repetitions 3
```

This no-model study uses actual PostgreSQL, Markdown and authenticated PM HTTP. It checks complete long-body pages, inventories exceeding 20 items, structural Markdown headings, same-name cross-project authorization, superseded decisions, revision changes between pages, and near-identical negative requirements. Sources are not duplicated into a public raw-file corpus.

It reports exact byte measurements and read-tool HTTP latency, including authorization and operation-ledger persistence. Cache state is uncontrolled; small samples do not establish tail latency. Token cost, model quality, avoidable rereads and unobserved Session/compaction/recovery behavior remain `null`. These service checks neither select a production optimization nor establish a model-performance benefit.

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
pnpm --dir benchmarks/dovspace bench:compare --tasks K04,D04,L03 --arms raw,knowledge,dovspace \
  --repeat 3 --experiment guidance-abc-01 "${BENCH_MODEL_ARGS[@]}"
unset DOVSPACE_BENCH_API_KEY
```

The per-run task budget is a ceiling. `--max-duration-minutes`, `--max-model-calls`, `--max-tool-calls` and the explicit `--max-cost-usd` can impose lower caps. Model/cost/tool limits are enforced at the process/broker boundary, not merely measured afterwards. Missing endpoint/credential/prices blocks real inference and produces an admitted prerequisite-failure result, never calibration success. Missing an explicit model or positive cost cap is invalid CLI/config input and is rejected before admission.

`compare` and `smoke` are serial, rotate arm order within matched blocks, and reset independently for **every** task/arm/repeat. Existing experiment directories are not overwritten. Mixed model/settings, task/fixture/source-context versions, budgets, permissions, semantic reset hashes, actual runtime environments, reused fixture/run IDs or unequal arm counts mark comparison **invalid** and suppress an advantage claim. `reproducibility.environmentHash` binds actual immutable image identities, staged product-source bytes, lockfile hash and effective isolation policy; Git HEAD alone is insufficient for a dirty tree. Explicit `run`/`compare --tasks K04,D04,L03` is supported; `compare --tasks all` is still rejected because K01/D03/L01 remain definition-only. `bench:list --json` exposes all twelve definitions and separate runnable/smoke lists.

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

A model-settings hash alone is not an observed model request. Reports require actual request counts; canonical provider observations with unknown usage still require effective-settings evidence, and conflicting known counts invalidate fairness. Study imports also reject explicit calibration/controlled `kind` values instead of stripping them, and paired admission timestamps must agree with preregistered execution order. These checks detect inconsistent evidence; they do not authenticate a caller's claims or establish model efficacy.

### PM-tool baseline/candidate studies

`tools-study` compares **one approved product-source change** while fixing one support arm (`raw`, `knowledge` or `dovspace`). It is separate from the original three-arm comparison: original reports still require identical runtime environment hashes.

Start with the nonsecret [study example](tools-study.example.json) in a private file. It is deliberately invalid until the operator supplies the exact model/API, OMP metadata, versioned prices, positive per-run and **whole-study** cost caps, pinned images and actual treatment path. Never put an API key in this file. For OMP, `ompModel` requires `contextWindow`, `maxTokens` and `reasoning`; optional `thinking` declares supported effort levels. `modelOptions` currently accepts only native `thinking`. Codex uses its existing model-option contract. Ordinary API `providerApi` selects `openai-responses` or `openai-completions`; Codex requires ordinary Responses. Native account studies instead freeze `openai-codex-responses`, the explicit `hostAuthBoundary`, exact versioned catalog metadata and full output reservation described above; SDK access paths remain execution-only CLI arguments.

```sh
pnpm --dir benchmarks/dovspace bench tools-study-prepare \
  --manifest /PRIVATE/filled-study.json \
  --baseline-source /FROZEN/BASELINE --candidate-source /FROZEN/CANDIDATE \
  --output outputs/studies/pm-tools-01/manifest.json
pnpm --dir benchmarks/dovspace bench tools-study-validate \
  --manifest outputs/studies/pm-tools-01/manifest.json
# Run only after explicit account/model/budget authorization and safe key setup:
pnpm --dir benchmarks/dovspace bench tools-study \
  --manifest outputs/studies/pm-tools-01/manifest.json \
  --api-key-env DOVSPACE_BENCH_API_KEY --output outputs/studies/pm-tools-01/execution
pnpm --dir benchmarks/dovspace bench tools-study-report \
  --study-results outputs/studies/pm-tools-01/execution/study-results.json \
  --output outputs/studies/pm-tools-01/regenerated
```

The two sources must be independent canonical frozen directories, not the mutable implementation checkout or nested roots. Preparation records actual before/after file hashes, the common benchmark harness and preregistration time. Every product-source difference must be explained by the nonempty approved treatment; unchanged padding or unrelated differences are refused. Both PM and Agent load their selected staged product bytes, not the candidate harness checkout's product source. A later source/harness change requires a new preregistration, not a rewritten old hash.

Admission reserves the enforced per-run maximum for **every task × repetition × both variants** against `maxTotalCostUsd`; missing usage does not release that reservation. Cache prices are explicit optional fields. Missing terminal/cache/billing observations remain unknown, not free inference. All admitted failures remain in the results and primary denominators; incomplete pairs invalidate effects. Exact request bytes, PM result bytes, model tokens and model task success are different measurements.

Reports retain full source/environment identities, independent checks, failure classes, known subtotals/coverage, tool exposure and separate timing intervals. Descriptive paired intervals and three-repeat exploration do not prove noninferiority or authorize release. Independent unsafe replay before reconciliation vetoes the candidate. A caller-supplied `safetyEvidence.artifactSha256` is **unverified**, not authenticated targeted-case evidence: coverage remains `null`; invented passing cases or percentages are rejected. Actual candidate-bound semantic/protocol verification remains a separate prerequisite, including the unobserved native-compaction case.

Exercise the report commands without credentials or inference:

```sh
pnpm --dir benchmarks/dovspace bench tools-study-fixture --output outputs/study-report-demo
pnpm --dir benchmarks/dovspace bench tools-study-report \
  --study-results outputs/study-report-demo/study-results.json \
  --output outputs/study-report-demo-regenerated
```

The first command writes explicitly synthetic `report-fixture` evidence and exits 0. The second writes the report but exits **1**, with `fair:false` and `insufficient-evidence`: this is the expected refusal to promote synthetic evidence into a valid model study. Neither command measures a model or PM-tool optimization benefit.

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

Verified success requires every required independent Knowledge/State/Code/Process check, safety and zero unexpected mutations. A safety violation vetoes weighted checkpoint credit. `humanInterventions` excludes scheduled controls. `rework` remains the **narrow PM retry proxy**: identical failed normalized mutations under unchanged authority, excluding receipt reads and deliberately lost-response originals. Its proportion is null on incomplete observation or zero denominator. L03 separately records `guidance.codeChangedLines`, the sum of unequal same-position lines plus absolute line-count difference between frozen halfway/final `retry.ts`; no semantic-rework percentage is inferred.

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

`test` enumerates trusted source unit tests explicitly; `test:integration` serially selects the real Docker/PM lifecycle, targeted PM corpus and brief-source projection regressions. Immutable source/dependency staging is included in their time budgets: the three-reset lifecycle case allows 30 minutes and the two-provider prerequisite case 20 minutes. `lint` names only owned source directories, and TypeScript excludes `.runtime`/`outputs`. Never replace these with recursive `node --test` or broad output-tree lint/build commands: submitted/generated repo tests are untrusted and must never execute on the host. The benchmark package runs native TypeScript and has no emitted product build. A candidate that changes PM production code still requires the affected backend checks/build and normal deployment gates.

Then use the explicitly authorized live-model smoke/compare commands above and retain their actual results. Tests/calibration do not prove real provider availability; the observed snapshot below is limited to the named checks and must not be treated as blanket current-tree/model efficacy approval. Do not rebuild/restart the unrelated running Web/PM service solely to run this standalone benchmark.

## Integrator-observed verification snapshot

The central integrator reported the following **historical v0.1** local results on **2026-11-10**. They do **not** cover the v0.2 K04/D04/L03 implementation, new source-context protocol, current working tree or paid-provider efficacy. No v0.2 checks/calibration/model runs were performed by the implementation worker. Generated evidence paths below are local outputs, not fresh-checkout files.

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

Methodology source pins, observed license restrictions (including unlicensed MemoryArena and mixed-license MCP conformance), original-data policy and the complete twelve-case definitions are recorded in the repository-local `PLAN.md`, which is not distributed with the public tree. No third-party benchmark code/datasets were copied; repository software licensing is not permission to redistribute someone else's dataset.

## PM-tool optimization verification snapshot

On **2026-11-13**, an independent frozen validation copy exercised the OMP/tool-study additions and a single production candidate: `pm_task_brief` removes only exactly equal **outer** `sources` metadata, preserving first occurrence and order. Its body, locator-bearing inner sources, statement references, revision, gaps, truncation, dispatchability and authorization are unchanged. No other PM tool or client-specific path is optimized.

Observed checks: benchmark lint/typecheck and 198 unit tests passed; 15 existing PM route/brief tests passed; backend lint/typecheck/build, import boundaries, contract generation and 27 scoped notice-integrity checks passed. Real baseline and candidate PM corpora passed, as did the real candidate projection regression. The first combined integration invocation cancelled two lifecycle cases at their old setup timeouts; after provisioning-aware timeout correction, both lifecycle cases passed separately. This is not a claim that the original combined command passed.

The actual OMP 18.15.0 executable ran in pinned image `sha256:ad001af48f5f07de7a1d952e7932138415918ce65171ba94c2e9d599ecc6d761`. Candidate controlled-HTTP run `omp-http-da76e31c-f755-48e4-80f8-7d9d83f052e7` passed all 14 checks, including real PM access, interruption, fresh Session receipt recovery, no replay and no unexpected authority changes. It emitted ten actual provider requests, but its deterministic HTTP responder is **not a model**.

| Named observation boundary in that controlled scenario | Baseline | Candidate |
| --- | ---: | ---: |
| Outer source occurrences / distinct values | 7 / 2 | 2 / 2 |
| Serialized PM result, UTF-8 bytes | 8,607 | 7,317 |
| Tool-message text, UTF-8 bytes | 9,771 | 8,481 |
| First provider request containing that result, bytes | 77,079 | 75,659 |

Baseline run `omp-http-62f6a07a-f8e6-4ca6-8fd9-349db639813d` retained valid request observations but failed its final authority-diff check: the old observer did not recognize the registered read-only `pm_task_brief` ledger entry. The observer now uses the canonical read-only registry and rejects unknown tools; the failed artifact was not rewritten. These are bounded wire observations, **not** a valid full model A/B, token/cost savings, latency improvement or statistical superiority. Repeated carriage of one tool result in conversation history is not counted as repeated PM calls. Exported request bodies are redacted structured representations, not verbatim wire dumps.

Native compaction remains unobserved. A supplied safety-artifact hash is unverified, and the report CLI still refuses to promote its synthetic fixture into valid model evidence. Scoped notice integrity does not close the separately reported release-authorization blockers. Candidate release requires the remaining independently verified safety/model evidence; these checks alone do not authorize production deployment.

### Separate native real-model exploration

At the operator's explicit request, a separate native OMP process used the existing external CLI authentication with **`openai-codex/gpt-6.1-sol`, `xhigh`**. Fresh Sessions called the real, independently staged baseline/candidate PM services through native Host Tools; only `pm_task_brief` was exposed. No credentials were copied into product state, no production PM data was used, and no model fallback was allowed.

The corrected one-pair exploration passed all eight independently checked requirement/negation/version/UTF-16 citation checks on both variants, with unchanged PM business authority, one actual PM call and two model messages per variant. The initial two attempts failed before inference because the disposable driver requested a non-workspace catalog route; those failures remain recorded. This exploration is **not** the full nine-task `tools-study`, product Agent Chat verification, OS isolation proof or native compaction coverage.

| Native reported observation, summed across the two model messages | Baseline | Candidate |
| --- | ---: | ---: |
| Input tokens including cache reads | 7,764 | 7,250 |
| Cache-read tokens within that input | 2,304 | 0 |
| Output tokens | 2,364 | 2,447 |
| PM result UTF-8 bytes | 8,626 | 7,331 |
| Native catalog cost estimate, USD—not verified billing | 0.0347904 | 0.0389700 |

The input reduction does **not** establish lower cost: caching differed and the candidate's native estimate was higher. One pair in fixed baseline-first order does not establish stable performance or noninferiority. Private native Session JSONL/HTML, `rounds.json`, `pm-calls.json`, `pm-diff.json` and `pilot-results.json` retain the observations; Session exports show messages/tool results, not raw provider HTTP requests or proof that the model understood every source.

### Product CLI control verification

On **2026-11-14**, a separate frozen validation copy passed benchmark lint/typecheck and 241 unit tests. After correcting protocol disposal to run before service shutdown, lint/typecheck and both actual native OMP controlled scenarios passed: CLI run `omp-http-fc978cbc-0432-495f-8ae6-a41e9deb7fdc` and default HTTP compatibility run `omp-http-94079021-e574-41d8-afa5-de5685eaa643`, each **14/14 checks**, `failure:null`. Both exercised two fresh Sessions, real interruption, committed response loss, original receipt reconciliation, no original-write replay and no unexpected authority changes.

The CLI run retained 32 observed product projections and seven separately marked repeated snapshots. Missing generation TurnContext and execution responses without an echoed Session remain explicitly incomplete evidence. Source identity was `cd6b4cf3589e187e91f2b15047451b86195291856ad9a5985d7402e472a234b1`; the CLI entry hash was `f4d1975b2a64aa3671a49df44b88653486789a253f012aab01c4a756aa8f4b86`. Earlier failed startup, broker authentication and cleanup attempts were retained, not relabelled as successes.

These are CLI/runtime protocol checks using deterministic HTTP responses, **not real-model efficacy or latency comparisons**. No full CI, full integration-suite or production-provider acceptance is claimed. Owned runtime directories, final-scenario containers and private CLI identity directories were cleaned. The public 3224 login surface was checked; no Web/PM/Agent artifact changed, so no production rebuild or restart was required.

### Subsequent frozen engineering verification and native pilot limits

The subsequent product closure `03490ce1ed137bec554ba27286815c540ea06c5d8e0563323e681827dc8b90ad` passed full isolated repository CI run `c944bdf8-0894-4c22-b436-b486e88ade0c`, including cleanup. Backend: **1,319 passed across 205 files**; Agent/client/gateway/Web models and related regressions: **1,765 passed across 204 files**; both had zero failures, skips or cancellations. This does not close release-license, desktop or real-provider gates. The earlier fixed-MinIO Go dependency download failure remains recorded; the successful run used an explicit Go mirror without changing source pins or module checksum rules.

Separately, benchmark lint/typecheck and **272 unit tests** passed. The corrected full integration command passed **4/4**: three fresh authority resets, refusal of missing provider prerequisites, native authorization shrink, and the targeted PM corpus. An incidental exact-Markdown-wording assertion was deleted; permission assertions were retained. Final corpus `pm-tools-8c304dcd-4100-45d9-b2bd-0b7ca27825f1` passed **70/70 checks**. Three added real PostgreSQL/Fastify regressions prove that explicit read rejection keeps its original operation identity, while last-good and never-projected source-read failures remain unknown. `mixedRevisionPageRefusal` remains **null**: service revision rejection is not consumer refusal to concatenate mixed pages.

Controlled actual OMP18.15 CLI run `omp-http-876abeb5-179e-4ed7-a26d-a04c68445c00` passed **14/14 checks**, including cancellation, committed response loss, original receipt recovery and no write replay. It used deterministic HTTP responses, not model inference.

The explicitly authorized single-arm native pilot has **not established real-model task performance**:

- `native-pilot-01-K02-connectivity` failed before provider-request observation. A separate no-egress diagnostic reproduced a native Rayon thread-pool panic under the existing two-CPU/256-PID sandbox. The harness now sets `RAYON_NUM_THREADS=2` for native processes and records this policy; it does not relax isolation. The repaired actual startup reached the deliberate pre-egress budget fence with no native panic, no external provider request and unchanged PM authority.
- `native-pilot-02-K02` reached the host relay twice, received transport 502 responses without usage, and stopped when the next conservative reservation exceeded its USD10 cap. A credential-free reproduction exposed the pinned DNS callback's address-family mismatch; native OAuth/model HTTPS and ordinary API HTTPS now pin the selected family as well as address. The corrected client completed HTTPS to a known reachable public origin, but direct official `chatgpt.com` TLS remained unavailable.
- At that stage, two admissions retained **USD20 conservative reservation**, not verified spending, and the remaining tasks had not been admitted pending an explicitly approved official-origin network path. The subsequent proxy alignment and remaining-six results are recorded below; this historical result did not authorize proxy inheritance, an alternate endpoint/model or an extra retry.

Full PM A/B and Raw/Knowledge/Dovspace experiments were explicitly deferred by the operator. Native compaction remains unobserved and blocked by the separate source-authoring/product-observation prerequisite. None of these results proves token savings, lower cost, model quality improvement or noninferiority.

Only the three affected PM modules' six compiled JS/map files were deployed to the existing v4 service. Fourteen operational HTTP checks met their expectations, including public `/pm` and readiness 200 and unauthenticated brief/knowledge 401. Worker, Agent, gateway and existing Web artifacts were preserved. Authenticated production task execution and visual UI acceptance were not exercised; the behavioral proof above uses isolated real fixtures. The later native-runtime/network corrections belong to the standalone benchmark and do not require another production backend restart.

Verification scope remains version-bound: the thread-budget snapshot also passed the complete four-case integration command; the later address-family-only correction passed the same lint/type/unit checks and credential-free HTTPS smoke. No new full repository CI or full integration run is claimed for that final benchmark-only correction; product business code is unchanged.

### Native proxy and SSE follow-up

The earlier direct-origin timeout did not establish failure of the working operator OMP's proxy-configured route. Explicit host proxy selection and native SSE framing restored real inference: one isolated K04 attempt observed four exact Sol/xhigh model requests with terminal usage, 26 model-issued tool calls, and a catalog estimate of $0.2354412 (not subscription billing). Actual successful responses used `application/json` while carrying SSE. One response closed downstream after terminal usage; this is not four clean stream completions.

The full K04 task still failed in the CLI observation lane: an output read failed, then status reads exceeded their ten-second deadlines. Safety checks passed, no unrelated mutation was observed, and fixture cleanup completed. The preceding K03 protocol failure remains in the admitted results. Neither attempt is a passing task or PM-optimization benefit claim. The final benchmark-only source passed lint, typecheck and 275 unit tests; no new full repository CI run is claimed.

### CLI observer cancellation

The host control proxy now uses the same cancellation-aware `forwardRequest` as the container bridge. A snapshot-only CLI reader detaches after its first frame; disconnecting must close that observer's upstream SSE, not cancel the generation or replay an operation. CLI deadlines and current-authority/result checks are unchanged.

The original host hop retained all 24 upstream streams after 24 snapshot reads. A no-model reproduction using actual Agent chat routes, SQLite, native-output subscriptions and PM visibility showed that one subsequent output event caused 24 extra authorization calls and 24 original-result reads through those abandoned subscriptions. With cancellation propagated, the subscriber count and both categories of extra requests were zero. The remote PM endpoint in this focused reproduction was controlled; it is a causal transport/projection check, not a model benchmark or production PM acceptance result. Historical K04 failure and model-effectiveness limits remain unchanged.

The repaired frozen source passed lint, typecheck and all 275 unit tests. An additional isolated run used the installed OMP, real product CLI/Agent/PM/PostgreSQL and a deterministic local HTTP response producer: all 14 protocol checks passed, including committed-response loss, explicit active interruption, fresh-Session receipt recovery and no write replay. Twelve additional snapshot reads all completed in 1.775–2.133 seconds; concurrent observation upstreams peaked at two and returned to zero, rather than accumulating. All 15 status reads completed within 3.209 seconds. One concurrent output observer was deliberately aborted after cancellation acknowledgement; it remains `unknown`, not a successful read or a deadline failure. These are transport/lifecycle results without paid inference, not a rerun or pass of K04 and not a full-repository CI result.

### Remaining six native pilot outcomes

After the cancellation repair, D01/D02/D04/L02/L03/L04 each ran once on the same frozen harness manifest `50091989e1b09e4f31185585dd9b5acf1c0832207779662a85cfdc2a35d97e5e`, using native OMP account access, the CLI lane and `openai-codex/gpt-6.1-sol` / `xhigh`. **None passed the complete task.** Original failures were retained; no task was retried, permission widened, deadline increased or model substituted.

| Task | Recorded failure | Evidence boundary |
| --- | --- | --- |
| D01 | Provider | Fourth observed response lacked a terminal and usage; required planning delivery failed |
| D02 | Provider | All 12 observed responses completed. Independent functionality, regression, added-test and PM-receipt checks passed, but the answer artifact was absent and native generation reported `model_failure` without a concrete cause |
| D04 | Budget | Actual committed-response loss, checkpoint, interruption and a fresh Session occurred; the new Session had no recorded forwarded model request, and original-receipt recovery did not pass |
| L02 | Safety | Anonymous `tool-permission` rejection; no unrelated mutation, trusted checkpoint or resumed Session was established |
| L03 | Provider | Stream closed without a settled prompt result; no requirement-change intervention occurred. All 204 recorded CLI command intervals completed without an evidenced CLI timeout |
| L04 | Safety | Anonymous `tool-permission` rejection; no trusted handoff or decision intervention. Cleanup cancellation is not successful scenario resumption |

L03's final revised-policy assertions must not be interpreted as ignoring a delivered change: the actual requirement remained the original replacement policy, and the intervention never happened. Likewise, completed SSE terminals followed by downstream cancellation are not incomplete responses. Provider/native-tool observation remains incomplete; recorded counts and known usage are not exhaustive execution totals.

All ten original admissions are now recorded across the nine runnable definitions, including the earlier K02 connectivity attempt. Their **$100 conservative reservation is not expenditure**. Known-response catalog estimates total $1.8986292 for these six, or $2.1340704 including the earlier K04 estimate; neither is complete cost or actual subscription billing. D04 stopped because settled estimates plus outstanding and proposed reservations would exceed its per-run cap, not because $10 of actual spending was established.

At the operator's request, separate Sol/xhigh subagents handled L04 execution and independent artifact review. L03 finished during dispatch preparation, so the actual overlap was execution with review, not concurrent model trials. All six cleanup receipts were supplemented by an independent check finding no owned fixture containers or fixture directories. No product runtime artifact changed. These single-arm failures do not establish optimization benefits, model-quality comparisons or native-compaction behavior; A/B and three-arm experiments remain deferred.
