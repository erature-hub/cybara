---
name: local-inference-audit
description: Audit a local inference deployment and prove it is fully local, covering runtime reachability, model inventory, embedding path, and outbound-network exposure.
metadata: {"cybara":{"requires":{"bins":["bun"]},"homepage":"https://github.com/erature-hub/cybara/blob/main/docs/local-first.md"}}
---

# Local Inference Audit

Use this when a task depends on the agent running without a hosted provider, when a local
deployment is reported as slow or incomplete, or when the operator needs proof that no
traffic leaves the host.

## Workflow

1. **Inventory the runtimes.** Run the `local_provider_health` tool. It probes each local
   runtime, reports whether it is reachable, and lists the models it holds. Start here rather
   than guessing which runtime the agent is bound to.
2. **Classify the models.** Separate chat models from embedding models. An embedding model
   reports the `embedding` capability; it is not a candidate for the chat role, and treating
   one as a chat model produces empty or malformed responses.
3. **Check the context window against the workload.** The health report carries the context
   length each model was built with. A model whose window is smaller than the transcript it
   receives will compact early or fail outright.
4. **Verify the provider binding.** Confirm the agent is actually pointed at the local
   provider and not a hosted fallback. The router status endpoint reports which providers are
   available.
5. **Prove the boundary.** Enable offline mode and re-run a turn that would normally fetch a
   URL. The tool must be blocked. If it succeeds, the guard is not active on that path.
6. **Record the result.** Report the reachable runtimes, the model inventory with context
   windows, the embedding model, and the verdict: local-only, hybrid, or blocked.

## Verification

- Every reachable runtime reports a version and a model list.
- The chat model used by the agent appears in the inventory with its context window.
- An embedding model is configured separately from the chat model.
- The provider binding points at a loopback address.
- Offline mode blocks a network-capable tool.

## Safety

- Treat a local runtime as a production dependency. It is the same class of thing as a hosted
  provider endpoint, and the same verification discipline applies.
- Do not pull a large model to "test" it. Check what is already loaded first, and confirm the
  size and disk cost before any download.
- Do not report a runtime as reachable on the basis of a process list. Probe the endpoint.
- Never record a local model path or a host address in a shared report without checking it is
  not sensitive.

## Boundaries

Local inference removes provider calls, not every network path. Tool fetches, registry
installs, update checks, and marketplace catalogs still reach the network unless they are
disabled or the host is fenced. Audit those paths separately from the provider path.
