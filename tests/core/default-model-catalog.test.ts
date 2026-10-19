import { afterEach, describe, expect, test } from "bun:test";
import {
  resolveModelContextWindowTokens,
  resolveModelMaxOutputTokens,
} from "../../src/core/agent-model-limits";
import { tables } from "../../src/core/database";
import { shouldSendAnthropicContext1mBeta } from "../../src/core/llm/anthropic-request-options";
import { providerManager, providers, type ProviderType } from "../../src/core/providers";
import { preferCatalogLimit } from "../../src/core/providers/model-limit-placeholders";
import { getPricing } from "../../src/core/router";

const createdProviderIds: string[] = [];

afterEach(() => {
  for (const providerId of createdProviderIds.splice(0)) providerManager.delete(providerId);
});

interface CatalogEntry {
  id: string;
  context?: number;
  maxTokens?: number;
}

function entry(provider: keyof typeof providers, id: string): CatalogEntry | undefined {
  return (providers[provider].models as readonly CatalogEntry[]).find((model) => model.id === id);
}

const ONE_M = { context: 1000000, maxTokens: 128000 };
const GPT_6 = { context: 1050000, maxTokens: 128000 };

describe("current Claude models ship in the default catalog", () => {
  const claude = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

  test("on the Anthropic API and the Anthropic subscription, with 1M context and 128K output", () => {
    for (const provider of ["anthropic", "anthropic-oauth"] as const) {
      for (const id of [...claude, "claude-mythos-5-1"]) {
        expect(entry(provider, id)).toMatchObject(ONE_M);
      }
    }
  });

  test("on Vertex, Bedrock and OpenRouter under each platform's model id", () => {
    for (const id of claude) expect(entry("anthropic_vertex", id)).toMatchObject(ONE_M);
    for (const id of claude)
      expect(entry("bedrock", `global.anthropic.${id}`)).toMatchObject(ONE_M);
    for (const id of [
      "anthropic/claude-fable-5.1",
      "anthropic/claude-opus-5.5",
      "anthropic/claude-sonnet-5.5",
      "anthropic/claude-haiku-5.5",
    ]) {
      expect(entry("openrouter", id)).toMatchObject(ONE_M);
    }
  });

  test("Haiku 5.5 is priced and treated as natively 1M", () => {
    expect(getPricing("anthropic", "claude-haiku-5-5")).toMatchObject({
      inputPerM: 0.1,
      outputPerM: 0.5,
    });
    expect(getPricing("anthropic", "claude-mythos-5-1")).toMatchObject({
      inputPerM: 10,
      outputPerM: 50,
    });
    expect(shouldSendAnthropicContext1mBeta("claude-haiku-5-5", true)).toBe(false);
  });
});

describe("current OpenAI and xAI models ship in the default catalog", () => {
  test("GPT-6 family on the OpenAI API and OpenRouter with 1.05M context and 128K output", () => {
    for (const id of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]) {
      expect(entry("openai", id)).toMatchObject(GPT_6);
      expect(entry("openrouter", `openai/${id}`)).toMatchObject(GPT_6);
    }
    expect(entry("openrouter", "openai/gpt-6-astra-pro")).toMatchObject(GPT_6);
    expect(entry("openrouter", "openai/gpt-6.1-sol-pro")).toMatchObject(GPT_6);
    expect(entry("openai", "gpt-5.6-cyber")).toMatchObject({ context: 400000, maxTokens: 128000 });
  });

  test("Grok 4.7 with its 500K context", () => {
    for (const provider of ["xai", "xai-oauth"] as const) {
      expect(entry(provider, "grok-4.7")).toMatchObject({ context: 500000 });
    }
  });
});

describe("limits for models an existing provider learned before they were in the catalog", () => {
  function providerWithStoredRow(
    provider: ProviderType,
    modelId: string,
    context: number,
    maxTokens: number
  ): string {
    const created = providerManager.create({ provider, name: `limits ${modelId}` });
    createdProviderIds.push(created.id);
    tables.providerModels.deleteByProvider(created.id);
    tables.providerModels.upsert({
      id: crypto.randomUUID(),
      provider_id: created.id,
      model_id: modelId,
      model_name: modelId,
      context_window: context,
      max_tokens: maxTokens,
      reasoning: true,
      input_types: ["text"],
    });
    return created.id;
  }

  test("a discovered row with the 8192 output placeholder uses the catalog's real output limit", () => {
    const providerId = providerWithStoredRow("openai-codex", "gpt-6.1-sol", 872000, 8192);
    expect(resolveModelContextWindowTokens("openai-codex", providerId, "gpt-6.1-sol")).toBe(872000);
    expect(resolveModelMaxOutputTokens("openai-codex", providerId, "gpt-6.1-sol")).toBe(128000);
  });

  test("a model the catalog does not know keeps whatever limits were stored", () => {
    const providerId = providerWithStoredRow("openai", "gpt-unlisted-test", 64000, 8192);
    expect(resolveModelMaxOutputTokens("openai", providerId, "gpt-unlisted-test")).toBe(8192);
  });
});

describe("catalog limits only replace discovery placeholders", () => {
  test("missing values fall back to the catalog", () => {
    expect(preferCatalogLimit(undefined, 8192, 128000)).toBe(128000);
    expect(preferCatalogLimit(null, 8192, 128000)).toBe(128000);
    expect(preferCatalogLimit(0, 8192, 128000)).toBe(128000);
  });

  test("the placeholder is replaced only by a larger catalog value", () => {
    expect(preferCatalogLimit(8192, 8192, 128000)).toBe(128000);
    expect(preferCatalogLimit(8192, 8192, 4096)).toBe(8192);
    expect(preferCatalogLimit(8192, 8192, undefined)).toBe(8192);
  });

  test("a real stored value always wins", () => {
    expect(preferCatalogLimit(64000, 8192, 128000)).toBe(64000);
    expect(preferCatalogLimit(872000, 128000, 1050000)).toBe(872000);
  });
});
