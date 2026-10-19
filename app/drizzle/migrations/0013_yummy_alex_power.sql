CREATE TABLE `gameMoves` (
	`gameId` text NOT NULL,
	`version` integer NOT NULL,
	`player` integer NOT NULL,
	`action` text NOT NULL,
	`createdAt` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`gameId`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `games` ADD `initialData` blob;--> statement-breakpoint
CREATE UNIQUE INDEX `gameMoves_gameId_version_unique` ON `gameMoves` (`gameId`,`version`);