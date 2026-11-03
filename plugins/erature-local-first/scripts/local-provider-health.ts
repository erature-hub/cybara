#!/usr/bin/env bun
/**
 * Probe the local inference runtimes and report what each one holds.
 *
 * Reads a JSON payload on stdin (the plugin tool contract) and writes a JSON
 * result on stdout. Exits non-zero only when the payload itself is unusable.
 */

interface RuntimeProbe {
  id: string;
  url: string;
}

interface RuntimeReport {
  id: string;
  url: string;
  reachable: boolean;
  version?: string;
  models: Array<{ name: string; parameterSize?: string; quantization?: string; contextLength?: number; capabilities?: string[] }>;
  error?: string;
}

const DEFAULT_RUNTIMES: RuntimeProbe[] = [
  { id: "ollama", url: "http://localhost:11434" },
  { id: "vllm", url: "http://127.0.0.1:8000" },
];

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk as Uint8Array);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

function parsePayload(raw: string): { runtimes: RuntimeProbe[] } {
  if (!raw.trim()) return { runtimes: DEFAULT_RUNTIMES };
  const parsed = JSON.parse(raw) as { args?: { runtimes?: unknown } };
  const requested = parsed.args?.runtimes;
  if (!Array.isArray(requested) || requested.length === 0) {
    return { runtimes: DEFAULT_RUNTIMES };
  }
  const runtimes = requested.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const url = typeof record.url === "string" ? record.url.trim() : "";
    return id && url ? [{ id, url }] : [];
  });
  return { runtimes: runtimes.length > 0 ? runtimes : DEFAULT_RUNTIMES };
}

async function probeOllama(baseUrl: string): Promise<RuntimeReport> {
  const versionResponse = await fetch(`${baseUrl}/api/version`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!versionResponse.ok) {
    throw new Error(`version endpoint returned ${versionResponse.status}`);
  }
  const versionBody = (await versionResponse.json()) as { version?: string };

  const tagsResponse = await fetch(`${baseUrl}/api/tags`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!tagsResponse.ok) {
    throw new Error(`tags endpoint returned ${tagsResponse.status}`);
  }
  const tagsBody = (await tagsResponse.json()) as {
    models?: Array<{
      name?: string;
      details?: {
        parameter_size?: string;
        quantization_level?: string;
        context_length?: number;
      };
      capabilities?: string[];
    }>;
  };

  const models = (tagsBody.models ?? [])
    .filter((model) => typeof model.name === "string")
    .map((model) => ({
      name: model.name as string,
      parameterSize: model.details?.parameter_size,
      quantization: model.details?.quantization_level,
      contextLength: model.details?.context_length,
      capabilities: model.capabilities,
    }));

  return {
    id: "ollama",
    url: baseUrl,
    reachable: true,
    version: versionBody.version,
    models,
  };
}

async function probeOpenAiCompatible(baseUrl: string): Promise<RuntimeReport> {
  const response = await fetch(`${baseUrl}/v1/models`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`models endpoint returned ${response.status}`);
  }
  const body = (await response.json()) as { data?: Array<{ id?: string }> };
  const models = (body.data ?? [])
    .filter((model) => typeof model.id === "string")
    .map((model) => ({ name: model.id as string }));
  return {
    id: "openai-compatible",
    url: baseUrl,
    reachable: true,
    models,
  };
}

async function probe(runtime: RuntimeProbe): Promise<RuntimeReport> {
  try {
    if (runtime.id === "ollama") return await probeOllama(runtime.url);
    return await probeOpenAiCompatible(runtime.url);
  } catch (error) {
    return {
      id: runtime.id,
      url: runtime.url,
      reachable: false,
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  let payload: { runtimes: RuntimeProbe[] };
  try {
    payload = parsePayload(await readStdin());
  } catch {
    payload = { runtimes: DEFAULT_RUNTIMES };
  }

  const reports: RuntimeReport[] = [];
  for (const runtime of payload.runtimes) {
    reports.push(await probe(runtime));
  }

  const reachable = reports.filter((report) => report.reachable);
  const modelCount = reachable.reduce((sum, report) => sum + report.models.length, 0);
  const chatModels = reachable.flatMap((report) =>
    report.models.filter(
      (model) =>
        !model.capabilities ||
        model.capabilities.includes("completion") ||
        model.capabilities.includes("tools")
    )
  );

  console.log(
    JSON.stringify(
      {
        ok: reachable.length > 0,
        runtimesChecked: reports.length,
        runtimesReachable: reachable.length,
        modelCount,
        chatModelCount: chatModels.length,
        embeddingModels: reachable
          .flatMap((report) => report.models)
          .filter((model) => model.capabilities?.includes("embedding"))
          .map((model) => model.name),
        reports,
      },
      null,
      2
    )
  );
}

await main();
