CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`urlName` text NOT NULL,
	`draftId` text,
	`data` blob NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`isComplete` integer DEFAULT false NOT NULL,
	`createdAt` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`draftId`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `games_urlName_unique` ON `games` (`urlName`);--> statement-breakpoint
CREATE INDEX `games_draftId_index` ON `games` (`draftId`);