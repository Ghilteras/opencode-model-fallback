// @bun
// src/constants.ts
var PLUGIN_NAME = "opencode-model-fallback";
var DEFAULT_CONFIG = {
  enabled: true,
  retry_on_errors: [401, 402, 429, 500, 502, 503, 504],
  retryable_error_patterns: [],
  max_fallback_attempts: 10,
  cooldown_seconds: 60,
  timeout_seconds: 30,
  notify_on_fallback: true,
  fallback_models: [],
  small_model_chain: [],
  sticky_fallback: false
};
var smallModelProviderCooldowns = new Map;
var RETRYABLE_ERROR_PATTERNS = [
  /rate.?limit/i,
  /too.?many.?requests/i,
  /quota.?exceeded/i,
  /quota.?protection/i,
  /key.?limit.?exceeded/i,
  /usage\s+limit\s+has\s+been\s+reached/i,
  /service.?unavailable/i,
  /overloaded/i,
  /temporarily.?unavailable/i,
  /try.?again/i,
  /credit.*balance.*too.*low/i,
  /insufficient.?(?:credits?|funds?|balance)/i,
  /(?:^|\s)429(?:\s|$)/,
  /(?:^|\s)503(?:\s|$)/,
  /(?:^|\s)529(?:\s|$)/
];

// src/logger.ts
import { appendFileSync, mkdirSync, statSync, renameSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
var LOG_FILE = join(homedir(), ".config", "opencode", "opencode-model-fallback.log");
var DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;
var envMax = process.env.OPENCODE_MODEL_FALLBACK_LOG_MAX_BYTES;
var MAX_LOG_BYTES = envMax === undefined ? DEFAULT_MAX_LOG_BYTES : Math.max(0, Number.parseInt(envMax, 10) || 0);
try {
  mkdirSync(join(homedir(), ".config", "opencode"), { recursive: true });
} catch {}
function rotateIfNeeded() {
  if (MAX_LOG_BYTES <= 0)
    return;
  try {
    if (!existsSync(LOG_FILE))
      return;
    const stats = statSync(LOG_FILE);
    if (stats.size < MAX_LOG_BYTES)
      return;
    const rotated = `${LOG_FILE}.1`;
    try {
      if (existsSync(rotated))
        unlinkSync(rotated);
    } catch {}
    renameSync(LOG_FILE, rotated);
  } catch {}
}
function writeToFile(level, message, context) {
  const timestamp = new Date().toISOString();
  const contextStr = context ? ` ${JSON.stringify(context)}` : "";
  const logLine = `[${timestamp}] [${level}] [${PLUGIN_NAME}] ${message}${contextStr}
`;
  try {
    rotateIfNeeded();
    appendFileSync(LOG_FILE, logLine);
  } catch {}
}
var DEBUG_MODE = false;
function logInfo(message, context) {
  if (DEBUG_MODE) {
    const contextStr = context ? ` ${JSON.stringify(context)}` : "";
    console.log(`[${PLUGIN_NAME}] ${message}${contextStr}`);
  }
  writeToFile("INFO", message, context);
}
function logError(message, context) {
  if (DEBUG_MODE) {
    const contextStr = context ? ` ${JSON.stringify(context)}` : "";
    console.error(`[${PLUGIN_NAME}] ${message}${contextStr}`);
  }
  writeToFile("ERROR", message, context);
}

// src/config-reader.ts
var SESSION_ID_NOISE_WORDS = new Set(["ses", "work", "task", "session"]);
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeFallbackModelsField(value) {
  if (!value)
    return [];
  if (typeof value === "string")
    return [value];
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string");
  }
  return [];
}
function readFallbackModels(agentName, agents) {
  if (!agents)
    return [];
  const agentConfig = agents[agentName];
  if (!isRecord(agentConfig))
    return [];
  const topLevel = normalizeFallbackModelsField(agentConfig.fallback_models);
  if (topLevel.length > 0)
    return topLevel;
  const options = agentConfig.options;
  if (isRecord(options)) {
    return normalizeFallbackModelsField(options.fallback_models);
  }
  return [];
}
function resolveAgentForSession(sessionID, eventAgent) {
  if (eventAgent && eventAgent.trim().length > 0) {
    return eventAgent.trim().toLowerCase();
  }
  const segments = sessionID.split(/[\s_\-/]+/).filter(Boolean);
  for (const segment of segments) {
    const candidate = segment.toLowerCase();
    const isAlphaOnly = /^[a-z][a-z-]*$/.test(candidate);
    if (candidate.length > 2 && isAlphaOnly && !SESSION_ID_NOISE_WORDS.has(candidate)) {
      return candidate;
    }
  }
  return;
}
function getFallbackModelsForSession(sessionID, eventAgent, agents, globalFallbackModels) {
  const resolvedAgent = resolveAgentForSession(sessionID, eventAgent);
  if (resolvedAgent && agents) {
    const models = readFallbackModels(resolvedAgent, agents);
    if (models.length > 0) {
      const agentConfig = agents[resolvedAgent];
      if (isRecord(agentConfig) && typeof agentConfig.model === "string") {
        const primaryModel = agentConfig.model;
        if (!models.includes(primaryModel)) {
          models.unshift(primaryModel);
        }
      }
      return models;
    }
  }
  if (globalFallbackModels && globalFallbackModels.length > 0) {
    return globalFallbackModels;
  }
  return [];
}

// src/fallback-state.ts
function createFallbackState(originalModel) {
  return {
    originalModel,
    currentModel: originalModel,
    fallbackIndex: -1,
    failedModels: new Map,
    attemptCount: 0,
    pendingFallbackModel: undefined,
    sessionPinned: false
  };
}
function isModelInCooldown(model, state, cooldownSeconds) {
  const failedAt = state.failedModels.get(model);
  if (failedAt === undefined)
    return false;
  const cooldownMs = cooldownSeconds * 1000;
  return Date.now() - failedAt < cooldownMs;
}
function findNextAvailableFallback(state, fallbackModels, cooldownSeconds) {
  for (let i = state.fallbackIndex + 1;i < fallbackModels.length; i++) {
    const candidate = fallbackModels[i];
    if (candidate === state.currentModel) {
      logInfo(`Skipping fallback model identical to current: ${candidate} (index ${i})`);
      continue;
    }
    if (!isModelInCooldown(candidate, state, cooldownSeconds)) {
      return candidate;
    }
    logInfo(`Skipping fallback model in cooldown: ${candidate} (index ${i})`);
  }
  return;
}
function applyFallbackPlan(state, plan, pendingFallbackModel) {
  state.fallbackIndex = plan.newFallbackIndex;
  state.failedModels.set(plan.failedModel, Date.now());
  const failedProvider = String(plan.failedModel).split("/")[0];
  if (failedProvider)
    smallModelProviderCooldowns.set(failedProvider, Date.now());
  state.attemptCount++;
  state.currentModel = plan.newModel;
  state.pendingFallbackModel = pendingFallbackModel;
}
function planFallback(sessionID, state, fallbackModels, config) {
  if (state.attemptCount >= config.max_fallback_attempts) {
    logInfo(`Max fallback attempts reached for session ${sessionID} (${state.attemptCount})`);
    return {
      success: false,
      error: "Max fallback attempts reached",
      maxAttemptsReached: true
    };
  }
  const nextModel = findNextAvailableFallback(state, fallbackModels, config.cooldown_seconds);
  if (!nextModel) {
    logInfo(`No available fallback models for session ${sessionID}`);
    return {
      success: false,
      error: "No available fallback models (all in cooldown or exhausted)"
    };
  }
  logInfo(`Planned fallback for session ${sessionID}: ${state.currentModel} -> ${nextModel} (will be attempt ${state.attemptCount + 1})`);
  return {
    success: true,
    newModel: nextModel,
    failedModel: state.currentModel,
    newFallbackIndex: fallbackModels.indexOf(nextModel)
  };
}
function commitFallback(state, plan) {
  if (state.currentModel !== plan.failedModel) {
    return false;
  }
  applyFallbackPlan(state, plan);
  return true;
}
function recoverToOriginal(state, cooldownSeconds) {
  if (state.currentModel === state.originalModel)
    return false;
  if (isModelInCooldown(state.originalModel, state, cooldownSeconds))
    return false;
  state.currentModel = state.originalModel;
  state.fallbackIndex = -1;
  state.attemptCount = 0;
  state.pendingFallbackModel = undefined;
  return true;
}

// src/message-replay.ts
var TIER_2_TYPES = new Set(["text", "image"]);
function filterPartsByTier(parts, tier) {
  switch (tier) {
    case 1:
      return parts;
    case 2:
      return parts.filter((p) => TIER_2_TYPES.has(p.type));
    case 3:
      return parts.filter((p) => p.type === "text");
  }
}
async function replayWithDegradation(allParts, sendFn) {
  if (allParts.length === 0) {
    return { success: false, error: "No parts to replay" };
  }
  const tiers = [1, 2, 3];
  let lastError;
  let previousLength = -1;
  for (const tier of tiers) {
    const filtered = filterPartsByTier(allParts, tier);
    if (filtered.length === 0)
      continue;
    if (filtered.length === previousLength)
      continue;
    previousLength = filtered.length;
    try {
      await sendFn(filtered);
      const sentTypes = new Set(filtered.map((p) => p.type));
      const allTypes = new Set(allParts.map((p) => p.type));
      const droppedTypes = [...allTypes].filter((t) => !sentTypes.has(t));
      return {
        success: true,
        tier,
        sentParts: filtered,
        droppedTypes
      };
    } catch (err) {
      lastError = err;
    }
  }
  return {
    success: false,
    error: lastError instanceof Error ? lastError.message : String(lastError)
  };
}

// src/error-classifier.ts
var reportedBadPatterns = new Set;
function getObjectRecord(value) {
  return value && typeof value === "object" ? value : undefined;
}
function normalizeMessage(value) {
  return value.trim().length === 0 ? "" : value.toLowerCase();
}
function getErrorMessage(error) {
  if (!error)
    return "";
  if (typeof error === "string")
    return normalizeMessage(error);
  const errorObj = error;
  const paths = [
    errorObj.data?.error,
    errorObj.data,
    errorObj.error,
    errorObj
  ];
  for (const obj of paths) {
    const record = getObjectRecord(obj);
    if (!record || !("message" in record))
      continue;
    const rawMessage = record.message;
    if (typeof rawMessage === "string") {
      return normalizeMessage(rawMessage);
    }
  }
  try {
    return normalizeMessage(JSON.stringify(error));
  } catch {
    return "";
  }
}
function extractStatusCode(error, retryOnErrors) {
  if (!error)
    return;
  const errorObj = error;
  const statusCode = errorObj.statusCode ?? errorObj.status ?? errorObj.data?.statusCode;
  if (typeof statusCode === "number") {
    return statusCode;
  }
  if (typeof statusCode === "string") {
    const parsed = Number.parseInt(statusCode, 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  const codes = retryOnErrors ?? DEFAULT_CONFIG.retry_on_errors;
  const message = getErrorMessage(error);
  const contextualPattern = new RegExp(`(?:status(?:\\s+code)?|code|http)D*(${codes.join("|")})\\b|\\b(${codes.join("|")})\\b(?=\x00|[^0-9])`, "i");
  const statusMatch = message.match(contextualPattern);
  const extracted = statusMatch?.[1] ?? statusMatch?.[2];
  if (extracted) {
    return parseInt(extracted, 10);
  }
  return;
}
function extractErrorName(error) {
  if (!error || typeof error !== "object")
    return;
  const errorObj = error;
  const directName = errorObj.name;
  if (typeof directName === "string" && directName.length > 0) {
    return directName;
  }
  const nestedError = errorObj.error;
  const nestedName = nestedError?.name;
  if (typeof nestedName === "string" && nestedName.length > 0) {
    return nestedName;
  }
  const dataError = errorObj.data?.error;
  const dataErrorName = dataError?.name;
  if (typeof dataErrorName === "string" && dataErrorName.length > 0) {
    return dataErrorName;
  }
  return;
}
function classifyErrorType(error) {
  const message = getErrorMessage(error);
  const errorName = extractErrorName(error)?.toLowerCase();
  if (errorName?.includes("loadapi") || /api.?key.?is.?missing/i.test(message) && /environment variable/i.test(message) || /(?:x-api-key|api key).*(?:is required|missing|required)/i.test(message) || /(?:missing|required).*(?:x-api-key|api key)/i.test(message)) {
    return "missing_api_key";
  }
  if (/api.?key/i.test(message) && /must be a string/i.test(message) || /incorrect api key provided/i.test(message) || /api key not valid/i.test(message) || /invalid api key/i.test(message)) {
    return "invalid_api_key";
  }
  if (errorName?.includes("unknownerror") && /model\s+not\s+found/i.test(message)) {
    return "model_not_found";
  }
  if (/model\s+(?:is\s+)?not\s+(?:found|supported|available)/i.test(message) || /the model .+ does not exist/i.test(message)) {
    return "model_not_found";
  }
  if (/insufficient.{0,20}(?:credits?|funds?|balance)|credits?.{0,20}(?:exhausted|depleted|insufficient|too low)|balance.{0,20}(?:insufficient|too low|exhausted|depleted)|(?:^|\s)402(?:\s|$)/i.test(message)) {
    return "insufficient_balance";
  }
  if (RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return "rate_limit";
  }
  return;
}
var AUTO_RETRY_PATTERNS = [
  (combined) => /retrying\s+in/i.test(combined),
  (combined) => /(?:too\s+many\s+requests|quota\s*exceeded|usage\s+limit|rate\s+limit|limit\s+reached)/i.test(combined)
];
function extractAutoRetrySignal(info) {
  if (!info)
    return;
  const candidates = [];
  const directStatus = info.status;
  if (typeof directStatus === "string")
    candidates.push(directStatus);
  const summary = info.summary;
  if (typeof summary === "string")
    candidates.push(summary);
  const message = info.message;
  if (typeof message === "string")
    candidates.push(message);
  const details = info.details;
  if (typeof details === "string")
    candidates.push(details);
  const combined = candidates.join(`
`);
  if (!combined)
    return;
  const isAutoRetry = AUTO_RETRY_PATTERNS.every((test) => test(combined));
  if (isAutoRetry) {
    return { signal: combined };
  }
  return;
}
function containsErrorContent(parts) {
  if (!parts || !Array.isArray(parts) || parts.length === 0)
    return { hasError: false };
  const errorParts = parts.filter((p) => p.type === "error");
  if (errorParts.length > 0) {
    const errorMessages = errorParts.map((p) => p.text).filter((text) => typeof text === "string");
    const errorMessage = errorMessages.length > 0 ? errorMessages.join(`
`) : undefined;
    return { hasError: true, errorMessage };
  }
  return { hasError: false };
}
function detectErrorInTextParts(parts) {
  return { hasError: false };
}
function extractErrorContentFromParts(parts) {
  if (!parts || !Array.isArray(parts) || parts.length === 0)
    return { hasError: false };
  const errorParts = parts.filter((p) => p.type === "error" && typeof p.text === "string" && p.text.length > 0);
  if (errorParts.length > 0) {
    const errorMessage = errorParts.map((p) => p.text).join(`
`);
    return { hasError: true, errorMessage };
  }
  return { hasError: false };
}
function isRetryableError(error, retryOnErrors, userPatterns) {
  const statusCode = extractStatusCode(error, retryOnErrors);
  const message = getErrorMessage(error);
  const errorType = classifyErrorType(error);
  if (errorType === "missing_api_key") {
    return true;
  }
  if (errorType === "model_not_found") {
    return true;
  }
  if (errorType === "insufficient_balance") {
    return false;
  }
  if (statusCode && retryOnErrors.includes(statusCode)) {
    return true;
  }
  if (RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return true;
  }
  if (userPatterns && userPatterns.length > 0) {
    for (const patternStr of userPatterns) {
      try {
        const re = new RegExp(patternStr, "i");
        if (re.test(message))
          return true;
      } catch (err) {
        if (!reportedBadPatterns.has(patternStr)) {
          reportedBadPatterns.add(patternStr);
          logInfo("Ignoring invalid retryable_error_patterns entry (not a valid regex)", {
            pattern: patternStr,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }
  }
  return false;
}
function decideFallbackAction(isRetryable, inFallbackChain) {
  if (isRetryable && !inFallbackChain)
    return "native-retry";
  if (isRetryable && inFallbackChain)
    return "stay-pinned";
  if (!isRetryable && !inFallbackChain)
    return "swap-and-pin";
  return "advance";
}

// src/auto-retry.ts
function summarizeTriggerError(error) {
  if (!error)
    return;
  const message = getErrorMessage(error);
  const status = extractStatusCode(error);
  const name = typeof error.name === "string" ? error.name : undefined;
  if (!message && status === undefined && !name)
    return;
  return {
    message: message.length > 240 ? `${message.slice(0, 240)}\u2026` : message,
    ...status !== undefined ? { status } : {},
    ...name ? { name } : {}
  };
}
var SESSION_TTL_MS = 30 * 60 * 1000;
var POST_ABORT_DELAY_MS = 150;
function summarizeParts(parts) {
  if (!parts || parts.length === 0) {
    return { count: 0, types: [], textChars: 0, hasToolCall: false };
  }
  const typeSet = new Set;
  let textChars = 0;
  let hasToolCall = false;
  for (const part of parts) {
    typeSet.add(part.type);
    const textValue = part.text;
    if (part.type === "text" && typeof textValue === "string") {
      textChars += textValue.length;
    }
    if (part.type === "tool_call") {
      hasToolCall = true;
    }
  }
  return {
    count: parts.length,
    types: Array.from(typeSet),
    textChars,
    hasToolCall
  };
}
function createAutoRetryHelpers(deps) {
  const {
    ctx,
    config,
    sessionStates,
    sessionLastAccess,
    sessionRetryInFlight,
    sessionAwaitingFallbackResult,
    sessionFallbackTimeouts
  } = deps;
  const getParentSessionID = async (sessionID) => {
    const cached = deps.sessionParentID.get(sessionID);
    if (cached !== undefined)
      return cached;
    try {
      const sessionInfo = await ctx.client.session.get({ path: { id: sessionID } });
      const sessionData = sessionInfo?.data ?? sessionInfo;
      const parentID = typeof sessionData?.parentID === "string" && sessionData.parentID.length > 0 ? sessionData.parentID : null;
      deps.sessionParentID.set(sessionID, parentID);
      if (parentID) {
        logInfo("Detected child session", { sessionID, parentID });
      }
      return parentID;
    } catch {
      logError("Failed to look up parentID", { sessionID });
      return null;
    }
  };
  const abortSessionRequest = async (sessionID, source) => {
    try {
      await ctx.client.session.abort({ path: { id: sessionID } });
      deps.sessionSelfAbortTimestamp.set(sessionID, Date.now());
      logInfo(`Aborted in-flight session request (${source})`, { sessionID });
    } catch (error) {
      logError(`Failed to abort in-flight session request (${source})`, {
        sessionID,
        error: String(error)
      });
    }
  };
  const clearSessionFallbackTimeout = (sessionID) => {
    const timer = sessionFallbackTimeouts.get(sessionID);
    if (timer) {
      clearTimeout(timer);
      sessionFallbackTimeouts.delete(sessionID);
    }
  };
  const scheduleSessionFallbackTimeout = (sessionID, resolvedAgent) => {
    clearSessionFallbackTimeout(sessionID);
    const timeoutMs = config.timeout_seconds * 1000;
    if (timeoutMs <= 0)
      return;
    const timer = setTimeout(async () => {
      sessionFallbackTimeouts.delete(sessionID);
      if (deps.sessionFirstTokenReceived.get(sessionID)) {
        logInfo("Timeout fired but first token already received, skipping abort", {
          sessionID
        });
        return;
      }
      const state = sessionStates.get(sessionID);
      if (!state)
        return;
      if (sessionRetryInFlight.has(sessionID)) {
        logInfo("Timeout fired but retry already in flight, deferring", { sessionID });
        return;
      }
      deps.sessionCompactionInFlight.delete(sessionID);
      await abortSessionRequest(sessionID, "session.timeout");
      if (state.pendingFallbackModel) {
        state.pendingFallbackModel = undefined;
      }
      const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, deps.agentConfigs, deps.globalFallbackModels);
      if (fallbackModels.length === 0)
        return;
      logInfo("Session fallback timeout reached", {
        sessionID,
        timeoutSeconds: config.timeout_seconds,
        currentModel: state.currentModel
      });
      sessionRetryInFlight.add(sessionID);
      try {
        const plan = planFallback(sessionID, state, fallbackModels, config);
        if (plan.success) {
          await autoRetryWithFallback(sessionID, plan.newModel, resolvedAgent, "session.timeout", plan);
        }
      } finally {
        sessionRetryInFlight.delete(sessionID);
      }
    }, timeoutMs);
    sessionFallbackTimeouts.set(sessionID, timer);
  };
  const autoRetryWithFallback = async (sessionID, newModel, resolvedAgent, source, plan, triggerError) => {
    let deferredToOtherHandler = false;
    const preCheckState = sessionStates.get(sessionID);
    if (plan) {
      if (preCheckState && preCheckState.currentModel !== plan.failedModel) {
        logInfo(`Skipping stale autoRetryWithFallback (${source}): state already at ${preCheckState.currentModel}, expected failed model ${plan.failedModel}`, {
          sessionID,
          staleModel: newModel,
          currentModel: preCheckState.currentModel
        });
        deferredToOtherHandler = true;
        return false;
      }
    } else if (preCheckState && preCheckState.currentModel !== newModel) {
      logInfo(`Skipping stale autoRetryWithFallback (${source}): state already at ${preCheckState.currentModel}, wanted ${newModel}`, {
        sessionID,
        staleModel: newModel,
        currentModel: preCheckState.currentModel
      });
      deferredToOtherHandler = true;
      return false;
    }
    const modelParts = newModel.split("/");
    if (modelParts.length < 2) {
      logInfo(`Invalid model format (missing provider prefix): ${newModel}`);
      const state = sessionStates.get(sessionID);
      if (state?.pendingFallbackModel) {
        state.pendingFallbackModel = undefined;
      }
      return false;
    }
    const fallbackModelObj = {
      providerID: modelParts[0],
      modelID: modelParts.slice(1).join("/")
    };
    const modelAlreadyStopped = source === "session.error" || source === "message.updated";
    const callerAlreadyAborted = source === "session.timeout";
    const mayHaveRecentAbort = source === "session.idle.silent-failure";
    if (modelAlreadyStopped) {
      logInfo(`Skipping abort \u2014 model already stopped (${source})`, {
        sessionID,
        newModel
      });
    } else if (callerAlreadyAborted || mayHaveRecentAbort) {
      const selfAbortTs = deps.sessionSelfAbortTimestamp.get(sessionID);
      const msSinceAbort = selfAbortTs ? Date.now() - selfAbortTs : undefined;
      if (selfAbortTs && msSinceAbort !== undefined && msSinceAbort < POST_ABORT_DELAY_MS * 2) {
        logInfo(`Waiting for recent abort propagation (${source})`, {
          sessionID,
          msSinceAbort
        });
        const remainingMs = Math.max(0, POST_ABORT_DELAY_MS - msSinceAbort);
        if (remainingMs > 0) {
          await new Promise((resolve) => setTimeout(() => resolve(), remainingMs));
        }
      } else if (callerAlreadyAborted) {
        logInfo(`Caller already aborted (${source}), waiting for propagation`, {
          sessionID
        });
        await new Promise((resolve) => setTimeout(() => resolve(), POST_ABORT_DELAY_MS));
      }
    } else {
      await abortSessionRequest(sessionID, `pre-fallback.${source}`);
      await new Promise((resolve) => setTimeout(() => resolve(), POST_ABORT_DELAY_MS));
    }
    deps.sessionFirstTokenReceived.set(sessionID, false);
    let retryDispatched = false;
    try {
      if (resolvedAgent === "compaction") {
        const failedModel = plan?.failedModel;
        logInfo(`Compaction fallback: abort + summarize on fallback (${source})`, {
          sessionID,
          failedModel,
          newModel
        });
        deps.sessionCompactionInFlight.add(sessionID);
        if (failedModel && plan) {
          const currentState = sessionStates.get(sessionID);
          if (currentState) {
            if (!currentState.failedModels.has(failedModel)) {
              currentState.failedModels.set(failedModel, Date.now());
            }
          }
        }
        try {
          await abortSessionRequest(sessionID, "compaction-fallback");
        } catch {
          logError(`Failed to abort session for compaction fallback (${source})`, { sessionID });
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          const messagesResp2 = await ctx.client.session.messages({
            path: { id: sessionID },
            query: { directory: ctx.directory }
          });
          const msgs2 = messagesResp2.data ?? [];
          const deleteIDs = [];
          for (let i = msgs2.length - 1;i >= 0; i--) {
            const msg = msgs2[i];
            const msgRole = msg.info?.role;
            const msgError = msg.info?.error;
            const msgID = msg.info?.id;
            const parts = msg.parts ?? [];
            const isCompactionMsg = parts.length > 0 && parts.every((p) => p.type === "compaction");
            if (!msgID)
              continue;
            if (msgRole === "assistant" && msgError) {
              deleteIDs.push(msgID);
              continue;
            }
            if (isCompactionMsg) {
              deleteIDs.push(msgID);
              break;
            }
          }
          const rawClient = ctx.client.session?._client;
          if (rawClient && deleteIDs.length > 0) {
            for (const msgID of deleteIDs) {
              logInfo(`Deleting compaction message (${source})`, {
                sessionID,
                messageID: msgID
              });
              try {
                await rawClient.delete({
                  url: "/session/{id}/message/{messageID}",
                  path: { id: sessionID, messageID: msgID }
                });
                logInfo(`Deleted compaction message (${source})`, {
                  sessionID,
                  messageID: msgID
                });
              } catch (delErr) {
                logError(`Failed to delete compaction message (${source})`, {
                  sessionID,
                  messageID: msgID,
                  error: String(delErr)
                });
              }
            }
          } else if (deleteIDs.length > 0) {
            logError(`Cannot access raw SDK client for message deletion (${source})`, {
              sessionID,
              messageCount: deleteIDs.length
            });
          }
        } catch (msgErr) {
          logError(`Failed during compaction message cleanup (${source})`, {
            sessionID,
            error: String(msgErr)
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        try {
          if (sessionAwaitingFallbackResult.has(sessionID)) {
            logInfo(`Skipping duplicate compaction summarize (${source})`, { sessionID });
            deferredToOtherHandler = true;
            return false;
          }
          sessionAwaitingFallbackResult.add(sessionID);
          logInfo(`Dispatching session.summarize on fallback model (${source})`, {
            sessionID,
            providerID: fallbackModelObj.providerID,
            modelID: fallbackModelObj.modelID
          });
          const summarizeResult = await ctx.client.session.summarize({
            path: { id: sessionID },
            body: {
              providerID: fallbackModelObj.providerID,
              modelID: fallbackModelObj.modelID
            },
            query: { directory: ctx.directory }
          });
          logInfo(`session.summarize response (${source})`, {
            sessionID,
            model: newModel,
            response: (JSON.stringify(summarizeResult) ?? "undefined").slice(0, 500)
          });
          if (plan) {
            const stateToCommit = sessionStates.get(sessionID);
            if (stateToCommit) {
              const committed = commitFallback(stateToCommit, plan);
              if (committed) {
                logInfo(`Committed fallback after compaction summarize (${source})`, {
                  sessionID,
                  from: plan.failedModel,
                  to: plan.newModel,
                  attemptCount: stateToCommit.attemptCount
                });
              }
            }
          }
          scheduleSessionFallbackTimeout(sessionID, undefined);
          retryDispatched = true;
          if (config.notify_on_fallback) {
            const fromName = (failedModel || "primary").split("/").pop();
            const toName = newModel.split("/").pop() || newModel;
            await ctx.client.tui.showToast({
              body: {
                title: "Compaction Fallback",
                message: `${fromName} failed \u2014 retrying compaction on ${toName}`,
                variant: "warning",
                duration: 5000
              }
            }).catch(() => {});
          }
          logInfo(`Compaction re-dispatched via summarize (${source})`, {
            sessionID,
            model: newModel
          });
          return true;
        } catch (summarizeErr) {
          logError(`session.summarize failed (${source})`, {
            sessionID,
            model: newModel,
            error: String(summarizeErr)
          });
          sessionAwaitingFallbackResult.delete(sessionID);
          if (plan) {
            const currentState = sessionStates.get(sessionID);
            if (currentState) {
              commitFallback(currentState, plan);
              logInfo(`Committed compaction fallback state as last resort (${source})`, {
                sessionID,
                from: plan.failedModel,
                to: plan.newModel
              });
            }
          }
          deps.sessionCompactionInFlight.delete(sessionID);
          clearSessionFallbackTimeout(sessionID);
          sessionAwaitingFallbackResult.delete(sessionID);
          if (config.notify_on_fallback) {
            const fromName = (failedModel || "primary").split("/").pop();
            const toName = newModel.split("/").pop() || newModel;
            await ctx.client.tui.showToast({
              body: {
                title: "Compaction Failed",
                message: `${fromName} can't compact \u2014 try /compact after switching to ${toName}`,
                variant: "warning",
                duration: 1e4
              }
            }).catch(() => {});
          }
          deferredToOtherHandler = true;
          return false;
        }
      }
      const messagesResp = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory }
      });
      const msgs = messagesResp.data;
      if (!msgs || msgs.length === 0) {
        logError(`No messages found in session for auto-retry (${source})`, { sessionID });
      }
      let lastUserPartsRaw;
      let lastNonAssistantPartsRaw;
      for (let i = (msgs?.length ?? 0) - 1;i >= 0; i--) {
        const m = msgs?.[i];
        const role = (m?.info?.role ?? m?.role ?? "").toLowerCase();
        const parts = m?.parts ?? m?.info?.parts;
        if (!parts || parts.length === 0)
          continue;
        const hasOnlyCompactionParts = parts.every((p) => p.type === "compaction");
        if (hasOnlyCompactionParts)
          continue;
        if (!lastNonAssistantPartsRaw && role !== "assistant") {
          lastNonAssistantPartsRaw = parts;
        }
        if (role === "user") {
          lastUserPartsRaw = parts;
          break;
        }
      }
      const replayPartsRaw = lastUserPartsRaw ?? lastNonAssistantPartsRaw;
      const replaySource = lastUserPartsRaw ? "last-user" : lastNonAssistantPartsRaw ? "last-non-assistant" : "none";
      if (replayPartsRaw && replayPartsRaw.length > 0) {
        const postCheckState = sessionStates.get(sessionID);
        const expectedCurrentModel = plan ? plan.failedModel : newModel;
        if (postCheckState && postCheckState.currentModel !== expectedCurrentModel) {
          logInfo(`Skipping stale autoRetryWithFallback (${source}): state already at ${postCheckState.currentModel}, expected failed model ${expectedCurrentModel}`, {
            sessionID,
            staleModel: newModel,
            currentModel: postCheckState.currentModel
          });
          deferredToOtherHandler = true;
          return false;
        }
        if (sessionAwaitingFallbackResult.has(sessionID)) {
          logInfo(`Skipping duplicate fallback dispatch \u2014 another handler already dispatched (${source})`, {
            sessionID,
            model: newModel
          });
          deferredToOtherHandler = true;
          return false;
        }
        sessionAwaitingFallbackResult.add(sessionID);
        const triggerErrorSummary = summarizeTriggerError(triggerError);
        logInfo(`Auto-retrying with fallback model (${source})`, {
          sessionID,
          model: newModel,
          agent: resolvedAgent,
          replaySource,
          ...triggerErrorSummary ? { triggerError: triggerErrorSummary } : {}
        });
        const allParts = replayPartsRaw.filter((p) => typeof p.type === "string" && p.type !== "compaction");
        logInfo(`Prepared replay payload (${source})`, {
          sessionID,
          model: newModel,
          agent: resolvedAgent,
          replaySource,
          payload: summarizeParts(allParts)
        });
        if (allParts.length > 0) {
          const sendFn = async (parts) => {
            logInfo(`Dispatching fallback replay (${source})`, {
              sessionID,
              model: newModel,
              agent: resolvedAgent,
              payload: summarizeParts(parts)
            });
            await ctx.client.session.promptAsync({
              path: { id: sessionID },
              body: {
                ...resolvedAgent ? { agent: resolvedAgent } : {},
                model: fallbackModelObj,
                parts
              },
              query: { directory: ctx.directory }
            });
            logInfo(`Fallback replay accepted by host (${source})`, {
              sessionID,
              model: newModel,
              agent: resolvedAgent
            });
          };
          const replayResult = await replayWithDegradation(allParts, sendFn);
          if (replayResult.success) {
            let commitSucceeded = true;
            if (plan) {
              const stateToCommit = sessionStates.get(sessionID);
              if (stateToCommit) {
                const committed = commitFallback(stateToCommit, plan);
                if (committed) {
                  logInfo(`Committed fallback state after successful dispatch (${source})`, {
                    sessionID,
                    newModel: plan.newModel,
                    failedModel: plan.failedModel,
                    attemptCount: stateToCommit.attemptCount
                  });
                } else {
                  logInfo(`Fallback state already committed by another handler \u2014 aborting duplicate replay (${source})`, {
                    sessionID,
                    newModel: plan.newModel
                  });
                  commitSucceeded = false;
                  await abortSessionRequest(sessionID, `duplicate-replay.${source}`);
                }
              }
            }
            if (!commitSucceeded) {
              deferredToOtherHandler = true;
              return false;
            }
            scheduleSessionFallbackTimeout(sessionID, resolvedAgent);
            retryDispatched = true;
            logInfo(`Fallback replay succeeded (${source})`, {
              sessionID,
              tier: replayResult.tier,
              sentPartsCount: replayResult.sentParts?.length,
              droppedTypes: replayResult.droppedTypes,
              replaySource
            });
            if (replayResult.droppedTypes && replayResult.droppedTypes.length > 0) {
              const droppedStr = replayResult.droppedTypes.join(", ");
              await ctx.client.tui.showToast({
                body: {
                  title: "Message Replay",
                  message: `Some message parts were dropped for compatibility: ${droppedStr}`,
                  variant: "warning",
                  duration: 5000
                }
              }).catch(() => {});
            }
          } else {
            logError(`All replay tiers failed (${source})`, {
              sessionID,
              error: replayResult.error
            });
          }
        }
      } else {
        logInfo(`No replayable non-assistant message found for auto-retry (${source})`, {
          sessionID,
          model: newModel,
          agent: resolvedAgent
        });
      }
    } catch (retryError) {
      logError(`Auto-retry failed (${source})`, {
        sessionID,
        error: String(retryError)
      });
      sessionAwaitingFallbackResult.delete(sessionID);
      deps.sessionCompactionInFlight.delete(sessionID);
      clearSessionFallbackTimeout(sessionID);
    } finally {
      if (!retryDispatched && !deferredToOtherHandler) {
        sessionAwaitingFallbackResult.delete(sessionID);
        deps.sessionCompactionInFlight.delete(sessionID);
        clearSessionFallbackTimeout(sessionID);
        const state = sessionStates.get(sessionID);
        if (state?.pendingFallbackModel) {
          state.pendingFallbackModel = undefined;
        }
      }
    }
    return retryDispatched;
  };
  const resolveAgentForSessionFromContext = async (sessionID, eventAgent) => {
    const resolved = resolveAgentForSession(sessionID, eventAgent);
    if (resolved)
      return resolved;
    try {
      const messagesResp = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory }
      });
      const msgs = messagesResp.data;
      if (!msgs || msgs.length === 0)
        return;
      for (let i = msgs.length - 1;i >= 0; i--) {
        const info = msgs[i]?.info;
        const infoAgent = typeof info?.agent === "string" ? info.agent : undefined;
        if (infoAgent && infoAgent.trim().length > 0) {
          return infoAgent.trim().toLowerCase();
        }
      }
    } catch {
      logError("Failed to resolve agent from messages", { sessionID });
    }
    try {
      const sessionInfo = await ctx.client.session.get({ path: { id: sessionID } });
      const sessionData = sessionInfo?.data ?? sessionInfo;
      const sdkAgent = typeof sessionData?.agent === "string" ? sessionData.agent : undefined;
      if (sdkAgent && sdkAgent.trim().length > 0) {
        const normalized = sdkAgent.trim().toLowerCase();
        logInfo("Resolved agent from session.get", { sessionID, agent: normalized });
        return normalized;
      }
    } catch {
      logError("Failed to resolve agent from session.get", { sessionID });
    }
    return;
  };
  const cleanupStaleSessions = () => {
    const now = Date.now();
    let cleanedCount = 0;
    for (const [sessionID, lastAccess] of sessionLastAccess.entries()) {
      if (now - lastAccess > SESSION_TTL_MS) {
        sessionStates.delete(sessionID);
        sessionLastAccess.delete(sessionID);
        sessionRetryInFlight.delete(sessionID);
        sessionAwaitingFallbackResult.delete(sessionID);
        deps.sessionFirstTokenReceived.delete(sessionID);
        deps.sessionSelfAbortTimestamp.delete(sessionID);
        deps.sessionParentID.delete(sessionID);
        deps.sessionIdleResolvers.delete(sessionID);
        deps.sessionLastMessageTime.delete(sessionID);
        deps.sessionCompactionInFlight.delete(sessionID);
        clearSessionFallbackTimeout(sessionID);
        cleanedCount++;
      }
    }
    if (cleanedCount > 0) {
      logInfo(`Cleaned up ${cleanedCount} stale session states`);
    }
  };
  return {
    getParentSessionID,
    abortSessionRequest,
    clearSessionFallbackTimeout,
    scheduleSessionFallbackTimeout,
    autoRetryWithFallback,
    resolveAgentForSessionFromContext,
    cleanupStaleSessions
  };
}

// src/event-handler.ts
function createEventHandler(deps, helpers) {
  const {
    config,
    sessionStates,
    sessionLastAccess,
    sessionRetryInFlight,
    sessionAwaitingFallbackResult,
    sessionFallbackTimeouts
  } = deps;
  const handleActivity = async (sessionID, activityModel) => {
    if (activityModel && sessionAwaitingFallbackResult.has(sessionID)) {
      const state = sessionStates.get(sessionID);
      if (state && state.failedModels.has(activityModel)) {
        logInfo("Ignoring activity from already-failed model", {
          sessionID,
          activityModel,
          currentModel: state.currentModel
        });
        return;
      }
    }
    if (!deps.sessionFirstTokenReceived.get(sessionID)) {
      deps.sessionFirstTokenReceived.set(sessionID, true);
    }
    if (sessionAwaitingFallbackResult.has(sessionID)) {
      const resolvedAgent = resolveAgentForSession(sessionID, undefined);
      helpers.scheduleSessionFallbackTimeout(sessionID, resolvedAgent);
      logInfo("Resetting fallback timeout due to activity", { sessionID, activityModel });
      return;
    }
    if (sessionAwaitingFallbackResult.size === 0) {
      return;
    }
    const cachedParentID = deps.sessionParentID.get(sessionID);
    const parentID = cachedParentID !== undefined ? cachedParentID : await helpers.getParentSessionID(sessionID);
    if (parentID && sessionAwaitingFallbackResult.has(parentID)) {
      const resolvedAgent = resolveAgentForSession(parentID, undefined);
      helpers.scheduleSessionFallbackTimeout(parentID, resolvedAgent);
      logInfo("Resetting parent fallback timeout due to child activity", {
        sessionID,
        parentID
      });
    }
  };
  const handleSessionCreated = (props) => {
    const sessionInfo = props?.info;
    const sessionID = sessionInfo?.id;
    if (!sessionID)
      return;
    const parentID = sessionInfo?.parentID;
    if (typeof parentID === "string" && parentID.length > 0) {
      deps.sessionParentID.set(sessionID, parentID);
    }
    logInfo("Session created, state will be created on-demand", { sessionID });
  };
  const handleSessionDeleted = (props) => {
    const sessionInfo = props?.info;
    const sessionID = sessionInfo?.id;
    if (sessionID) {
      logInfo("Cleaning up session state", { sessionID });
      sessionStates.delete(sessionID);
      sessionLastAccess.delete(sessionID);
      sessionRetryInFlight.delete(sessionID);
      sessionAwaitingFallbackResult.delete(sessionID);
      deps.sessionFirstTokenReceived.delete(sessionID);
      deps.sessionSelfAbortTimestamp.delete(sessionID);
      deps.sessionParentID.delete(sessionID);
      deps.sessionCompactionInFlight.delete(sessionID);
      deps.sessionIdleResolvers.delete(sessionID);
      deps.sessionLastMessageTime.delete(sessionID);
      helpers.clearSessionFallbackTimeout(sessionID);
    }
  };
  const handleSessionStop = async (props) => {
    const sessionID = props?.sessionID;
    if (!sessionID)
      return;
    helpers.clearSessionFallbackTimeout(sessionID);
    if (sessionRetryInFlight.has(sessionID) || sessionAwaitingFallbackResult.has(sessionID)) {
      await helpers.abortSessionRequest(sessionID, "session.stop");
    }
    sessionRetryInFlight.delete(sessionID);
    sessionAwaitingFallbackResult.delete(sessionID);
    deps.sessionCompactionInFlight.delete(sessionID);
    deps.sessionSelfAbortTimestamp.delete(sessionID);
    const state = sessionStates.get(sessionID);
    if (state?.pendingFallbackModel) {
      state.pendingFallbackModel = undefined;
    }
    logInfo("Cleared fallback retry state on session.stop", { sessionID });
  };
  const handleSessionIdle = async (props) => {
    const sessionID = props?.sessionID;
    if (!sessionID)
      return;
    const idleResolvers = deps.sessionIdleResolvers.get(sessionID);
    if (idleResolvers && idleResolvers.length > 0) {
      logInfo("session.idle resolving waiters", {
        sessionID,
        waiterCount: idleResolvers.length
      });
      for (const resolve of idleResolvers)
        resolve();
      deps.sessionIdleResolvers.delete(sessionID);
    }
    if (sessionAwaitingFallbackResult.has(sessionID)) {
      if (deps.sessionCompactionInFlight.has(sessionID)) {
        logInfo("session.idle during compaction in-flight \u2014 not a silent failure, waiting for session.compacted", {
          sessionID
        });
        return;
      }
      const firstTokenReceived = deps.sessionFirstTokenReceived.get(sessionID);
      if (!firstTokenReceived) {
        const state2 = sessionStates.get(sessionID);
        if (state2) {
          logInfo("session.idle detected silent model failure (no first token received)", {
            sessionID,
            currentModel: state2.currentModel,
            attemptCount: state2.attemptCount
          });
          if (sessionRetryInFlight.has(sessionID)) {
            logInfo("session.idle silent failure \u2014 retry already in flight, skipping", {
              sessionID
            });
            return;
          }
          sessionRetryInFlight.add(sessionID);
          sessionAwaitingFallbackResult.delete(sessionID);
          helpers.clearSessionFallbackTimeout(sessionID);
          try {
            const resolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, undefined);
            const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, deps.agentConfigs, deps.globalFallbackModels);
            if (fallbackModels.length === 0) {
              logInfo("session.idle silent failure \u2014 no fallback models configured", {
                sessionID
              });
              return;
            }
            const plan = planFallback(sessionID, state2, fallbackModels, config);
            if (plan.success) {
              await helpers.autoRetryWithFallback(sessionID, plan.newModel, resolvedAgent, "session.idle.silent-failure", plan, { message: "Model went idle without producing tokens", name: "SilentModelFailure" });
            } else {
              logInfo("session.idle silent failure \u2014 no more fallback models available", {
                sessionID,
                error: plan.error
              });
            }
          } finally {
            sessionRetryInFlight.delete(sessionID);
          }
          return;
        }
      }
      logInfo("session.idle with first token received \u2014 fallback model completed", {
        sessionID
      });
      sessionAwaitingFallbackResult.delete(sessionID);
      helpers.clearSessionFallbackTimeout(sessionID);
      sessionRetryInFlight.delete(sessionID);
      return;
    }
    const hadTimeout = sessionFallbackTimeouts.has(sessionID);
    helpers.clearSessionFallbackTimeout(sessionID);
    sessionRetryInFlight.delete(sessionID);
    const state = sessionStates.get(sessionID);
    if (state?.pendingFallbackModel) {
      state.pendingFallbackModel = undefined;
    }
    if (hadTimeout) {
      logInfo("Cleared fallback timeout after session completion", { sessionID });
    }
  };
  const handleSessionStatus = async (props) => {
    const sessionID = props?.sessionID;
    const status = props?.status;
    if (!sessionID || !status || status.type !== "retry")
      return;
    if (sessionRetryInFlight.has(sessionID)) {
      logInfo("session.status skipped -- retry lock already held", { sessionID });
      return;
    }
    sessionRetryInFlight.add(sessionID);
    try {
      const resolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, undefined);
      const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, deps.agentConfigs, deps.globalFallbackModels);
      logInfo("Provider retry detected", {
        sessionID,
        attempt: status.attempt,
        message: status.message,
        nextRetryMs: status.next,
        resolvedAgent,
        totalFallbackModels: fallbackModels.length
      });
      if (fallbackModels.length === 0) {
        if (config.notify_on_fallback) {
          await deps.ctx.client.tui.showToast({
            body: {
              title: "Provider Retrying",
              variant: "info",
              duration: 3000,
              message: `${status.message || "retrying..."} (no fallback models configured)`
            }
          }).catch(() => {});
        }
        return;
      }
      const nextRetryMs = status.next;
      if (typeof nextRetryMs === "number" && nextRetryMs > 0) {
        const now = Date.now();
        const timeoutMs = config.timeout_seconds * 1000;
        if (nextRetryMs > now + timeoutMs) {
          logInfo("Provider retry is beyond timeout, triggering immediate fallback", {
            sessionID,
            nextRetryMs,
            now,
            timeoutMs,
            diffSeconds: Math.round((nextRetryMs - now) / 1000)
          });
          await triggerImmediateFallback(sessionID, resolvedAgent, fallbackModels, status);
          return;
        }
      }
      let state = sessionStates.get(sessionID);
      if (!state) {
        const agentConfig = resolvedAgent && deps.agentConfigs ? deps.agentConfigs[resolvedAgent] : undefined;
        const initialModel = agentConfig?.model ?? findFirstAgentModel();
        if (!initialModel) {
          logInfo("No model info for session.status fallback", { sessionID });
          return;
        }
        logInfo("Creating on-demand state for session.status", {
          sessionID,
          model: initialModel,
          agent: resolvedAgent
        });
        state = createFallbackState(initialModel);
        sessionStates.set(sessionID, state);
        sessionLastAccess.set(sessionID, Date.now());
      } else {
        sessionLastAccess.set(sessionID, Date.now());
      }
      sessionAwaitingFallbackResult.delete(sessionID);
      helpers.clearSessionFallbackTimeout(sessionID);
      const plan = planFallback(sessionID, state, fallbackModels, config);
      if (plan.success) {
        if (config.notify_on_fallback) {
          const modelName = plan.newModel?.split("/").pop() || plan.newModel;
          deps.ctx.client.tui.showToast({
            body: {
              title: "Retry Detected -- Switching Model",
              variant: "warning",
              duration: 5000,
              message: `${status.message || "Provider retrying"} -> ${modelName} (attempt ${state.attemptCount + 1} of ${fallbackModels.length})`
            }
          }).catch(() => {});
        }
        await helpers.autoRetryWithFallback(sessionID, plan.newModel, resolvedAgent, "session.status", plan, { message: status.message || "Provider auto-retry signal", name: "ProviderRetrySignal" });
      } else if (!plan.success) {
        logError("session.status fallback failed", {
          sessionID,
          error: plan.error
        });
        if (plan.maxAttemptsReached && config.notify_on_fallback) {
          await deps.ctx.client.tui.showToast({
            body: {
              title: "All Fallbacks Exhausted",
              variant: "error",
              duration: 8000,
              message: `All ${fallbackModels.length} fallback models exhausted after ${state.attemptCount} attempts`
            }
          }).catch(() => {});
        }
      }
    } finally {
      sessionRetryInFlight.delete(sessionID);
    }
  };
  const handleSessionError = async (props) => {
    const sessionID = props?.sessionID;
    const error = props?.error;
    const agent = props?.agent;
    const errorModel = props?.model;
    if (!sessionID) {
      logInfo("session.error without sessionID, skipping");
      return;
    }
    if (deps.sessionCompactionInFlight.has(sessionID)) {
      logInfo("Ignoring session.error during compaction in-flight", {
        sessionID,
        errorName: extractErrorName(error)
      });
      return;
    }
    const SELF_ABORT_WINDOW_MS = 2000;
    const selfAbortTs = deps.sessionSelfAbortTimestamp.get(sessionID);
    const errorName = extractErrorName(error);
    if (errorName === "MessageAbortedError" && selfAbortTs && Date.now() - selfAbortTs < SELF_ABORT_WINDOW_MS) {
      logInfo("Ignoring self-inflicted MessageAbortedError in session.error", {
        sessionID,
        msSinceAbort: Date.now() - selfAbortTs,
        awaitingFallback: sessionAwaitingFallbackResult.has(sessionID),
        retryInFlight: sessionRetryInFlight.has(sessionID)
      });
      return;
    }
    const currentState = sessionStates.get(sessionID);
    if (currentState?.pendingFallbackModel) {
      logInfo("Ignoring session.error while fallback replay is pending", {
        sessionID,
        pendingFallbackModel: currentState.pendingFallbackModel,
        currentModel: currentState.currentModel,
        errorName: extractErrorName(error)
      });
      return;
    }
    if (currentState && errorModel && errorModel !== currentState.currentModel) {
      logInfo("Ignoring stale session.error from previous model", {
        sessionID,
        staleModel: errorModel,
        currentModel: currentState.currentModel,
        errorName: extractErrorName(error)
      });
      return;
    }
    if (currentState && errorModel && currentState.failedModels.has(errorModel)) {
      logInfo("Ignoring session.error from already-failed model", {
        sessionID,
        errorModel,
        currentModel: currentState.currentModel,
        errorName: extractErrorName(error)
      });
      return;
    }
    if (sessionAwaitingFallbackResult.has(sessionID)) {
      logInfo("Ignoring session.error while awaiting fallback result (likely stale abort)", {
        sessionID,
        currentModel: currentState?.currentModel,
        errorName: extractErrorName(error)
      });
      return;
    }
    if (sessionRetryInFlight.has(sessionID)) {
      logInfo("session.error skipped -- retry in flight (early lock)", {
        sessionID,
        retryInFlight: true
      });
      return;
    }
    sessionRetryInFlight.add(sessionID);
    try {
      const resolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, agent);
      if (deps.sessionCompactionInFlight.has(sessionID)) {
        logInfo("session.error skipping \u2014 compaction already being handled by message.updated", {
          sessionID,
          resolvedAgent,
          errorName: extractErrorName(error)
        });
        return;
      }
      helpers.clearSessionFallbackTimeout(sessionID);
      const stateAfterAwait = sessionStates.get(sessionID);
      if (stateAfterAwait?.pendingFallbackModel) {
        logInfo("Ignoring session.error \u2014 fallback replay became pending during agent resolution", {
          sessionID,
          pendingFallbackModel: stateAfterAwait.pendingFallbackModel,
          currentModel: stateAfterAwait.currentModel,
          errorName: extractErrorName(error)
        });
        return;
      }
      logInfo("session.error received", {
        sessionID,
        agent,
        resolvedAgent,
        statusCode: extractStatusCode(error, config.retry_on_errors),
        errorName: extractErrorName(error),
        errorType: classifyErrorType(error)
      });
      const isRetryable = isRetryableError(error, config.retry_on_errors, config.retryable_error_patterns);
      let state = sessionStates.get(sessionID);
      const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, deps.agentConfigs, deps.globalFallbackModels);
      if (fallbackModels.length === 0) {
        logInfo("No fallback models configured", { sessionID, agent });
        return;
      }
      const inFallbackChain = state && state.currentModel !== state.originalModel;
      const action = decideFallbackAction(isRetryable, inFallbackChain);
      if (action === "native-retry") {
        logInfo("Transient error on primary \u2014 native retry, no fallback swap", {
          sessionID,
          retryable: true,
          inFallbackChain: false,
          statusCode: extractStatusCode(error, config.retry_on_errors),
          errorName: extractErrorName(error)
        });
        return;
      }
      if (action === "stay-pinned") {
        logInfo("Transient error on fallback \u2014 stay pinned, native retry (no chain advance, no recovery)", {
          sessionID,
          retryable: true,
          inFallbackChain: true,
          currentModel: state?.currentModel,
          originalModel: state?.originalModel,
          errorName: extractErrorName(error)
        });
        return;
      }
      if (action === "swap-and-pin" || action === "advance") {
        logInfo(action === "swap-and-pin" ? "Non-transient error on primary \u2014 swap to fallback and PIN for session lifetime" : "Non-transient error on fallback \u2014 advance chain (stay pinned)", {
          sessionID,
          retryable: false,
          inFallbackChain,
          statusCode: extractStatusCode(error, config.retry_on_errors),
          errorName: extractErrorName(error),
          errorType: classifyErrorType(error)
        });
      }
      if (!state) {
        const currentModel = props?.model;
        if (currentModel) {
          state = createFallbackState(currentModel);
          sessionStates.set(sessionID, state);
          sessionLastAccess.set(sessionID, Date.now());
        } else if (!errorModel && sessionRetryInFlight.has(sessionID)) {
          logInfo("Deferring to message.updated handler (no state, no errorModel, retry in flight)", {
            sessionID,
            errorName: extractErrorName(error)
          });
          return;
        } else {
          const agentConfig = resolvedAgent && deps.agentConfigs ? deps.agentConfigs[resolvedAgent] : undefined;
          const agentModel = agentConfig?.model;
          if (agentModel) {
            logInfo("Derived model from agent config", {
              sessionID,
              agent: resolvedAgent,
              model: agentModel
            });
            state = createFallbackState(agentModel);
            sessionStates.set(sessionID, state);
            sessionLastAccess.set(sessionID, Date.now());
          } else {
            const firstModel = findFirstAgentModel();
            if (firstModel) {
              logInfo("Using first available agent model for state creation", {
                sessionID,
                model: firstModel
              });
              state = createFallbackState(firstModel);
              sessionStates.set(sessionID, state);
              sessionLastAccess.set(sessionID, Date.now());
            } else {
              logInfo("No model info available, cannot fallback", { sessionID });
              return;
            }
          }
        }
      } else {
        sessionLastAccess.set(sessionID, Date.now());
      }
      if (state && (action === "swap-and-pin" || action === "advance")) {
        state.sessionPinned = true;
      }
      const plan = planFallback(sessionID, state, fallbackModels, config);
      if (plan.success) {
        if (config.notify_on_fallback) {
          const modelName = plan.newModel?.split("/").pop() || plan.newModel;
          const attemptInfo = `attempt ${state.attemptCount + 1} of ${fallbackModels.length}`;
          deps.ctx.client.tui.showToast({
            body: {
              title: "Model Fallback",
              message: `Switching to ${modelName} (${attemptInfo})`,
              variant: "warning",
              duration: 5000
            }
          }).catch(() => {});
        }
        await helpers.autoRetryWithFallback(sessionID, plan.newModel, resolvedAgent, "session.error", plan, error);
      } else {
        logError("Fallback preparation failed", {
          sessionID,
          error: plan.error
        });
      }
    } finally {
      sessionRetryInFlight.delete(sessionID);
    }
  };
  const handleSessionCompacted = (props) => {
    const sessionID = props?.sessionID;
    if (!sessionID)
      return;
    const hadAwaiting = sessionAwaitingFallbackResult.has(sessionID);
    const hadCompaction = deps.sessionCompactionInFlight.has(sessionID);
    sessionAwaitingFallbackResult.delete(sessionID);
    sessionRetryInFlight.delete(sessionID);
    deps.sessionFirstTokenReceived.delete(sessionID);
    deps.sessionCompactionInFlight.delete(sessionID);
    helpers.clearSessionFallbackTimeout(sessionID);
    if (hadAwaiting || hadCompaction) {
      logInfo("Compaction completed, clearing fallback state", { sessionID });
    }
  };
  function findFirstAgentModel() {
    if (!deps.agentConfigs)
      return;
    for (const agentName of Object.keys(deps.agentConfigs)) {
      const agentConfig = deps.agentConfigs[agentName];
      const model = agentConfig?.model;
      if (model)
        return model;
    }
    return;
  }
  async function triggerImmediateFallback(sessionID, resolvedAgent, fallbackModels, status) {
    let state = sessionStates.get(sessionID);
    if (!state) {
      const agentConfig = resolvedAgent && deps.agentConfigs ? deps.agentConfigs[resolvedAgent] : undefined;
      const initialModel = agentConfig?.model ?? findFirstAgentModel();
      if (!initialModel) {
        logError("Cannot trigger immediate fallback - no model info", { sessionID });
        return;
      }
      state = createFallbackState(initialModel);
      sessionStates.set(sessionID, state);
      sessionLastAccess.set(sessionID, Date.now());
    } else {
      sessionLastAccess.set(sessionID, Date.now());
    }
    sessionAwaitingFallbackResult.delete(sessionID);
    helpers.clearSessionFallbackTimeout(sessionID);
    const plan = planFallback(sessionID, state, fallbackModels, config);
    if (plan.success) {
      if (config.notify_on_fallback) {
        const modelName = plan.newModel?.split("/").pop() || plan.newModel;
        deps.ctx.client.tui.showToast({
          body: {
            title: "Provider Retry Too Slow - Switching Model",
            variant: "warning",
            duration: 5000,
            message: `${status.message || "Provider retrying"} -> ${modelName} (immediate fallback)`
          }
        }).catch(() => {});
      }
      await helpers.autoRetryWithFallback(sessionID, plan.newModel, resolvedAgent, "session.status.immediate", plan, { message: status.message || "Provider retry too slow", name: "ProviderRetryTooSlow" });
    } else if (!plan.success) {
      logError("Immediate fallback preparation failed", {
        sessionID,
        error: plan.error
      });
      if (plan.maxAttemptsReached && config.notify_on_fallback) {
        await deps.ctx.client.tui.showToast({
          body: {
            title: "All Fallbacks Exhausted",
            variant: "error",
            duration: 8000,
            message: `All ${fallbackModels.length} fallback models exhausted`
          }
        }).catch(() => {});
      }
    }
  }
  return {
    handleEvent: async ({ event }) => {
      if (!config.enabled)
        return;
      const props = event.properties;
      if (event.type === "session.created") {
        handleSessionCreated(props);
        return;
      }
      if (event.type === "session.deleted") {
        handleSessionDeleted(props);
        return;
      }
      if (event.type === "session.stop") {
        await handleSessionStop(props);
        return;
      }
      if (event.type === "session.idle") {
        await handleSessionIdle(props);
        return;
      }
      if (event.type === "session.error") {
        await handleSessionError(props);
        return;
      }
      if (event.type === "session.status") {
        await handleSessionStatus(props);
        return;
      }
      if (event.type === "session.compacted") {
        handleSessionCompacted(props);
        return;
      }
    },
    handleActivity
  };
}

// src/message-update-handler.ts
function hasVisibleAssistantResponse(extractAutoRetrySignalFn) {
  return async (ctx, sessionID, _info) => {
    try {
      const messagesResp = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory }
      });
      const msgs = messagesResp.data;
      if (!msgs || msgs.length === 0)
        return false;
      const lastAssistant = [...msgs].reverse().find((m) => m.info?.role === "assistant");
      if (!lastAssistant)
        return false;
      if (lastAssistant.info?.error)
        return false;
      const parts = lastAssistant.parts ?? lastAssistant.info?.parts;
      const hasToolCall = (parts ?? []).some((p) => p.type === "tool_call");
      const textFromParts = (parts ?? []).filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text.trim()).filter((text) => text.length > 0).join(`
`);
      if (hasToolCall)
        return true;
      if (!textFromParts)
        return false;
      if (extractAutoRetrySignalFn({ message: textFromParts }))
        return false;
      return true;
    } catch {
      return false;
    }
  };
}
async function checkLastAssistantForErrorContent(ctx, sessionID) {
  try {
    const messagesResp = await ctx.client.session.messages({
      path: { id: sessionID },
      query: { directory: ctx.directory }
    });
    const msgs = messagesResp.data;
    if (!msgs || msgs.length === 0)
      return;
    const lastAssistant = [...msgs].reverse().find((m) => m.info?.role === "assistant");
    if (!lastAssistant)
      return;
    const parts = lastAssistant.parts ?? lastAssistant.info?.parts;
    if (!Array.isArray(parts)) {
      return;
    }
    const result = extractErrorContentFromParts(parts);
    if (result.hasError)
      return result.errorMessage;
    const textResult = detectErrorInTextParts(parts);
    if (textResult.hasError)
      return textResult.errorMessage;
    return;
  } catch {
    return;
  }
}
function createMessageUpdateHandler(deps, helpers) {
  const {
    ctx,
    config,
    sessionStates,
    sessionLastAccess,
    sessionRetryInFlight,
    sessionAwaitingFallbackResult
  } = deps;
  const checkVisibleResponse = hasVisibleAssistantResponse(extractAutoRetrySignal);
  return async (props) => {
    const info = props?.info;
    const sessionID = info?.sessionID;
    const retrySignalResult = extractAutoRetrySignal(info);
    const retrySignal = retrySignalResult?.signal;
    const timeoutEnabled = config.timeout_seconds > 0;
    const parts = props?.parts;
    const errorContentResult = containsErrorContent(parts);
    let error = info?.error ?? (retrySignal && timeoutEnabled ? { name: "ProviderRateLimitError", message: retrySignal } : undefined) ?? (errorContentResult.hasError ? {
      name: "MessageContentError",
      message: errorContentResult.errorMessage || "Message contains error content"
    } : undefined);
    const role = info?.role;
    const model = info?.model ?? (typeof info?.providerID === "string" && typeof info?.modelID === "string" ? `${info.providerID}/${info.modelID}` : undefined);
    if (sessionID && role === "assistant") {
      deps.sessionLastMessageTime.set(sessionID, Date.now());
      logInfo("message.updated received", {
        sessionID,
        model,
        hasInfoError: !!info?.error,
        errorType: info?.error ? classifyErrorType(info.error) : undefined
      });
    }
    if (sessionID && role === "assistant" && !error) {
      const errorContent = await checkLastAssistantForErrorContent(ctx, sessionID);
      if (errorContent) {
        logInfo("Detected error content in message parts", {
          sessionID,
          errorContent: errorContent.slice(0, 200)
        });
        error = { name: "ContentError", message: errorContent };
      }
    }
    if (sessionID && role === "assistant" && !error) {
      if (!sessionAwaitingFallbackResult.has(sessionID)) {
        const needsTimeout = model && config.timeout_seconds > 0 && !deps.sessionFirstTokenReceived.get(sessionID) && !deps.sessionFallbackTimeouts.has(sessionID);
        if (needsTimeout) {
          if (!sessionStates.has(sessionID)) {
            const state2 = createFallbackState(model);
            sessionStates.set(sessionID, state2);
            sessionLastAccess.set(sessionID, Date.now());
          }
          const agent = info?.agent;
          helpers.resolveAgentForSessionFromContext(sessionID, agent).then((resolvedAgent) => {
            const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, deps.agentConfigs, deps.globalFallbackModels);
            if (fallbackModels.length > 0) {
              helpers.scheduleSessionFallbackTimeout(sessionID, resolvedAgent);
              logInfo("Scheduled primary model TTFT timeout", {
                sessionID,
                model,
                timeoutSeconds: config.timeout_seconds
              });
            }
          }).catch(() => {});
        } else if (sessionStates.has(sessionID)) {
          const eventHasContent = parts?.some((p) => p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0 || p.type === "tool_call" || p.type === "tool");
          if (eventHasContent) {
            deps.sessionFirstTokenReceived.set(sessionID, true);
          }
          if (deps.sessionFallbackTimeouts.has(sessionID)) {
            const agent = info?.agent;
            helpers.resolveAgentForSessionFromContext(sessionID, agent).then((resolvedAgent) => {
              helpers.scheduleSessionFallbackTimeout(sessionID, resolvedAgent);
            }).catch(() => {});
          }
        }
        return;
      }
      const hasVisible = await checkVisibleResponse(ctx, sessionID, info);
      if (!hasVisible) {
        const eventHasActivity = parts?.some((p) => p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0 || p.type === "tool_call");
        if (eventHasActivity) {
          deps.sessionFirstTokenReceived.set(sessionID, true);
        }
        logError("Assistant update observed without visible final response; keeping fallback timeout", { sessionID, model, firstTokenReceived: deps.sessionFirstTokenReceived.get(sessionID) ?? false });
        return;
      }
      deps.sessionFirstTokenReceived.set(sessionID, true);
      sessionAwaitingFallbackResult.delete(sessionID);
      helpers.clearSessionFallbackTimeout(sessionID);
      const state = sessionStates.get(sessionID);
      if (state?.pendingFallbackModel) {
        state.pendingFallbackModel = undefined;
      }
      logInfo("Assistant response observed; cleared fallback timeout", {
        sessionID,
        model
      });
      return;
    }
    if (sessionID && role === "assistant" && error) {
      if (deps.sessionCompactionInFlight.has(sessionID)) {
        logInfo("Ignoring message.updated error during compaction in-flight", {
          sessionID,
          model,
          errorName: extractErrorName(error)
        });
        return;
      }
      const currentState = sessionStates.get(sessionID);
      const eventAgent = info?.agent?.trim().toLowerCase();
      const isCompactionError = eventAgent === "compaction";
      if (currentState && model && model !== currentState.currentModel) {
        if (isCompactionError) {
          logInfo("Compaction error on failed model \u2014 will retry on current fallback", {
            sessionID,
            failedModel: model,
            currentModel: currentState.currentModel,
            errorName: extractErrorName(error)
          });
        } else {
          const isAlreadyFailed = currentState.failedModels.has(model);
          const retryableStaleError = isRetryableError(error, config.retry_on_errors, config.retryable_error_patterns);
          const canResyncToErrorModel = retryableStaleError && !isAlreadyFailed && !currentState.pendingFallbackModel && !sessionAwaitingFallbackResult.has(sessionID);
          if (canResyncToErrorModel) {
            logInfo("Resyncing state to error model before fallback planning", {
              sessionID,
              previousModel: currentState.currentModel,
              errorModel: model,
              errorName: extractErrorName(error)
            });
            currentState.currentModel = model;
            sessionLastAccess.set(sessionID, Date.now());
          } else {
            logInfo("Ignoring stale error from previous model", {
              sessionID,
              staleModel: model,
              currentModel: currentState.currentModel,
              errorName: extractErrorName(error),
              isAlreadyFailed
            });
            return;
          }
        }
      }
      const SELF_ABORT_WINDOW_MS = 2000;
      const errorName = extractErrorName(error);
      const selfAbortTs = deps.sessionSelfAbortTimestamp.get(sessionID);
      if (errorName === "MessageAbortedError" && selfAbortTs && Date.now() - selfAbortTs < SELF_ABORT_WINDOW_MS) {
        logInfo("Ignoring self-inflicted MessageAbortedError (abort initiated by plugin)", {
          sessionID,
          model,
          msSinceAbort: Date.now() - selfAbortTs,
          awaitingFallback: sessionAwaitingFallbackResult.has(sessionID),
          retryInFlight: sessionRetryInFlight.has(sessionID)
        });
        return;
      }
      sessionAwaitingFallbackResult.delete(sessionID);
      if (sessionRetryInFlight.has(sessionID) && !retrySignal) {
        logInfo("message.updated fallback skipped (retry in flight)", {
          sessionID
        });
        return;
      }
      if (retrySignal && sessionRetryInFlight.has(sessionID) && timeoutEnabled) {
        logError("Overriding in-flight retry due to provider auto-retry signal", { sessionID, model });
        await helpers.abortSessionRequest(sessionID, "message.updated.retry-signal");
        sessionRetryInFlight.delete(sessionID);
      }
      deps.sessionRetryInFlight.add(sessionID);
      try {
        if (retrySignal && timeoutEnabled) {
          logInfo("Detected provider auto-retry signal", { sessionID, model });
        }
        if (!retrySignal) {
          helpers.clearSessionFallbackTimeout(sessionID);
        }
        logInfo("message.updated with assistant error", {
          sessionID,
          model,
          statusCode: extractStatusCode(error, config.retry_on_errors),
          errorName: extractErrorName(error),
          errorType: classifyErrorType(error)
        });
        let state = sessionStates.get(sessionID);
        const agent = info?.agent;
        const resolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, agent);
        if (resolvedAgent === "compaction") {
          deps.sessionCompactionInFlight.add(sessionID);
        }
        if (isCompactionError && state && state.currentModel !== model && state.currentModel !== state.originalModel) {
          logInfo("Compaction failed on stale model \u2014 re-dispatching on current fallback", {
            sessionID,
            failedModel: model,
            currentFallbackModel: state.currentModel
          });
          deps.sessionCompactionInFlight.add(sessionID);
          if (config.notify_on_fallback) {
            const fromName = (model || "primary").split("/").pop();
            const toName = state.currentModel.split("/").pop() || state.currentModel;
            deps.ctx.client.tui.showToast({
              body: {
                title: "Compaction Fallback",
                message: `${fromName} failed \u2014 retrying compaction on ${toName}`,
                variant: "warning",
                duration: 5000
              }
            }).catch(() => {});
          }
          await helpers.autoRetryWithFallback(sessionID, state.currentModel, "compaction", "message.updated.compaction-stale", undefined, error);
          return;
        }
        const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, deps.agentConfigs, deps.globalFallbackModels);
        if (fallbackModels.length === 0) {
          return;
        }
        if (state && state.pendingFallbackModel && model !== state.pendingFallbackModel) {
          logInfo("Skipping duplicate fallback trigger (already in progress for different model)", {
            sessionID,
            pendingFallbackModel: state.pendingFallbackModel,
            errorModel: model
          });
          return;
        }
        const isRetryable = isRetryableError(error, config.retry_on_errors, config.retryable_error_patterns);
        const inFallbackChain = state && state.currentModel !== state.originalModel;
        if (!isRetryable && !inFallbackChain) {
          logError("message.updated error not retryable and not in fallback chain, skipping", {
            sessionID,
            statusCode: extractStatusCode(error, config.retry_on_errors),
            errorName: extractErrorName(error),
            errorType: classifyErrorType(error)
          });
          return;
        }
        if (!isRetryable && inFallbackChain) {
          logInfo("message.updated non-retryable error but in fallback chain, continuing", {
            sessionID,
            currentModel: state?.currentModel,
            originalModel: state?.originalModel,
            errorName: extractErrorName(error)
          });
        }
        if (!state) {
          let initialModel = model;
          if (!initialModel) {
            const agentConfig = resolvedAgent && deps.agentConfigs ? deps.agentConfigs[resolvedAgent] : undefined;
            const agentModel = agentConfig?.model;
            if (agentModel) {
              logError("Derived model from agent config for message.updated", {
                sessionID,
                agent: resolvedAgent,
                model: agentModel
              });
              initialModel = agentModel;
            }
          }
          if (!initialModel) {
            logError("message.updated missing model info, cannot fallback", {
              sessionID,
              errorName: extractErrorName(error),
              errorType: classifyErrorType(error)
            });
            return;
          }
          state = createFallbackState(initialModel);
          sessionStates.set(sessionID, state);
          sessionLastAccess.set(sessionID, Date.now());
        } else {
          sessionLastAccess.set(sessionID, Date.now());
          if (state.pendingFallbackModel && retrySignal && timeoutEnabled) {
            logError("Clearing pending fallback due to provider auto-retry signal", {
              sessionID,
              pendingFallbackModel: state.pendingFallbackModel
            });
            state.pendingFallbackModel = undefined;
          }
        }
        const plan = planFallback(sessionID, state, fallbackModels, config);
        if (plan.success) {
          if (config.notify_on_fallback) {
            deps.ctx.client.tui.showToast({
              body: {
                title: "Model Fallback",
                message: `Switching to ${plan.newModel?.split("/").pop() || plan.newModel} for next request`,
                variant: "warning",
                duration: 5000
              }
            }).catch(() => {});
          }
          await helpers.autoRetryWithFallback(sessionID, plan.newModel, resolvedAgent, "message.updated", plan, error);
        }
      } finally {
        deps.sessionRetryInFlight.delete(sessionID);
      }
    }
  };
}

// src/chat-message-handler.ts
function createChatMessageHandler(deps, helpers) {
  const {
    ctx,
    config,
    sessionStates,
    sessionLastAccess,
    sessionRetryInFlight,
    sessionAwaitingFallbackResult
  } = deps;
  return async (input, output) => {
    if (!config.enabled)
      return;
    const { sessionID } = input;
    let state = sessionStates.get(sessionID);
    if (!state) {
      return;
    }
    sessionLastAccess.set(sessionID, Date.now());
    const requestedModel = input.model ? `${input.model.providerID}/${input.model.modelID}` : undefined;
    if (requestedModel && requestedModel === state.currentModel && state.currentModel !== state.originalModel && !deps.sessionCompactionInFlight.has(sessionID) && !sessionRetryInFlight.has(sessionID) && !sessionAwaitingFallbackResult.has(sessionID)) {
      logInfo("Adopting current model as new primary (user confirmed manual selection)", {
        sessionID,
        model: requestedModel,
        previousOriginal: state.originalModel
      });
      state.originalModel = requestedModel;
      state.failedModels.clear();
      state.fallbackIndex = -1;
      state.attemptCount = 0;
      return;
    }
    if (state.currentModel !== state.originalModel && !config.sticky_fallback && !state.sessionPinned) {
      if (!sessionRetryInFlight.has(sessionID) && !sessionAwaitingFallbackResult.has(sessionID)) {
        const recovered = recoverToOriginal(state, config.cooldown_seconds);
        if (recovered) {
          logInfo("Recovered to primary model", {
            sessionID,
            model: state.originalModel
          });
          if (config.notify_on_fallback) {
            const modelName = state.originalModel.split("/").pop() || state.originalModel;
            ctx.client.tui.showToast({
              body: {
                title: "Model Recovered",
                message: `Recovered to ${modelName}`,
                variant: "info",
                duration: 3000
              }
            }).catch(() => {});
          }
        }
      }
    }
    if (requestedModel && requestedModel !== state.currentModel) {
      if (state.pendingFallbackModel && state.pendingFallbackModel === requestedModel) {
        state.pendingFallbackModel = undefined;
        return;
      }
      if (sessionRetryInFlight.has(sessionID) || sessionAwaitingFallbackResult.has(sessionID)) {
        logInfo("Ignoring model mismatch during active fallback management", {
          sessionID,
          requestedModel,
          currentModel: state.currentModel,
          retryInFlight: sessionRetryInFlight.has(sessionID),
          awaitingResult: sessionAwaitingFallbackResult.has(sessionID)
        });
        return;
      }
      logError("Detected manual model change, resetting fallback state", {
        sessionID,
        from: state.currentModel,
        to: requestedModel
      });
      helpers.clearSessionFallbackTimeout(sessionID);
      sessionAwaitingFallbackResult.delete(sessionID);
      deps.sessionFirstTokenReceived.delete(sessionID);
      if (sessionRetryInFlight.has(sessionID)) {
        await helpers.abortSessionRequest(sessionID, "manual-model-change");
        sessionRetryInFlight.delete(sessionID);
      }
      state = createFallbackState(requestedModel);
      sessionStates.set(sessionID, state);
      return;
    }
    if (state.currentModel === state.originalModel)
      return;
    const activeModel = state.currentModel;
    logInfo("Applying fallback model override", {
      sessionID,
      from: input.model,
      to: activeModel
    });
    if (output.message && activeModel) {
      const parts = activeModel.split("/");
      if (parts.length >= 2) {
        output.message.model = {
          providerID: parts[0],
          modelID: parts.slice(1).join("/")
        };
      }
    }
    deps.sessionCompactionInFlight.delete(sessionID);
  };
}

// src/subagent-result-sync.ts
function isEmptyTaskResult(output) {
  return /<task_result>\s*<\/task_result>/.test(output);
}
var TASK_ID_REGEX = /task_id:\s*(ses_[a-zA-Z0-9]+)/;
function extractChildSessionID(output) {
  if (!output)
    return null;
  const match = output.match(TASK_ID_REGEX);
  return match ? match[1] : null;
}
function getSessionStatusType(sessionData) {
  const status = sessionData?.status;
  if (!status)
    return;
  if (typeof status === "string")
    return status;
  if (typeof status === "object" && status !== null && "type" in status) {
    return status.type;
  }
  return;
}
function waitForSessionIdle(deps, sessionID, inactivityMs, pollIntervalMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    let pollTimer;
    let timeoutTimer;
    let lastSeenMessageTime = deps.sessionLastMessageTime.get(sessionID) ?? Date.now();
    const settle = (result) => {
      if (settled)
        return;
      settled = true;
      if (pollTimer)
        clearInterval(pollTimer);
      if (timeoutTimer)
        clearTimeout(timeoutTimer);
      const resolvers2 = deps.sessionIdleResolvers.get(sessionID);
      if (resolvers2) {
        const idx = resolvers2.indexOf(onIdleRef);
        if (idx >= 0)
          resolvers2.splice(idx, 1);
        if (resolvers2.length === 0)
          deps.sessionIdleResolvers.delete(sessionID);
      }
      resolve(result);
    };
    const onIdleRef = () => settle(true);
    let resolvers = deps.sessionIdleResolvers.get(sessionID);
    if (!resolvers) {
      resolvers = [];
      deps.sessionIdleResolvers.set(sessionID, resolvers);
    }
    resolvers.push(onIdleRef);
    const resetTimeout = () => {
      if (timeoutTimer)
        clearTimeout(timeoutTimer);
      timeoutTimer = setTimeout(() => settle(false), inactivityMs);
    };
    resetTimeout();
    const pollStatus = () => {
      if (settled)
        return;
      const currentMessageTime = deps.sessionLastMessageTime.get(sessionID);
      if (currentMessageTime && currentMessageTime > lastSeenMessageTime) {
        lastSeenMessageTime = currentMessageTime;
        resetTimeout();
      }
      deps.ctx.client.session.get({ path: { id: sessionID } }).then((sessionInfo) => {
        if (settled)
          return;
        const statusType = getSessionStatusType(sessionInfo?.data ?? sessionInfo);
        if (statusType === "idle") {
          logInfo(`[subagent-sync] Polling detected child ${sessionID} idle`);
          settle(true);
        }
      }).catch(() => {});
    };
    pollStatus();
    pollTimer = setInterval(pollStatus, pollIntervalMs);
  });
}
async function waitForChildFallbackResult(deps, childSessionID, options) {
  const maxWaitMs = options?.maxWaitMs ?? Math.min((deps.config.timeout_seconds || 120) * 1000, 120000);
  const pollIntervalMs = options?.pollIntervalMs ?? 500;
  const startTime = Date.now();
  logInfo(`[subagent-sync] Waiting for child ${childSessionID} fallback result (max ${maxWaitMs}ms idle timeout)`);
  while (deps.sessionRetryInFlight.has(childSessionID)) {
    if (Date.now() - startTime >= maxWaitMs) {
      logInfo(`[subagent-sync] Timed out waiting for child ${childSessionID} dispatch after ${maxWaitMs}ms`);
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  const remainingMs = Math.max(1000, maxWaitMs - (Date.now() - startTime));
  const wentIdle = await waitForSessionIdle(deps, childSessionID, remainingMs, pollIntervalMs);
  if (!wentIdle) {
    logInfo(`[subagent-sync] Timed out waiting for child ${childSessionID} after ${Date.now() - startTime}ms`);
    return null;
  }
  const result = await extractAssistantResponse(deps, childSessionID);
  if (result) {
    logInfo(`[subagent-sync] Got fallback result for ${childSessionID} (${Date.now() - startTime}ms)`);
    return result;
  }
  logInfo(`[subagent-sync] Child ${childSessionID} idle but no assistant response found`);
  return null;
}
async function extractAssistantResponse(deps, childSessionID) {
  try {
    const msgs = await deps.ctx.client.session.messages({
      path: { id: childSessionID },
      query: { directory: deps.ctx.directory }
    });
    if (!msgs.data || msgs.data.length === 0)
      return null;
    const lastAssistant = [...msgs.data].reverse().find((m) => m.info?.role === "assistant");
    if (!lastAssistant?.parts)
      return null;
    const textParts = lastAssistant.parts.filter((p) => p.type === "text" && p.text).map((p) => p.text);
    if (textParts.length === 0)
      return null;
    return textParts.join("");
  } catch (err) {
    logInfo(`[subagent-sync] Error reading child messages: ${err}`);
    return null;
  }
}

// src/index.ts
import { readFileSync, existsSync as existsSync2 } from "fs";
import { join as join2 } from "path";

// node_modules/jsonc-parser/lib/esm/impl/scanner.js
function createScanner(text, ignoreTrivia = false) {
  const len = text.length;
  let pos = 0, value = "", tokenOffset = 0, token = 16, lineNumber = 0, lineStartOffset = 0, tokenLineStartOffset = 0, prevTokenLineStartOffset = 0, scanError = 0;
  function scanHexDigits(count, exact) {
    let digits = 0;
    let value2 = 0;
    while (digits < count || !exact) {
      let ch = text.charCodeAt(pos);
      if (ch >= 48 && ch <= 57) {
        value2 = value2 * 16 + ch - 48;
      } else if (ch >= 65 && ch <= 70) {
        value2 = value2 * 16 + ch - 65 + 10;
      } else if (ch >= 97 && ch <= 102) {
        value2 = value2 * 16 + ch - 97 + 10;
      } else {
        break;
      }
      pos++;
      digits++;
    }
    if (digits < count) {
      value2 = -1;
    }
    return value2;
  }
  function setPosition(newPosition) {
    pos = newPosition;
    value = "";
    tokenOffset = 0;
    token = 16;
    scanError = 0;
  }
  function scanNumber() {
    let start = pos;
    if (text.charCodeAt(pos) === 48) {
      pos++;
    } else {
      pos++;
      while (pos < text.length && isDigit(text.charCodeAt(pos))) {
        pos++;
      }
    }
    if (pos < text.length && text.charCodeAt(pos) === 46) {
      pos++;
      if (pos < text.length && isDigit(text.charCodeAt(pos))) {
        pos++;
        while (pos < text.length && isDigit(text.charCodeAt(pos))) {
          pos++;
        }
      } else {
        scanError = 3;
        return text.substring(start, pos);
      }
    }
    let end = pos;
    if (pos < text.length && (text.charCodeAt(pos) === 69 || text.charCodeAt(pos) === 101)) {
      pos++;
      if (pos < text.length && text.charCodeAt(pos) === 43 || text.charCodeAt(pos) === 45) {
        pos++;
      }
      if (pos < text.length && isDigit(text.charCodeAt(pos))) {
        pos++;
        while (pos < text.length && isDigit(text.charCodeAt(pos))) {
          pos++;
        }
        end = pos;
      } else {
        scanError = 3;
      }
    }
    return text.substring(start, end);
  }
  function scanString() {
    let result = "", start = pos;
    while (true) {
      if (pos >= len) {
        result += text.substring(start, pos);
        scanError = 2;
        break;
      }
      const ch = text.charCodeAt(pos);
      if (ch === 34) {
        result += text.substring(start, pos);
        pos++;
        break;
      }
      if (ch === 92) {
        result += text.substring(start, pos);
        pos++;
        if (pos >= len) {
          scanError = 2;
          break;
        }
        const ch2 = text.charCodeAt(pos++);
        switch (ch2) {
          case 34:
            result += '"';
            break;
          case 92:
            result += "\\";
            break;
          case 47:
            result += "/";
            break;
          case 98:
            result += "\b";
            break;
          case 102:
            result += "\f";
            break;
          case 110:
            result += `
`;
            break;
          case 114:
            result += "\r";
            break;
          case 116:
            result += "\t";
            break;
          case 117:
            const ch3 = scanHexDigits(4, true);
            if (ch3 >= 0) {
              result += String.fromCharCode(ch3);
            } else {
              scanError = 4;
            }
            break;
          default:
            scanError = 5;
        }
        start = pos;
        continue;
      }
      if (ch >= 0 && ch <= 31) {
        if (isLineBreak(ch)) {
          result += text.substring(start, pos);
          scanError = 2;
          break;
        } else {
          scanError = 6;
        }
      }
      pos++;
    }
    return result;
  }
  function scanNext() {
    value = "";
    scanError = 0;
    tokenOffset = pos;
    lineStartOffset = lineNumber;
    prevTokenLineStartOffset = tokenLineStartOffset;
    if (pos >= len) {
      tokenOffset = len;
      return token = 17;
    }
    let code = text.charCodeAt(pos);
    if (isWhiteSpace(code)) {
      do {
        pos++;
        value += String.fromCharCode(code);
        code = text.charCodeAt(pos);
      } while (isWhiteSpace(code));
      return token = 15;
    }
    if (isLineBreak(code)) {
      pos++;
      value += String.fromCharCode(code);
      if (code === 13 && text.charCodeAt(pos) === 10) {
        pos++;
        value += `
`;
      }
      lineNumber++;
      tokenLineStartOffset = pos;
      return token = 14;
    }
    switch (code) {
      case 123:
        pos++;
        return token = 1;
      case 125:
        pos++;
        return token = 2;
      case 91:
        pos++;
        return token = 3;
      case 93:
        pos++;
        return token = 4;
      case 58:
        pos++;
        return token = 6;
      case 44:
        pos++;
        return token = 5;
      case 34:
        pos++;
        value = scanString();
        return token = 10;
      case 47:
        const start = pos - 1;
        if (text.charCodeAt(pos + 1) === 47) {
          pos += 2;
          while (pos < len) {
            if (isLineBreak(text.charCodeAt(pos))) {
              break;
            }
            pos++;
          }
          value = text.substring(start, pos);
          return token = 12;
        }
        if (text.charCodeAt(pos + 1) === 42) {
          pos += 2;
          const safeLength = len - 1;
          let commentClosed = false;
          while (pos < safeLength) {
            const ch = text.charCodeAt(pos);
            if (ch === 42 && text.charCodeAt(pos + 1) === 47) {
              pos += 2;
              commentClosed = true;
              break;
            }
            pos++;
            if (isLineBreak(ch)) {
              if (ch === 13 && text.charCodeAt(pos) === 10) {
                pos++;
              }
              lineNumber++;
              tokenLineStartOffset = pos;
            }
          }
          if (!commentClosed) {
            pos++;
            scanError = 1;
          }
          value = text.substring(start, pos);
          return token = 13;
        }
        value += String.fromCharCode(code);
        pos++;
        return token = 16;
      case 45:
        value += String.fromCharCode(code);
        pos++;
        if (pos === len || !isDigit(text.charCodeAt(pos))) {
          return token = 16;
        }
      case 48:
      case 49:
      case 50:
      case 51:
      case 52:
      case 53:
      case 54:
      case 55:
      case 56:
      case 57:
        value += scanNumber();
        return token = 11;
      default:
        while (pos < len && isUnknownContentCharacter(code)) {
          pos++;
          code = text.charCodeAt(pos);
        }
        if (tokenOffset !== pos) {
          value = text.substring(tokenOffset, pos);
          switch (value) {
            case "true":
              return token = 8;
            case "false":
              return token = 9;
            case "null":
              return token = 7;
          }
          return token = 16;
        }
        value += String.fromCharCode(code);
        pos++;
        return token = 16;
    }
  }
  function isUnknownContentCharacter(code) {
    if (isWhiteSpace(code) || isLineBreak(code)) {
      return false;
    }
    switch (code) {
      case 125:
      case 93:
      case 123:
      case 91:
      case 34:
      case 58:
      case 44:
      case 47:
        return false;
    }
    return true;
  }
  function scanNextNonTrivia() {
    let result;
    do {
      result = scanNext();
    } while (result >= 12 && result <= 15);
    return result;
  }
  return {
    setPosition,
    getPosition: () => pos,
    scan: ignoreTrivia ? scanNextNonTrivia : scanNext,
    getToken: () => token,
    getTokenValue: () => value,
    getTokenOffset: () => tokenOffset,
    getTokenLength: () => pos - tokenOffset,
    getTokenStartLine: () => lineStartOffset,
    getTokenStartCharacter: () => tokenOffset - prevTokenLineStartOffset,
    getTokenError: () => scanError
  };
}
function isWhiteSpace(ch) {
  return ch === 32 || ch === 9;
}
function isLineBreak(ch) {
  return ch === 10 || ch === 13;
}
function isDigit(ch) {
  return ch >= 48 && ch <= 57;
}
var CharacterCodes;
(function(CharacterCodes2) {
  CharacterCodes2[CharacterCodes2["lineFeed"] = 10] = "lineFeed";
  CharacterCodes2[CharacterCodes2["carriageReturn"] = 13] = "carriageReturn";
  CharacterCodes2[CharacterCodes2["space"] = 32] = "space";
  CharacterCodes2[CharacterCodes2["_0"] = 48] = "_0";
  CharacterCodes2[CharacterCodes2["_1"] = 49] = "_1";
  CharacterCodes2[CharacterCodes2["_2"] = 50] = "_2";
  CharacterCodes2[CharacterCodes2["_3"] = 51] = "_3";
  CharacterCodes2[CharacterCodes2["_4"] = 52] = "_4";
  CharacterCodes2[CharacterCodes2["_5"] = 53] = "_5";
  CharacterCodes2[CharacterCodes2["_6"] = 54] = "_6";
  CharacterCodes2[CharacterCodes2["_7"] = 55] = "_7";
  CharacterCodes2[CharacterCodes2["_8"] = 56] = "_8";
  CharacterCodes2[CharacterCodes2["_9"] = 57] = "_9";
  CharacterCodes2[CharacterCodes2["a"] = 97] = "a";
  CharacterCodes2[CharacterCodes2["b"] = 98] = "b";
  CharacterCodes2[CharacterCodes2["c"] = 99] = "c";
  CharacterCodes2[CharacterCodes2["d"] = 100] = "d";
  CharacterCodes2[CharacterCodes2["e"] = 101] = "e";
  CharacterCodes2[CharacterCodes2["f"] = 102] = "f";
  CharacterCodes2[CharacterCodes2["g"] = 103] = "g";
  CharacterCodes2[CharacterCodes2["h"] = 104] = "h";
  CharacterCodes2[CharacterCodes2["i"] = 105] = "i";
  CharacterCodes2[CharacterCodes2["j"] = 106] = "j";
  CharacterCodes2[CharacterCodes2["k"] = 107] = "k";
  CharacterCodes2[CharacterCodes2["l"] = 108] = "l";
  CharacterCodes2[CharacterCodes2["m"] = 109] = "m";
  CharacterCodes2[CharacterCodes2["n"] = 110] = "n";
  CharacterCodes2[CharacterCodes2["o"] = 111] = "o";
  CharacterCodes2[CharacterCodes2["p"] = 112] = "p";
  CharacterCodes2[CharacterCodes2["q"] = 113] = "q";
  CharacterCodes2[CharacterCodes2["r"] = 114] = "r";
  CharacterCodes2[CharacterCodes2["s"] = 115] = "s";
  CharacterCodes2[CharacterCodes2["t"] = 116] = "t";
  CharacterCodes2[CharacterCodes2["u"] = 117] = "u";
  CharacterCodes2[CharacterCodes2["v"] = 118] = "v";
  CharacterCodes2[CharacterCodes2["w"] = 119] = "w";
  CharacterCodes2[CharacterCodes2["x"] = 120] = "x";
  CharacterCodes2[CharacterCodes2["y"] = 121] = "y";
  CharacterCodes2[CharacterCodes2["z"] = 122] = "z";
  CharacterCodes2[CharacterCodes2["A"] = 65] = "A";
  CharacterCodes2[CharacterCodes2["B"] = 66] = "B";
  CharacterCodes2[CharacterCodes2["C"] = 67] = "C";
  CharacterCodes2[CharacterCodes2["D"] = 68] = "D";
  CharacterCodes2[CharacterCodes2["E"] = 69] = "E";
  CharacterCodes2[CharacterCodes2["F"] = 70] = "F";
  CharacterCodes2[CharacterCodes2["G"] = 71] = "G";
  CharacterCodes2[CharacterCodes2["H"] = 72] = "H";
  CharacterCodes2[CharacterCodes2["I"] = 73] = "I";
  CharacterCodes2[CharacterCodes2["J"] = 74] = "J";
  CharacterCodes2[CharacterCodes2["K"] = 75] = "K";
  CharacterCodes2[CharacterCodes2["L"] = 76] = "L";
  CharacterCodes2[CharacterCodes2["M"] = 77] = "M";
  CharacterCodes2[CharacterCodes2["N"] = 78] = "N";
  CharacterCodes2[CharacterCodes2["O"] = 79] = "O";
  CharacterCodes2[CharacterCodes2["P"] = 80] = "P";
  CharacterCodes2[CharacterCodes2["Q"] = 81] = "Q";
  CharacterCodes2[CharacterCodes2["R"] = 82] = "R";
  CharacterCodes2[CharacterCodes2["S"] = 83] = "S";
  CharacterCodes2[CharacterCodes2["T"] = 84] = "T";
  CharacterCodes2[CharacterCodes2["U"] = 85] = "U";
  CharacterCodes2[CharacterCodes2["V"] = 86] = "V";
  CharacterCodes2[CharacterCodes2["W"] = 87] = "W";
  CharacterCodes2[CharacterCodes2["X"] = 88] = "X";
  CharacterCodes2[CharacterCodes2["Y"] = 89] = "Y";
  CharacterCodes2[CharacterCodes2["Z"] = 90] = "Z";
  CharacterCodes2[CharacterCodes2["asterisk"] = 42] = "asterisk";
  CharacterCodes2[CharacterCodes2["backslash"] = 92] = "backslash";
  CharacterCodes2[CharacterCodes2["closeBrace"] = 125] = "closeBrace";
  CharacterCodes2[CharacterCodes2["closeBracket"] = 93] = "closeBracket";
  CharacterCodes2[CharacterCodes2["colon"] = 58] = "colon";
  CharacterCodes2[CharacterCodes2["comma"] = 44] = "comma";
  CharacterCodes2[CharacterCodes2["dot"] = 46] = "dot";
  CharacterCodes2[CharacterCodes2["doubleQuote"] = 34] = "doubleQuote";
  CharacterCodes2[CharacterCodes2["minus"] = 45] = "minus";
  CharacterCodes2[CharacterCodes2["openBrace"] = 123] = "openBrace";
  CharacterCodes2[CharacterCodes2["openBracket"] = 91] = "openBracket";
  CharacterCodes2[CharacterCodes2["plus"] = 43] = "plus";
  CharacterCodes2[CharacterCodes2["slash"] = 47] = "slash";
  CharacterCodes2[CharacterCodes2["formFeed"] = 12] = "formFeed";
  CharacterCodes2[CharacterCodes2["tab"] = 9] = "tab";
})(CharacterCodes || (CharacterCodes = {}));

// node_modules/jsonc-parser/lib/esm/impl/string-intern.js
var cachedSpaces = new Array(20).fill(0).map((_, index) => {
  return " ".repeat(index);
});
var maxCachedValues = 200;
var cachedBreakLinesWithSpaces = {
  " ": {
    "\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return `
` + " ".repeat(index);
    }),
    "\r": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r" + " ".repeat(index);
    }),
    "\r\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return `\r
` + " ".repeat(index);
    })
  },
  "\t": {
    "\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return `
` + "\t".repeat(index);
    }),
    "\r": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r" + "\t".repeat(index);
    }),
    "\r\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return `\r
` + "\t".repeat(index);
    })
  }
};

// node_modules/jsonc-parser/lib/esm/impl/parser.js
var ParseOptions;
(function(ParseOptions2) {
  ParseOptions2.DEFAULT = {
    allowTrailingComma: false
  };
})(ParseOptions || (ParseOptions = {}));
function parse(text, errors = [], options = ParseOptions.DEFAULT) {
  let currentProperty = null;
  let currentParent = [];
  const previousParents = [];
  function onValue(value) {
    if (Array.isArray(currentParent)) {
      currentParent.push(value);
    } else if (currentProperty !== null) {
      currentParent[currentProperty] = value;
    }
  }
  const visitor = {
    onObjectBegin: () => {
      const object = {};
      onValue(object);
      previousParents.push(currentParent);
      currentParent = object;
      currentProperty = null;
    },
    onObjectProperty: (name) => {
      currentProperty = name;
    },
    onObjectEnd: () => {
      currentParent = previousParents.pop();
    },
    onArrayBegin: () => {
      const array = [];
      onValue(array);
      previousParents.push(currentParent);
      currentParent = array;
      currentProperty = null;
    },
    onArrayEnd: () => {
      currentParent = previousParents.pop();
    },
    onLiteralValue: onValue,
    onError: (error, offset, length) => {
      errors.push({ error, offset, length });
    }
  };
  visit(text, visitor, options);
  return currentParent[0];
}
function visit(text, visitor, options = ParseOptions.DEFAULT) {
  const _scanner = createScanner(text, false);
  const _jsonPath = [];
  let suppressedCallbacks = 0;
  function toNoArgVisit(visitFunction) {
    return visitFunction ? () => suppressedCallbacks === 0 && visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter()) : () => true;
  }
  function toOneArgVisit(visitFunction) {
    return visitFunction ? (arg) => suppressedCallbacks === 0 && visitFunction(arg, _scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter()) : () => true;
  }
  function toOneArgVisitWithPath(visitFunction) {
    return visitFunction ? (arg) => suppressedCallbacks === 0 && visitFunction(arg, _scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter(), () => _jsonPath.slice()) : () => true;
  }
  function toBeginVisit(visitFunction) {
    return visitFunction ? () => {
      if (suppressedCallbacks > 0) {
        suppressedCallbacks++;
      } else {
        let cbReturn = visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter(), () => _jsonPath.slice());
        if (cbReturn === false) {
          suppressedCallbacks = 1;
        }
      }
    } : () => true;
  }
  function toEndVisit(visitFunction) {
    return visitFunction ? () => {
      if (suppressedCallbacks > 0) {
        suppressedCallbacks--;
      }
      if (suppressedCallbacks === 0) {
        visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter());
      }
    } : () => true;
  }
  const onObjectBegin = toBeginVisit(visitor.onObjectBegin), onObjectProperty = toOneArgVisitWithPath(visitor.onObjectProperty), onObjectEnd = toEndVisit(visitor.onObjectEnd), onArrayBegin = toBeginVisit(visitor.onArrayBegin), onArrayEnd = toEndVisit(visitor.onArrayEnd), onLiteralValue = toOneArgVisitWithPath(visitor.onLiteralValue), onSeparator = toOneArgVisit(visitor.onSeparator), onComment = toNoArgVisit(visitor.onComment), onError = toOneArgVisit(visitor.onError);
  const disallowComments = options && options.disallowComments;
  const allowTrailingComma = options && options.allowTrailingComma;
  function scanNext() {
    while (true) {
      const token = _scanner.scan();
      switch (_scanner.getTokenError()) {
        case 4:
          handleError(14);
          break;
        case 5:
          handleError(15);
          break;
        case 3:
          handleError(13);
          break;
        case 1:
          if (!disallowComments) {
            handleError(11);
          }
          break;
        case 2:
          handleError(12);
          break;
        case 6:
          handleError(16);
          break;
      }
      switch (token) {
        case 12:
        case 13:
          if (disallowComments) {
            handleError(10);
          } else {
            onComment();
          }
          break;
        case 16:
          handleError(1);
          break;
        case 15:
        case 14:
          break;
        default:
          return token;
      }
    }
  }
  function handleError(error, skipUntilAfter = [], skipUntil = []) {
    onError(error);
    if (skipUntilAfter.length + skipUntil.length > 0) {
      let token = _scanner.getToken();
      while (token !== 17) {
        if (skipUntilAfter.indexOf(token) !== -1) {
          scanNext();
          break;
        } else if (skipUntil.indexOf(token) !== -1) {
          break;
        }
        token = scanNext();
      }
    }
  }
  function parseString(isValue) {
    const value = _scanner.getTokenValue();
    if (isValue) {
      onLiteralValue(value);
    } else {
      onObjectProperty(value);
      _jsonPath.push(value);
    }
    scanNext();
    return true;
  }
  function parseLiteral() {
    switch (_scanner.getToken()) {
      case 11:
        const tokenValue = _scanner.getTokenValue();
        let value = Number(tokenValue);
        if (isNaN(value)) {
          handleError(2);
          value = 0;
        }
        onLiteralValue(value);
        break;
      case 7:
        onLiteralValue(null);
        break;
      case 8:
        onLiteralValue(true);
        break;
      case 9:
        onLiteralValue(false);
        break;
      default:
        return false;
    }
    scanNext();
    return true;
  }
  function parseProperty() {
    if (_scanner.getToken() !== 10) {
      handleError(3, [], [2, 5]);
      return false;
    }
    parseString(false);
    if (_scanner.getToken() === 6) {
      onSeparator(":");
      scanNext();
      if (!parseValue()) {
        handleError(4, [], [2, 5]);
      }
    } else {
      handleError(5, [], [2, 5]);
    }
    _jsonPath.pop();
    return true;
  }
  function parseObject() {
    onObjectBegin();
    scanNext();
    let needsComma = false;
    while (_scanner.getToken() !== 2 && _scanner.getToken() !== 17) {
      if (_scanner.getToken() === 5) {
        if (!needsComma) {
          handleError(4, [], []);
        }
        onSeparator(",");
        scanNext();
        if (_scanner.getToken() === 2 && allowTrailingComma) {
          break;
        }
      } else if (needsComma) {
        handleError(6, [], []);
      }
      if (!parseProperty()) {
        handleError(4, [], [2, 5]);
      }
      needsComma = true;
    }
    onObjectEnd();
    if (_scanner.getToken() !== 2) {
      handleError(7, [2], []);
    } else {
      scanNext();
    }
    return true;
  }
  function parseArray() {
    onArrayBegin();
    scanNext();
    let isFirstElement = true;
    let needsComma = false;
    while (_scanner.getToken() !== 4 && _scanner.getToken() !== 17) {
      if (_scanner.getToken() === 5) {
        if (!needsComma) {
          handleError(4, [], []);
        }
        onSeparator(",");
        scanNext();
        if (_scanner.getToken() === 4 && allowTrailingComma) {
          break;
        }
      } else if (needsComma) {
        handleError(6, [], []);
      }
      if (isFirstElement) {
        _jsonPath.push(0);
        isFirstElement = false;
      } else {
        _jsonPath[_jsonPath.length - 1]++;
      }
      if (!parseValue()) {
        handleError(4, [], [4, 5]);
      }
      needsComma = true;
    }
    onArrayEnd();
    if (!isFirstElement) {
      _jsonPath.pop();
    }
    if (_scanner.getToken() !== 4) {
      handleError(8, [4], []);
    } else {
      scanNext();
    }
    return true;
  }
  function parseValue() {
    switch (_scanner.getToken()) {
      case 3:
        return parseArray();
      case 1:
        return parseObject();
      case 10:
        return parseString(true);
      default:
        return parseLiteral();
    }
  }
  scanNext();
  if (_scanner.getToken() === 17) {
    if (options.allowEmptyContent) {
      return true;
    }
    handleError(4, [], []);
    return false;
  }
  if (!parseValue()) {
    handleError(4, [], []);
    return false;
  }
  if (_scanner.getToken() !== 17) {
    handleError(9, [], []);
  }
  return true;
}

// node_modules/jsonc-parser/lib/esm/main.js
var ScanError;
(function(ScanError2) {
  ScanError2[ScanError2["None"] = 0] = "None";
  ScanError2[ScanError2["UnexpectedEndOfComment"] = 1] = "UnexpectedEndOfComment";
  ScanError2[ScanError2["UnexpectedEndOfString"] = 2] = "UnexpectedEndOfString";
  ScanError2[ScanError2["UnexpectedEndOfNumber"] = 3] = "UnexpectedEndOfNumber";
  ScanError2[ScanError2["InvalidUnicode"] = 4] = "InvalidUnicode";
  ScanError2[ScanError2["InvalidEscapeCharacter"] = 5] = "InvalidEscapeCharacter";
  ScanError2[ScanError2["InvalidCharacter"] = 6] = "InvalidCharacter";
})(ScanError || (ScanError = {}));
var SyntaxKind;
(function(SyntaxKind2) {
  SyntaxKind2[SyntaxKind2["OpenBraceToken"] = 1] = "OpenBraceToken";
  SyntaxKind2[SyntaxKind2["CloseBraceToken"] = 2] = "CloseBraceToken";
  SyntaxKind2[SyntaxKind2["OpenBracketToken"] = 3] = "OpenBracketToken";
  SyntaxKind2[SyntaxKind2["CloseBracketToken"] = 4] = "CloseBracketToken";
  SyntaxKind2[SyntaxKind2["CommaToken"] = 5] = "CommaToken";
  SyntaxKind2[SyntaxKind2["ColonToken"] = 6] = "ColonToken";
  SyntaxKind2[SyntaxKind2["NullKeyword"] = 7] = "NullKeyword";
  SyntaxKind2[SyntaxKind2["TrueKeyword"] = 8] = "TrueKeyword";
  SyntaxKind2[SyntaxKind2["FalseKeyword"] = 9] = "FalseKeyword";
  SyntaxKind2[SyntaxKind2["StringLiteral"] = 10] = "StringLiteral";
  SyntaxKind2[SyntaxKind2["NumericLiteral"] = 11] = "NumericLiteral";
  SyntaxKind2[SyntaxKind2["LineCommentTrivia"] = 12] = "LineCommentTrivia";
  SyntaxKind2[SyntaxKind2["BlockCommentTrivia"] = 13] = "BlockCommentTrivia";
  SyntaxKind2[SyntaxKind2["LineBreakTrivia"] = 14] = "LineBreakTrivia";
  SyntaxKind2[SyntaxKind2["Trivia"] = 15] = "Trivia";
  SyntaxKind2[SyntaxKind2["Unknown"] = 16] = "Unknown";
  SyntaxKind2[SyntaxKind2["EOF"] = 17] = "EOF";
})(SyntaxKind || (SyntaxKind = {}));
var parse2 = parse;
var ParseErrorCode;
(function(ParseErrorCode2) {
  ParseErrorCode2[ParseErrorCode2["InvalidSymbol"] = 1] = "InvalidSymbol";
  ParseErrorCode2[ParseErrorCode2["InvalidNumberFormat"] = 2] = "InvalidNumberFormat";
  ParseErrorCode2[ParseErrorCode2["PropertyNameExpected"] = 3] = "PropertyNameExpected";
  ParseErrorCode2[ParseErrorCode2["ValueExpected"] = 4] = "ValueExpected";
  ParseErrorCode2[ParseErrorCode2["ColonExpected"] = 5] = "ColonExpected";
  ParseErrorCode2[ParseErrorCode2["CommaExpected"] = 6] = "CommaExpected";
  ParseErrorCode2[ParseErrorCode2["CloseBraceExpected"] = 7] = "CloseBraceExpected";
  ParseErrorCode2[ParseErrorCode2["CloseBracketExpected"] = 8] = "CloseBracketExpected";
  ParseErrorCode2[ParseErrorCode2["EndOfFileExpected"] = 9] = "EndOfFileExpected";
  ParseErrorCode2[ParseErrorCode2["InvalidCommentToken"] = 10] = "InvalidCommentToken";
  ParseErrorCode2[ParseErrorCode2["UnexpectedEndOfComment"] = 11] = "UnexpectedEndOfComment";
  ParseErrorCode2[ParseErrorCode2["UnexpectedEndOfString"] = 12] = "UnexpectedEndOfString";
  ParseErrorCode2[ParseErrorCode2["UnexpectedEndOfNumber"] = 13] = "UnexpectedEndOfNumber";
  ParseErrorCode2[ParseErrorCode2["InvalidUnicode"] = 14] = "InvalidUnicode";
  ParseErrorCode2[ParseErrorCode2["InvalidEscapeCharacter"] = 15] = "InvalidEscapeCharacter";
  ParseErrorCode2[ParseErrorCode2["InvalidCharacter"] = 16] = "InvalidCharacter";
})(ParseErrorCode || (ParseErrorCode = {}));

// src/index.ts
var MODEL_FORMAT = /^[^/\s][^\s]*\/[^\s]+$/;
function validateFallbackModels(models, context) {
  for (const model of models) {
    if (typeof model !== "string" || !MODEL_FORMAT.test(model)) {
      logInfo("Invalid fallback_models entry \u2014 expected 'provider/model' format", {
        invalidEntry: typeof model === "string" ? model : String(model),
        scope: context.scope,
        ...context.agent ? { agent: context.agent } : {},
        hint: "Rotations that reach this entry will be skipped. Fix in opencode.json."
      });
    }
  }
}
function loadPluginConfig(directory) {
  const configPaths = [
    join2(directory, ".opencode", "opencode-model-fallback.json"),
    join2(directory, ".opencode", "opencode-model-fallback.jsonc"),
    join2(process.env.HOME || "", ".config", "opencode", "opencode-model-fallback.json"),
    join2(process.env.HOME || "", ".config", "opencode", "opencode-model-fallback.jsonc")
  ];
  for (const configPath of configPaths) {
    if (existsSync2(configPath)) {
      try {
        const content = readFileSync(configPath, "utf-8");
        return parse2(content);
      } catch (err) {
        logInfo(`[${PLUGIN_NAME}] Failed to parse config: ${configPath}`, err);
      }
    }
  }
  return {};
}
async function OpenCodeFallbackPlugin(ctx, configOverrides) {
  let agentConfigs;
  let fileConfig = loadPluginConfig(ctx.directory);
  let mergedConfig;
  const globalFallbackModels = normalizeFallbackModelsField(fileConfig.fallback_models);
  validateFallbackModels(globalFallbackModels, { scope: "global" });
  const getConfig = () => {
    mergedConfig ??= {
      enabled: configOverrides?.enabled ?? fileConfig?.enabled ?? DEFAULT_CONFIG.enabled,
      retry_on_errors: configOverrides?.retry_on_errors ?? fileConfig?.retry_on_errors ?? DEFAULT_CONFIG.retry_on_errors,
      retryable_error_patterns: configOverrides?.retryable_error_patterns ?? fileConfig?.retryable_error_patterns ?? DEFAULT_CONFIG.retryable_error_patterns,
      max_fallback_attempts: configOverrides?.max_fallback_attempts ?? fileConfig?.max_fallback_attempts ?? DEFAULT_CONFIG.max_fallback_attempts,
      cooldown_seconds: configOverrides?.cooldown_seconds ?? fileConfig?.cooldown_seconds ?? DEFAULT_CONFIG.cooldown_seconds,
      timeout_seconds: configOverrides?.timeout_seconds ?? fileConfig?.timeout_seconds ?? DEFAULT_CONFIG.timeout_seconds,
      notify_on_fallback: configOverrides?.notify_on_fallback ?? fileConfig?.notify_on_fallback ?? DEFAULT_CONFIG.notify_on_fallback,
      fallback_models: configOverrides?.fallback_models ?? fileConfig?.fallback_models ?? DEFAULT_CONFIG.fallback_models,
      small_model_chain: configOverrides?.small_model_chain ?? fileConfig?.small_model_chain ?? DEFAULT_CONFIG.small_model_chain,
      sticky_fallback: configOverrides?.sticky_fallback ?? fileConfig?.sticky_fallback ?? DEFAULT_CONFIG.sticky_fallback
    };
    return mergedConfig;
  };
  const deps = {
    ctx,
    get config() {
      return getConfig();
    },
    get agentConfigs() {
      return agentConfigs;
    },
    globalFallbackModels,
    sessionStates: new Map,
    sessionLastAccess: new Map,
    sessionRetryInFlight: new Set,
    sessionAwaitingFallbackResult: new Set,
    sessionFallbackTimeouts: new Map,
    sessionFirstTokenReceived: new Map,
    sessionSelfAbortTimestamp: new Map,
    sessionParentID: new Map,
    sessionIdleResolvers: new Map,
    sessionLastMessageTime: new Map,
    sessionCompactionInFlight: new Set
  };
  const helpers = createAutoRetryHelpers(deps);
  const { handleEvent: baseEventHandler, handleActivity } = createEventHandler(deps, helpers);
  const messageUpdateHandler = createMessageUpdateHandler(deps, helpers);
  const chatMessageHandler = createChatMessageHandler(deps, helpers);
  const cleanupInterval = setInterval(helpers.cleanupStaleSessions, 5 * 60 * 1000);
  cleanupInterval.unref();
  logInfo(`Plugin initialized (${globalFallbackModels.length} global fallback model(s) configured)`);
  return {
    name: PLUGIN_NAME,
    config: (opencodeConfig) => {
      try {
        if (!opencodeConfig || typeof opencodeConfig !== "object")
          return;
        const agentValue = opencodeConfig.agent;
        const agentsValue = opencodeConfig.agents;
        const candidates = [agentValue, agentsValue];
        const found = candidates.find((v) => v && typeof v === "object" && !Array.isArray(v));
        agentConfigs = found;
        if (agentConfigs) {
          for (const [agentName, rawAgentCfg] of Object.entries(agentConfigs)) {
            if (!rawAgentCfg || typeof rawAgentCfg !== "object")
              continue;
            const agentCfg = rawAgentCfg;
            const fm = agentCfg.fallback_models;
            if (fm === undefined)
              continue;
            const models = normalizeFallbackModelsField(fm);
            validateFallbackModels(models, { scope: "agent", agent: agentName });
          }
        }
        logInfo(`Plugin initialized with ${agentConfigs ? Object.keys(agentConfigs).length : 0} agents`);
      } catch (err) {
        logError("config hook error", { error: String(err) });
      }
    },
    event: async (arg0) => {
      try {
        const wrapper = arg0 && typeof arg0 === "object" ? arg0 : undefined;
        const ev = wrapper?.event ?? arg0;
        if (!ev || typeof ev !== "object" || typeof ev.type !== "string")
          return;
        if (ev.type === "message.updated") {
          if (!deps.config.enabled)
            return;
          const props = ev.properties;
          await messageUpdateHandler(props);
          return;
        }
        if (ev.type === "message.part.delta" || ev.type === "session.diff" || ev.type === "message.part.updated") {
          const props = ev.properties;
          const info = props?.info;
          const sessionID = props?.sessionID ?? info?.sessionID ?? info?.id;
          const activityModel = info?.model ?? (typeof info?.providerID === "string" && typeof info?.modelID === "string" ? `${info.providerID}/${info.modelID}` : undefined) ?? props?.model;
          if (sessionID) {
            await handleActivity(sessionID, activityModel);
          }
        }
        await baseEventHandler({ event: ev });
      } catch (err) {
        logError("event hook error", { error: String(err) });
      }
    },
    "tool.execute.after": async (input, output) => {
      try {
        if (input.tool !== "task" || !isEmptyTaskResult(output.output)) {
          return;
        }
        const childSessionID = extractChildSessionID(output.output);
        if (!childSessionID) {
          logInfo("Empty task result but no child session ID found", {
            sessionID: input.sessionID,
            outputPreview: output.output?.substring(0, 200)
          });
          return;
        }
        logInfo("Detected empty task result, waiting for child fallback", {
          parentSession: input.sessionID,
          childSession: childSessionID
        });
        const maxWaitMs = Math.min((deps.config.timeout_seconds || 120) * 1000, 120000);
        const replacementText = await waitForChildFallbackResult(deps, childSessionID, {
          maxWaitMs,
          pollIntervalMs: 500
        });
        if (replacementText) {
          output.output = replacementText;
          logInfo("Replaced empty task result with fallback response", {
            parentSession: input.sessionID,
            childSession: childSessionID,
            responseLength: replacementText.length
          });
        } else {
          logInfo("No fallback response available, preserving original output", {
            parentSession: input.sessionID,
            childSession: childSessionID
          });
        }
      } catch (err) {
        logError("tool.execute.after hook error", { error: String(err) });
      }
    },
    "chat.message": async (input, output) => {
      try {
        await chatMessageHandler(input, output);
      } catch (err) {
        logError("chat.message hook error", { error: String(err) });
      }
    },
    "experimental.provider.small_model": async (input, output) => {
      try {
        const cfg = deps.config;
        if (!cfg.enabled)
          return;
        const chain = cfg.small_model_chain ?? [];
        if (!chain.length)
          return;
        const now = Date.now();
        const cooldownMs = (cfg.cooldown_seconds ?? 60) * 1000;
        let providers = [];
        try {
          const res = await ctx.client.config.providers();
          providers = res?.data?.providers ?? res?.providers ?? [];
        } catch (err) {
          logError("small_model hook: failed to list providers", { error: String(err) });
        }
        for (const candidate of chain) {
          const idx = candidate.indexOf("/");
          if (idx <= 0)
            continue;
          const providerID = candidate.slice(0, idx);
          const modelID = candidate.slice(idx + 1);
          const failedAt = smallModelProviderCooldowns.get(providerID);
          if (failedAt && now - failedAt < cooldownMs) {
            logInfo(`small_model chain skip ${candidate} (provider in cooldown)`);
            continue;
          }
          const provider = providers.find((p) => p && p.id === providerID);
          const model = provider && provider.models ? provider.models[modelID] : undefined;
          if (model) {
            output.model = model;
            logInfo(`small_model chain selected ${candidate}`);
            return;
          }
          logInfo(`small_model chain candidate not found: ${candidate}`);
        }
        logInfo("small_model chain exhausted, leaving to opencode heuristic", {});
      } catch (err) {
        logError("small_model hook error", { error: String(err) });
      }
    }
  };
}
export {
  OpenCodeFallbackPlugin as default
};
