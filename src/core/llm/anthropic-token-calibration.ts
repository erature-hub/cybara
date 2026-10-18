import { estimateRequestValueChars } from "./context-estimate";

export const ANTHROPIC_DEFAULT_CHARS_PER_TOKEN = 3;
const MIN_CHARS_PER_TOKEN = 1.5;
const MAX_CHARS_PER_TOKEN = 4;
const MIN_CALIBRATION_CHARS = 20_000;
const CONTEXT_INPUT_SHARE = 0.75;
const PROMPT_TOO_LONG_PATTERN = /prompt is too long:\s*([\d,]+)\s*tokens?\s*>\s*([\d,]+)/i;
const INPUT_AND_MAX_TOKENS_PATTERN =
  /input length and `?max_tokens`? exceed context limit:\s*([\d,]+)\s*\+\s*([\d,]+)\s*>\s*([\d,]+)/i;

export interface AnthropicTokenCalibration {
  charsPerToken: number;
}

export interface AnthropicReportedOverflow {
  inputTokens: number;
  limitTokens: number;
}

function parseCount(value: string | undefined): number {
  return Number((value ?? "").replace(/,/g, ""));
}

function clampCharsPerToken(value: number): number {
  return Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, value));
}

export function createAnthropicTokenCalibration(): AnthropicTokenCalibration {
  return { charsPerToken: ANTHROPIC_DEFAULT_CHARS_PER_TOKEN };
}

export function anthropicRequestChars(requestBody: Record<string, unknown>): number {
  return (
    estimateRequestValueChars(requestBody.system) +
    estimateRequestValueChars(requestBody.messages) +
    estimateRequestValueChars(requestBody.tools) +
    estimateRequestValueChars(requestBody.tool_choice)
  );
}

export function observeAnthropicInputTokens(
  calibration: AnthropicTokenCalibration,
  requestChars: number,
  reportedInputTokens: number | undefined
): boolean {
  if (!reportedInputTokens || reportedInputTokens <= 0 || requestChars < MIN_CALIBRATION_CHARS) {
    return false;
  }
  calibration.charsPerToken = clampCharsPerToken(requestChars / reportedInputTokens);
  return true;
}

export function parseAnthropicOverflowError(
  errorText: string
): AnthropicReportedOverflow | undefined {
  const promptTooLong = PROMPT_TOO_LONG_PATTERN.exec(errorText);
  if (promptTooLong) {
    const inputTokens = parseCount(promptTooLong[1]);
    const limitTokens = parseCount(promptTooLong[2]);
    if (inputTokens > 0 && limitTokens > 0) return { inputTokens, limitTokens };
  }
  const withOutput = INPUT_AND_MAX_TOKENS_PATTERN.exec(errorText);
  if (withOutput) {
    const inputTokens = parseCount(withOutput[1]);
    const limitTokens = parseCount(withOutput[3]);
    if (inputTokens > 0 && limitTokens > 0) return { inputTokens, limitTokens };
  }
  return undefined;
}

export function observeAnthropicOverflow(
  calibration: AnthropicTokenCalibration,
  requestBody: Record<string, unknown>,
  errorText: string
): boolean {
  const reported = parseAnthropicOverflowError(errorText);
  if (!reported) return false;
  return observeAnthropicInputTokens(
    calibration,
    anthropicRequestChars(requestBody),
    reported.inputTokens
  );
}

export function isAnthropicInputAndOutputOverflow(errorText: string): boolean {
  return INPUT_AND_MAX_TOKENS_PATTERN.test(errorText);
}

export function anthropicContextBudgetChars(
  calibration: AnthropicTokenCalibration,
  contextWindowTokens: number
): number {
  return Math.max(
    4096,
    Math.floor(contextWindowTokens * calibration.charsPerToken * CONTEXT_INPUT_SHARE)
  );
}

export function estimateAnthropicTokensFromChars(
  calibration: AnthropicTokenCalibration,
  chars: number
): number {
  return Math.max(1, Math.ceil(chars / calibration.charsPerToken));
}
