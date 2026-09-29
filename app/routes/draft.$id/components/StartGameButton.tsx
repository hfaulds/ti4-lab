import {
  Alert,
  Button,
  Checkbox,
  Modal,
  SegmentedControl,
  Select,
  Stack,
  Text,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconSwords } from "@tabler/icons-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { factions } from "~/data/factionData";
import { useDraft } from "~/draftStore";
import { EXPANSIONS, Expansion } from "~/game/data";
import { useHydratedDraft } from "~/hooks/useHydratedDraft";
import { FactionId, GameSet } from "~/types";

const KELERES_HOMES: FactionId[] = ["mentak", "xxcha", "argent"];

/** Expansions the draft was set up with are switched on to begin with. */
function defaultExpansions(sets: GameSet[]): Expansion[] {
  const chosen: Expansion[] = [];
  if (sets.includes("pok") || sets.includes("te")) chosen.push("pok");
  if (sets.includes("te")) chosen.push("te");
  return chosen;
}

export function StartGameButton() {
  const navigate = useNavigate();
  const [opened, { open, close }] = useDisclosure(false);
  const draftUrl = useDraft((state) => state.draftUrl);
  const settings = useDraft((state) => state.draft.settings);
  const { hydratedPlayers } = useHydratedDraft();

  const [expansions, setExpansions] = useState<Expansion[]>(() =>
    defaultExpansions([...settings.factionGameSets, ...settings.tileGameSets]),
  );
  const [victoryPoints, setVictoryPoints] = useState("10");
  const [keleresVariant, setKeleresVariant] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);

  const drafted = hydratedPlayers.map((p) => p.faction);
  const hasKeleres = drafted.includes("keleres");
  const keleresOptions = KELERES_HOMES.filter((id) => !drafted.includes(id));

  const start = async () => {
    setStarting(true);
    setError(undefined);
    try {
      const response = await fetch("/api/game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draft: draftUrl,
          expansions,
          victoryPoints: Number(victoryPoints),
          keleresVariant: keleresVariant ?? undefined,
        }),
      });
      const result = (await response.json()) as {
        success: boolean;
        urlName?: string;
        error?: string;
      };
      if (result.success && result.urlName) {
        navigate(`/game/${result.urlName}`);
        return;
      }
      setError(result.error ?? "The game could not be started.");
    } catch {
      setError("The game could not be started. Check your connection.");
    } finally {
      setStarting(false);
    }
  };

  return (
    <>
      <Button size="md" leftSection={<IconSwords size={18} />} onClick={open}>
        Start Game
      </Button>
      <Modal opened={opened} onClose={close} title="Start a game" centered>
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Plays this draft&apos;s map, factions and speaker order. The base game
            is always included.
          </Text>
          <Checkbox.Group
            label="Expansions and codices"
            value={expansions}
            onChange={(value) => setExpansions(value as Expansion[])}
          >
            <Stack gap="xs" mt="xs">
              {EXPANSIONS.map((expansion) => (
                <Checkbox
                  key={expansion.id}
                  value={expansion.id}
                  label={expansion.name}
                  description={expansion.description}
                />
              ))}
            </Stack>
          </Checkbox.Group>
          <Stack gap={4}>
            <Text size="sm" fw={500}>
              Victory points to win
            </Text>
            <SegmentedControl
              data={["10", "14"]}
              value={victoryPoints}
              onChange={setVictoryPoints}
            />
          </Stack>
          {hasKeleres && (
            <Select
              label="Council Keleres home system"
              description="They take the home system of a faction that is not in the game."
              placeholder="Choose a home system"
              data={keleresOptions.map((id) => ({
                value: id,
                label: factions[id].name,
              }))}
              value={keleresVariant}
              onChange={setKeleresVariant}
            />
          )}
          {error && (
            <Alert color="red" title="Could not start the game">
              {error}
            </Alert>
          )}
          <Button
            loading={starting}
            disabled={hasKeleres && !keleresVariant}
            onClick={start}
          >
            Start game
          </Button>
        </Stack>
      </Modal>
    </>
  );
}
