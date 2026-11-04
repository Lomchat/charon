CREATE TABLE `provider_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`email` text,
	`display_name` text,
	`organization` text,
	`plan` text,
	`account_key` text,
	`credentials` text NOT NULL,
	`access_expires_at` integer,
	`login_expires_at` integer,
	`earliest_refresh_at` integer,
	`last_refresh_at` integer,
	`status` text DEFAULT 'ok' NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_provider_accounts_provider_key` ON `provider_accounts` (`provider`,`account_key`);