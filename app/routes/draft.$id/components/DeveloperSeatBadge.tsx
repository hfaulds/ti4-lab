import { Button, Group, Paper, Text } from "@mantine/core";
import { IconCode } from "@tabler/icons-react";
import { useDraft } from "~/draftStore";
import { Draft, PlayerId } from "~/types";

/**
 * The player the draft is waiting on: whoever holds the current pick, or the
 * first player yet to choose in a simultaneous phase.
 */
export function nextDraftPlayer(draft: Draft): PlayerId | undefined {
  const pick = draft.pickOrder[draft.selections.length];
  if (typeof pick === "number") return pick;
  if (pick?.kind === "simultaneous") {
    const staged = draft.stagedSelections?.[pick.phase] ?? {};
    return draft.players.find((p) => staged[p.id] === undefined)?.id;
  }
  return undefined;
}

export function DeveloperSeatBadge({ onLeave }: { onLeave: () => void }) {
  const name = useDraft(
    (state) =>
      state.draft.players.find((p) => p.id === state.selectedPlayer)?.name,
  );
  return (
    <Paper
      withBorder
      shadow="md"
      px="sm"
      py={6}
      style={{ position: "fixed", bottom: 16, right: 16, zIndex: 1000 }}
    >
      <Group gap="xs" wrap="nowrap">
        <IconCode size={16} />
        <Text size="sm">
          Developer, picking as{" "}
          <Text span fw={700}>
            {name ?? "nobody"}
          </Text>
        </Text>
        <Button size="compact-xs" variant="default" onClick={onLeave}>
          Leave
        </Button>
      </Group>
    </Paper>
  );
}
