# Local-First Operation

Cybara runs fully offline against a local inference runtime. No hosted provider, no API key,
and no outbound network call is required for the core loop: session capture, tool use, plan
management, and artifact production all execute on the machine that hosts the gateway.

This guide covers the runtime path, the provider wiring, the local embedding path, and the
verification steps that prove an installation is genuinely self-contained.

## Runtime path

Cybara routes every provider request through one Bun gateway. For a local runtime the gateway
is the only network participant, and it talks to a loopback address:

```
client -> cybara gateway (127.0.0.1) -> local runtime (127.0.0.1) -> response
```

No traffic leaves the host. That property is what makes an air-gapped deployment viable, and it
is the reason the fork publishes a credential-free CLI release channel: a local install has
nothing to authenticate against.

## Local runtimes

Cybara registers these credential-free local provider types in its provider catalog:

| Provider type | Runtime | Default base URL | Auth |
|---|---|---|---|
| `ollama` | Ollama | `http://localhost:11434/v1` | None |
| `vllm` | vLLM (OpenAI-compatible) | `http://127.0.0.1:8000/v1` | None |
| `lmstudio` | LM Studio | Local | None |
| `llamacpp` | llama.cpp | Local | None |
| `sglang` | SGLang | Local | None |
| `ds4` | ds4 | Local | None |
| `inferrs` | Inferrs | Local | None |

Each of these uses `authType: "none"`. A local provider needs no API key, so it is seeded
automatically on first run without an onboarding prompt.

### Ollama

Ollama exposes an OpenAI-compatible surface at `/v1`, so it works with the standard
`openai-completions` transport.

```bash
# Verify the runtime is up
curl -s http://127.0.0.1:11434/api/version

# List the models it already holds
curl -s http://127.0.0.1:11434/api/tags
```

Cybara discovers Ollama models automatically through `GET /api/tags` and registers each one
with a discovered context window of 128000 and a max output of 8192 tokens. Discovery is
best-effort: if the runtime is unreachable, the provider is still configured and the model list
can be set explicitly.

To configure it:

```bash
cybara provider add ollama --name "Local Ollama" --default
cybara provider models ollama
```

To point at a runtime on another host or a non-default port, set the base URL when adding the
provider and use a model id exactly as Ollama reports it:

```bash
cybara provider add ollama --name "Ollama LAN" --base-url "http://192.168.1.20:11434/v1"
```

### vLLM and other OpenAI-compatible servers

Anything that serves the OpenAI API shape can be used. Start the server, then register it:

```bash
cybara provider add vllm --name "Local vLLM" --default
```

The model id is the one the server reports. For a vLLM deployment started with
`--served-model-name`, use that name verbatim.

## Embeddings

Embeddings are a separate concern from chat. The embedding runtime is selected independently, so
a fully offline setup keeps the chat runtime and the embedding runtime on loopback as well.

Ollama serves embedding models through the same `/api` surface. A common local choice is a
multilingual BGE-family model:

```bash
ollama pull bge-m3
```

Embedding models are identified by their capability rather than their chat interface. When
listing Ollama models, an embedding model reports the `embedding` capability instead of
`completion`. Configure the embedding provider in Settings, or through the provider API:

```bash
curl -X POST http://127.0.0.1:4269/api/providers \
  -H "Content-Type: application/json" \
  -d '{"provider":"ollama","name":"Local Embeddings","base_url":"http://localhost:11434/v1"}'
```

## Air-gapped checklist

Work through this list to confirm the installation makes no outbound call.

1. **Confirm the provider is local.** `GET /api/providers/available` lists the configured
   provider types. A local runtime must show one of the credential-free types above.
2. **Confirm no cloud provider is selected.** The router reports provider availability at
   `GET /api/router/status`. A local-only deployment should show no cloud route as available.
3. **Block egress and re-test.** Run a chat turn with outbound traffic blocked. The turn must
   complete using local inference.
4. **Confirm the reported channel.** `GET /api/build-info` returns the version and the release
   channel. A fork build reports `release_channel: "fork"`.
5. **Confirm no credential is stored.** `cybara doctor` reports the configured providers and
   their auth state. A local-only deployment has no API key material.

## What still reaches the network

Local inference removes provider calls. It does not remove every network path, and it should
not be presented as if it does:

- **Tool fetches.** An agent that reads a URL reaches that URL. Restrict the tool profile for
  air-gapped work.
- **Registry installs.** Installing a skill or plugin from a registry resolves that registry.
  Pre-stage bundles locally instead.
- **Update checks.** The self-updater contacts the release repository to compare versions.
  Disable it where outbound access is not permitted.
- **Marketplace catalogs.** The plugin marketplace fetches a catalog. Use local and workspace
  plugin roots in air-gapped installations.

The gateway binds to `127.0.0.1` by default and only listens on all interfaces when started
with `--expose`. Keep the default in air-gapped deployments.

## Verification

`cybara doctor` reports the runtime, the configured providers, the resolved release channel,
and the gateway binding. Run it after any provider change. The full output, including the
version string with its channel marker, is the correct artifact to attach to a bug report.

See [Providers](./providers.md) for hosted provider configuration, account pools, and router
enforcement, and [Configuration](./configuration.md) for the gateway and update-check settings.
