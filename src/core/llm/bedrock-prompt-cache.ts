import type {
  ContentBlock,
  ConverseCommandInput,
  Message,
  SystemContentBlock,
  Tool,
} from "@aws-sdk/client-bedrock-runtime";

const MAX_CACHE_POINTS = 4;
const TRAILING_USER_CACHE_POINTS = 2;
const CACHEABLE_MODEL_PATTERN = /anthropic\.claude|amazon\.nova/i;

export function supportsBedrockPromptCache(modelId: string): boolean {
  return CACHEABLE_MODEL_PATTERN.test(modelId);
}

function cachePointBlock(): ContentBlock {
  return { cachePoint: { type: "default" } } as ContentBlock;
}

function isCachePoint(block: unknown): boolean {
  return typeof block === "object" && block !== null && "cachePoint" in block;
}

function withTrailingCachePoint(message: Message): Message {
  const content = (message.content ?? []).filter((block) => !isCachePoint(block));
  if (content.length === 0) return message;
  return { ...message, content: [...content, cachePointBlock()] };
}

export function applyBedrockPromptCache(payload: ConverseCommandInput): ConverseCommandInput {
  if (!payload.modelId || !supportsBedrockPromptCache(payload.modelId)) return payload;

  let used = 0;
  const next: ConverseCommandInput = { ...payload };

  const system = (payload.system ?? []).filter((block) => !isCachePoint(block));
  const tools = (payload.toolConfig?.tools ?? []).filter((tool) => !isCachePoint(tool));

  if (system.length > 0) {
    next.system = [...system, { cachePoint: { type: "default" } } as SystemContentBlock];
    used += 1;
  } else if (tools.length > 0 && payload.toolConfig) {
    next.toolConfig = {
      ...payload.toolConfig,
      tools: [...tools, { cachePoint: { type: "default" } } as Tool],
    };
    used += 1;
  }

  const messages = [...(payload.messages ?? [])];
  const userIndexes = messages
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0);
  const budget = Math.min(TRAILING_USER_CACHE_POINTS, MAX_CACHE_POINTS - used);
  const targets = budget > 0 ? userIndexes.slice(-budget) : [];
  for (const index of targets) {
    const message = messages[index];
    if (message) messages[index] = withTrailingCachePoint(message);
  }
  next.messages = messages;
  return next;
}
