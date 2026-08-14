// Test-support module — re-exports the pure classifier/fallback helpers so
// tests can import them WITHOUT forcing named exports on the plugin entry.
//
// opencode 1.18.18's getLegacyPlugins() calls EVERY function export of the
// plugin module as a plugin factory; a named function export that returns
// undefined pollutes the hooks array and crashes Provider.list/Plugin.trigger
// on undefined.provider. Rule (upstream fork warning, issue #42451): the
// plugin entry MUST be default-only. Tests import the pure functions from
// HERE (or from ./error-classifier directly) instead of from the bundle.
export {
	classifyErrorType,
	isRetryableError,
	decideFallbackAction,
	detectErrorInTextParts,
	extractErrorContentFromParts,
} from "./error-classifier"
