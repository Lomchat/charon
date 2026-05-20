CREATE TABLE `vps_paths` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vps_id` text NOT NULL,
	`path` text NOT NULL,
	`label` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`vps_id`) REFERENCES `vps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Data migration: copy vps_project_paths → vps_paths using projects.name
-- as the label. Dedup on (vps_id, path).
INSERT INTO `vps_paths` (`vps_id`, `path`, `label`)
SELECT vpp.vps_id, vpp.path, MIN(p.name)
FROM `vps_project_paths` vpp
LEFT JOIN `projects` p ON p.id = vpp.project_id
GROUP BY vpp.vps_id, vpp.path;--> statement-breakpoint
DROP TABLE `vps_project_paths`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_claude_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`claude_session_id` text,
	`vps_id` text NOT NULL,
	`cwd` text NOT NULL,
	`name` text,
	`status` text NOT NULL,
	`permission_mode` text DEFAULT 'normal' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`vps_id`) REFERENCES `vps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_claude_sessions`("id", "claude_session_id", "vps_id", "cwd", "name", "status", "permission_mode", "created_at", "last_used_at") SELECT "id", "claude_session_id", "vps_id", "cwd", "name", "status", "permission_mode", "created_at", "last_used_at" FROM `claude_sessions`;--> statement-breakpoint
DROP TABLE `claude_sessions`;--> statement-breakpoint
ALTER TABLE `__new_claude_sessions` RENAME TO `claude_sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;