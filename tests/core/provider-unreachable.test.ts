import { afterAll, describe, expect, test } from "bun:test";
import { describeProviderConnectionFailure } from "../../src/core/agent-error-format";
import { classifyApiError, summarizeClassifiedError } from "../../src/core/error-classifier";
import { providerExceptionRetryDelayMs } from "../../src/core/provider-retry";

function fetchError(code: string, message: string): TypeError {
  return Object.assign(new TypeError(message), { code, errno: 0, path: "http://127.0.0.1:11434" });
}

const bun142Refused = fetchError(
  "ConnectionRefused",
  "Unable to connect. Is the computer able to access the url?"
);
const bun143Refused = fetchError(
  "ECONNREFUSED",
  "ECONNREFUSED: Unable to connect. Is the computer able to access the url?"
);

describe("refused provider connections", () => {
  for (const [label, error] of [
    ["Bun 1.4.2 shape", bun142Refused],
    ["Bun 1.4.3 shape", bun143Refused],
  ] as const) {
    test(`are unreachable, not retryable (${label})`, () => {
      const classified = classifyApiError({ error });
      expect(classified.category).toBe("unreachable");
      expect(classified.retryable).toBe(false);
      expect(providerExceptionRetryDelayMs(error, 0)).toBeUndefined();
    });
  }

  test("are recognised from the error code alone", () => {
    const error = fetchError("ECONNREFUSED", "request failed");
    expect(classifyApiError({ error }).category).toBe("unreachable");
  });

  test("get an actionable summary instead of a retry promise", () => {
    const summary = summarizeClassifiedError(classifyApiError({ error: bun143Refused }));
    expect(summary).toContain("Couldn't connect");
    expect(summary).not.toContain("retrying");
  });

  test("still name the provider and address the user configured", () => {
    for (const error of [bun142Refused, bun143Refused]) {
      const description = describeProviderConnectionFailure(error.message, {
        baseUrl: "http://localhost:11434/v1",
        providerName: "Ollama",
        platform: "linux",
      });
      expect(description).toContain("localhost:11434");
    }
  });
});

describe("transient network failures stay retryable", () => {
  for (const [code, message] of [
    ["ECONNRESET", "ECONNRESET: The socket connection was closed unexpectedly."],
    ["", "socket hang up"],
    ["", "fetch failed"],
  ] as const) {
    test(JSON.stringify(message), () => {
      const error = fetchError(code, message);
      const classified = classifyApiError({ error });
      expect(classified.category).toBe("network");
      expect(classified.retryable).toBe(true);
      expect(providerExceptionRetryDelayMs(error, 0)).toBeGreaterThanOrEqual(0);
    });
  }

  test("an HTTP 502 whose body says the upstream was unreachable is still a retryable server error", () => {
    const classified = classifyApiError({ status: 502, body: "upstream: unable to connect" });
    expect(classified.category).toBe("server_error");
    expect(classified.retryable).toBe(true);
  });
});

describe("a real refused connection", () => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const closedPort = listener.port;
  listener.stop(true);
  afterAll(() => listener.stop(true));

  test("from this runtime's fetch is classified as unreachable and fails fast", async () => {
    const started = performance.now();
    const error = await fetch(`http://127.0.0.1:${closedPort}/v1/chat/completions`).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(Error);
    expect(classifyApiError({ error }).category).toBe("unreachable");
    expect(providerExceptionRetryDelayMs(error, 0)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
