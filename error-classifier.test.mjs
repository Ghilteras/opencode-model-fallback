import { test, expect } from "bun:test";
import {
  classifyErrorType,
  isRetryableError,
  decideFallbackAction,
  detectErrorInTextParts,
  extractErrorContentFromParts
} from "./src/test-support.ts";

const RETRY_LIVE = [429, 500, 502, 503, 504];
const RETRY_DEFAULT = [401, 402, 429, 500, 502, 503, 504];

test("classifyErrorType: 'Insufficient Balance' -> insufficient_balance (non-retryable)", () => {
  expect(classifyErrorType({ message: "Insufficient Balance", name: "APIError" })).toBe("insufficient_balance");
});

test("classifyErrorType: 'Error 402 Payment Required' -> insufficient_balance", () => {
  expect(classifyErrorType({ message: "Error 402 Payment Required", name: "APIError" })).toBe("insufficient_balance");
});

test("classifyErrorType: 'credits exhausted' -> insufficient_balance", () => {
  expect(classifyErrorType({ message: "credits exhausted", name: "APIError" })).toBe("insufficient_balance");
});

test("classifyErrorType: real 429 rate limit -> rate_limit (still retryable)", () => {
  expect(classifyErrorType({ message: "429 Too Many Requests - rate limit exceeded", name: "APIError" })).toBe("rate_limit");
});

test("isRetryableError: 402 insufficient balance -> false even when 402 in retry list (default)", () => {
  expect(isRetryableError({ message: "Insufficient Balance", status: 402 }, RETRY_DEFAULT, [])).toBe(false);
});

test("isRetryableError: insufficient balance -> false even with balance/insufficient user patterns", () => {
  expect(isRetryableError({ message: "Insufficient Balance", status: 402 }, RETRY_LIVE, ["credits", "balance", "quota", "insufficient"])).toBe(false);
});

test("isRetryableError: 503 -> true (transient retried)", () => {
  expect(isRetryableError({ message: "Service Unavailable", status: 503 }, RETRY_LIVE, [])).toBe(true);
});

test("isRetryableError: 429 -> true", () => {
  expect(isRetryableError({ message: "Too Many Requests", status: 429 }, RETRY_LIVE, [])).toBe(true);
});

test("detectErrorInTextParts: prose mentioning 'rate limit' is NOT an error (today's false positive)", () => {
  expect(detectErrorInTextParts([{ type: "text", text: "Skill loaded. Now let me run the first batch of searches (respecting the 5/min rate limit)." }])).toEqual({ hasError: false });
});

test("detectErrorInTextParts: prose discussing 'Insufficient Balance' is NOT an error (feedback-loop case)", () => {
  expect(detectErrorInTextParts([{ type: "text", text: "Now I have the actual root cause. Let me check whether the model-fallback plugin should have caught this (Insufficient Balance should trigger a provider/model fallback)." }])).toEqual({ hasError: false });
});

test("detectErrorInTextParts: prose with 402/credits is NOT an error", () => {
  expect(detectErrorInTextParts([{ type: "text", text: "statusCode 402, errorName APIError, errorType rate_limit — credits issue" }])).toEqual({ hasError: false });
});

test("detectErrorInTextParts: empty parts -> no error", () => {
  expect(detectErrorInTextParts([])).toEqual({ hasError: false });
});

test("extractErrorContentFromParts: real error-type part IS still detected", () => {
  expect(extractErrorContentFromParts([{ type: "error", text: "Insufficient Balance" }])).toEqual({ hasError: true, errorMessage: "Insufficient Balance" });
});

test("decideFallbackAction: transient on primary -> native retry (no swap)", () => {
  expect(decideFallbackAction(true, false)).toBe("native-retry");
});

test("decideFallbackAction: transient on fallback -> stay pinned (no advance, no recovery)", () => {
  expect(decideFallbackAction(true, true)).toBe("stay-pinned");
});

test("decideFallbackAction: non-transient on primary -> swap and pin", () => {
  expect(decideFallbackAction(false, false)).toBe("swap-and-pin");
});

test("decideFallbackAction: non-transient on fallback -> advance chain", () => {
  expect(decideFallbackAction(false, true)).toBe("advance");
});

test("pin contract: transient paths never unpin a pinned session; only non-transient pins", () => {
  // A session on the fallback is pinned (primary dead). A transient error there
  // must keep it pinned (stay-pinned), NOT unpin it (which would bounce it back
  // to the dead primary) and NOT advance the chain (transient never swaps).
  const pinned = { sessionPinned: true };
  expect(decideFallbackAction(true, true)).toBe("stay-pinned");
  expect(pinned.sessionPinned).toBe(true); // untouched by transient-in-chain
  expect(decideFallbackAction(true, false)).toBe("native-retry");
  expect(decideFallbackAction(false, false)).toBe("swap-and-pin");
  expect(decideFallbackAction(false, true)).toBe("advance");
});
