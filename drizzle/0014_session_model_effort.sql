-- Per-session model / fallback_model / effort configuration.
--
-- All three columns are nullable: NULL means "use the global default"
-- (cf. claude_settings keys 'claude.default_model', 'claude.default_fallback_model',
--  'claude.default_effort'), which itself can be NULL meaning "use the SDK default".
--
-- Valid effort values mirror claude_agent_sdk.EffortLevel:
--   'low' | 'medium' | 'high' | 'xhigh' | 'max'
-- Not enforced at the SQL level — agent-side validation drops invalid values.
--
-- model / fallback_model are free strings (e.g. 'claude-opus-4-7-...',
-- 'claude-opus-4-8-...'). The SDK on each VPS controls which model strings
-- are actually accepted; an unknown model will produce a runtime SDK error
-- emitted as `error` event.
--
-- Hand-written: trivial ALTER TABLE x3.
ALTER TABLE `claude_sessions` ADD `model` text;
--> statement-breakpoint
ALTER TABLE `claude_sessions` ADD `fallback_model` text;
--> statement-breakpoint
ALTER TABLE `claude_sessions` ADD `effort` text;
