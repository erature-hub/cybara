# Erature Local-First Eval

This eval records what a fully local Cybara deployment actually exposes, measured against a
real Ollama runtime rather than a synthetic fixture. It is the fork's baseline for the
local-first claim: the numbers below are reproducible on any host with the same runtime
version and model set.

## Recorded environment

| Property | Value |
|---|---|
| Runtime | Ollama 0.40.13 |
| Runtime endpoint | `http://127.0.0.1:11434` |
| Embedding model | `bge-m3:latest` (566.70M, F16, 8192 context) |
| Secondary embedding model | `nomic-embed-text:latest` (137M, F16, 2048 context) |
| Local chat model | `gemma3:4b` (3.9B, Q4_K_M, 131072 context, completion + vision) |
| Local chat model | `d1:latest` (2.7B, Q8_0, 32768 context, decision + vision) |
| Cloud models reachable through the same runtime | `glm-5.3:cloud`, `glm-5.3-flash:cloud`, `deepseek-v4.1-flash:cloud`, `minimax-m3.1-flash:cloud`, `gpt-oss:120b-cloud`, `gemma4:31b-cloud` |

Total models visible at the runtime endpoint: 12. Chat-capable: 7. Embedding-capable: 2.

## Model classification

The runtime reports capabilities per model. This is the distinction that matters when
pointing an agent at a local deployment:

| Capability | Meaning | Use for |
|---|---|---|
| `completion` | Generates text | Chat |
| `tools` | Supports tool calling | Agentic chat |
| `thinking` | Emits reasoning | Deliberate tasks |
| `vision` | Accepts images | Multimodal |
| `embedding` | Produces vectors | Retrieval only |
| `decision` | Classification output | Scoring, not chat |

Two models in this inventory report `decision` rather than `completion`. Neither is a chat
model. Selecting one as the chat model produces empty or malformed responses, which is the
most common local-deployment failure.

## Reproduction

The inventory above is produced by the bundled plugin tool, which probes the runtime and
classifies the results:

```bash
cybara plugin install ./plugins/erature-local-first
cybara plugin enable erature-local-first
```

Then, from an agent session, call `local_provider_health`. The tool returns the reachable
runtimes, the version, the full model list with parameter size, quantization, context length,
and capabilities, and separates the embedding models from the chat models.

The same probe runs headless:

```bash
echo '{"args":{"runtimes":[{"id":"ollama","url":"http://localhost:11434"}]}}' \
  | bun run plugins/erature-local-first/scripts/local-provider-health.ts
```

## What this eval does and does not establish

**Established.** A local runtime exposes a complete, discoverable model inventory through a
loopback endpoint. Model discovery, capability classification, and context-window reporting
are automated and need no credential. The chat model and the embedding model are separate
concerns with separate configuration.

**Not established.** This record contains no latency, throughput, or quality measurement. The
chat probe against `gemma3:4b` did not complete within the observation window on the
recording host, so no completion timing is reported here. A latency or quality claim without
a completed measurement would be a guess, and a guess in a benchmark file is worse than an
absent number, because the next person cannot tell which entries were measured and which
were assumed.

## Next measurements

The following belong in this eval once they are measured on a quiet host, each recorded with
the runtime version, the exact model tag, and the prompt used:

1. **First-token latency and completion latency** for a fixed short prompt, reported per
   model tag and per quantization.
2. **Tool-calling conformance**: whether the local model emits a valid tool call under the
   runtime's tool-capability flag, and whether the arguments survive a compaction event.
3. **Retrieval quality** using the embedding model against a fixed corpus, scored against the
   same corpus with a hosted embedding model as the reference.
4. **Context retention** at the model's declared window, and where compaction actually
   triggers relative to that declared window.

Until each of those exists as a measured value in this directory, it is not a result.

## Reading the corpus

The `docs/evals` directory holds dated evaluation runs. Each entry is a point-in-time
artifact: the tasks, the run configuration, and the observed output for that run. Comparing
two dated entries over the same task set shows how a change to the runtime, the model, or
the prompt composition moved the result.
