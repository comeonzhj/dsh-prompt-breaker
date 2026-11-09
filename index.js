/**
 * Prompt Breaker — host half.
 *
 * The whole toy lives in the browser half: it folds the live Session event
 * stream (user prompts, tool calls, turn boundaries) and paints the arcade.
 * This host plugin exists so the bundle has a loadable row; it owns no Host
 * services or resources.
 */
export function apply() {}
