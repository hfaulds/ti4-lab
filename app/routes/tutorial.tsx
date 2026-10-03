import { useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Container,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Title,
  UnstyledButton,
  rem,
} from "@mantine/core";
import {
  IconCheck,
  IconChevronRight,
  IconMap,
  IconStar,
} from "@tabler/icons-react";
import { Link } from "react-router";
import { MainAppShell } from "~/components/MainAppShell";
import { DemoMap } from "~/components/DemoMap";
import { FactionIcon } from "~/components/icons/FactionIcon";
import { factions as allFactions, playerColors } from "~/data/factionData";
import { hydrateDemoMap } from "~/utils/map";
import { milty } from "~/draft/milty/config";
import { shuffle } from "~/draft/helpers/randomization";
import { OptionCard } from "~/ui/OptionCard";
import type { FactionId } from "~/types";

// ─── constants ───────────────────────────────────────────────────────────────

const BASE_FACTIONS: FactionId[] = [
  "sardakk", "arborec", "barony", "saar", "muaat", "hacan",
  "sol", "creuss", "l1z1x", "mentak", "naalu", "nekro",
  "jolnar", "winnu", "xxcha", "yin", "yssaril",
];

const MAP_OPTIONS = [
  {
    id: "standard",
    name: "Standard Galaxy",
    description:
      "A balanced 6-player galaxy with equal slice values for all players. The default for competitive play.",
  },
  {
    id: "wormhole",
    name: "Wormhole Web",
    description:
      "Rich in wormhole connections. Control the gates to project power across distant regions of the galaxy.",
  },
  {
    id: "anomaly",
    name: "Ancient Anomalies",
    description:
      "Treacherous space filled with gravity rifts, supernovas, and asteroid fields. High risk, high reward.",
  },
];

type StrategyCard = {
  initiative: number;
  name: string;
  color: string;
  tradeGoods: number;
  primary: string;
  secondary: string;
};

const STRATEGY_CARDS: StrategyCard[] = [
  {
    initiative: 1, name: "Leadership", color: "yellow", tradeGoods: 1,
    primary: "Gain 3 command tokens. Spend any number to distribute them to other players.",
    secondary: "Spend 6 influence to gain 3 command tokens.",
  },
  {
    initiative: 2, name: "Diplomacy", color: "blue", tradeGoods: 2,
    primary: "Lock down a system — other players can't activate it this round. Replenish your commodities.",
    secondary: "Spend 1 strategy token to ready 2 of your exhausted planets.",
  },
  {
    initiative: 3, name: "Politics", color: "violet", tradeGoods: 3,
    primary: "Choose a new Speaker. Draw 2 action cards. Peek at the top 2 agenda cards.",
    secondary: "Spend 1 strategy token to draw 2 action cards.",
  },
  {
    initiative: 4, name: "Construction", color: "orange", tradeGoods: 3,
    primary: "Place 2 structures (PDS or Space Dock) on planets you control.",
    secondary: "Spend 1 strategy token to place 1 structure on a planet you control.",
  },
  {
    initiative: 5, name: "Trade", color: "green", tradeGoods: 3,
    primary: "Gain 3 trade goods. Replenish commodities. Other players who replenish give you 1 trade good each.",
    secondary: "Spend 1 strategy token to replenish your commodities.",
  },
  {
    initiative: 6, name: "Warfare", color: "red", tradeGoods: 2,
    primary: "Remove 1 command token from the board and return it to your reinforcements.",
    secondary: "Spend 1 strategy token to remove 1 command token from the board.",
  },
  {
    initiative: 7, name: "Technology", color: "teal", tradeGoods: 2,
    primary: "Research 1 technology. Spend 6 resources to research 1 additional technology.",
    secondary: "Spend 1 strategy token and 4 resources to research 1 technology.",
  },
  {
    initiative: 8, name: "Imperial", color: "indigo", tradeGoods: 0,
    primary: "Score 1 secret objective. Gain 1 VP if you hold Mecatol Rex or have 3+ VP. Draw 1 secret objective.",
    secondary: "Spend 1 strategy token to score 1 secret objective.",
  },
];

const PLAYER_NAMES = ["Ajax", "Sera", "Thane", "Voss", "Kira", "Drake"];
const SPEAKER_LABELS = ["Speaker", "2nd", "3rd", "4th", "5th", "6th"];

const PLAYER_COLOR_CSS: Record<string, string> = {
  blue:    "var(--mantine-color-blue-5)",
  red:     "var(--mantine-color-red-7)",
  green:   "var(--mantine-color-green-6)",
  magenta: "var(--mantine-color-pink-6)",
  violet:  "var(--mantine-color-violet-6)",
  orange:  "var(--mantine-color-orange-6)",
};

// ─── types ────────────────────────────────────────────────────────────────────

type Step = "map" | "draft" | "player" | "strategy" | "done";

type TutorialPlayer = {
  seatIdx: number;
  factionId: FactionId;
  speakerOrder: number;
  name: string;
};

// ─── sub-components ──────────────────────────────────────────────────────────

function StepIndicator({ step }: { step: Step }) {
  const steps: { id: Step; label: string }[] = [
    { id: "map",      label: "Pick Map"     },
    { id: "draft",    label: "View Draft"   },
    { id: "player",   label: "Pick Player"  },
    { id: "strategy", label: "Strategy"     },
  ];
  const currentIdx = steps.findIndex((s) => s.id === step);
  return (
    <Group justify="center" gap="xs" mb="xl" wrap="nowrap">
      {steps.map((s, i) => (
        <Group key={s.id} gap={4} wrap="nowrap">
          <Box
            style={{
              width: 8, height: 8, borderRadius: "50%",
              background: i <= currentIdx
                ? "var(--mantine-color-blue-5)"
                : "var(--mantine-color-dark-4)",
              flexShrink: 0,
            }}
          />
          <Text
            size="xs"
            c={i <= currentIdx ? "blue.4" : "dimmed"}
            visibleFrom="sm"
            style={{ whiteSpace: "nowrap" }}
          >
            {s.label}
          </Text>
          {i < steps.length - 1 && (
            <Box
              w={24} h={1}
              bg={i < currentIdx ? "blue.5" : "dark.4"}
              visibleFrom="sm"
            />
          )}
        </Group>
      ))}
    </Group>
  );
}

function PlayerRow({
  player,
  isUser,
  onClick,
}: {
  player: TutorialPlayer;
  isUser: boolean;
  onClick?: () => void;
}) {
  const color = playerColors[player.seatIdx] ?? "blue";
  const faction = allFactions[player.factionId];
  return (
    <UnstyledButton onClick={onClick} style={{ width: "100%", cursor: onClick ? "pointer" : "default" }}>
      <Paper
        withBorder
        p="sm"
        style={{
          borderLeft: `4px solid ${PLAYER_COLOR_CSS[color] ?? "#888"}`,
          transition: "background 0.15s",
        }}
        styles={onClick ? { root: { "&:hover": { background: "var(--mantine-color-dark-6)" } } } : undefined}
      >
        <Group justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap" style={{ overflow: "hidden" }}>
            <FactionIcon faction={player.factionId} style={{ width: 32, height: 32, flexShrink: 0 }} />
            <Stack gap={0} style={{ overflow: "hidden" }}>
              <Text size="sm" fw={600} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {faction.name}
              </Text>
              <Text size="xs" c={isUser ? "blue.4" : "dimmed"}>
                {isUser ? "YOU" : player.name}
              </Text>
            </Stack>
          </Group>
          <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
            <Badge size="xs" variant="outline" color="gray">
              {SPEAKER_LABELS[player.speakerOrder]}
            </Badge>
            {onClick && <IconChevronRight size={14} color="var(--mantine-color-dimmed)" />}
          </Group>
        </Group>
      </Paper>
    </UnstyledButton>
  );
}

function StrategyCardTile({
  card,
  takenByFaction,
  isUserPick,
  onPick,
}: {
  card: StrategyCard;
  takenByFaction?: FactionId;
  isUserPick?: boolean;
  onPick?: () => void;
}) {
  const taken = !!takenByFaction || isUserPick;
  return (
    <Paper
      withBorder
      p="md"
      onClick={!taken ? onPick : undefined}
      style={{
        cursor: !taken && onPick ? "pointer" : "default",
        opacity: taken && !isUserPick ? 0.45 : 1,
        borderTop: `3px solid var(--mantine-color-${card.color}-${taken ? "8" : "5"})`,
        outline: isUserPick ? `2px solid var(--mantine-color-${card.color}-5)` : undefined,
        transition: "opacity 0.2s, transform 0.15s",
        transform: !taken && onPick ? undefined : undefined,
        position: "relative",
      }}
    >
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Badge color={card.color} variant="filled" size="lg" circle>
              {card.initiative}
            </Badge>
            <Text fw={700} size="sm">{card.name}</Text>
          </Group>
          {takenByFaction && (
            <FactionIcon faction={takenByFaction} style={{ width: 20, height: 20, opacity: 0.7 }} />
          )}
          {isUserPick && (
            <IconCheck size={16} color={`var(--mantine-color-${card.color}-4)`} />
          )}
        </Group>

        <Text size="xs" c="dimmed" lineClamp={2}>{card.primary}</Text>

        {card.tradeGoods > 0 && !taken && (
          <Text size="xs" c="yellow.5">
            {Array.from({ length: card.tradeGoods }, (_, i) => "◈").join(" ")} if unpicked
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

// ─── steps ────────────────────────────────────────────────────────────────────

function MapPicker({ onPick }: { onPick: (id: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <Stack gap="lg">
      <Stack gap="xs">
        <Title order={2} ff="heading">Choose a Galaxy</Title>
        <Text c="dimmed" size="sm">
          In TI4, the galaxy is built from a set of hex tiles before the game begins. Each map
          style creates a different strategic landscape. Pick one to start your tutorial game.
        </Text>
      </Stack>
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
        {MAP_OPTIONS.map((opt) => (
          <OptionCard
            key={opt.id}
            title={opt.name}
            description={opt.description}
            checked={selected === opt.id}
            onSelect={() => { setSelected(opt.id); onPick(opt.id); }}
            icon={
              <Box c="blue.4">
                <IconMap size={28} />
              </Box>
            }
          />
        ))}
      </SimpleGrid>
    </Stack>
  );
}

function DraftReveal({
  players,
  demoMapTiles,
  onContinue,
}: {
  players: TutorialPlayer[];
  demoMapTiles: ReturnType<typeof hydrateDemoMap>;
  onContinue: () => void;
}) {
  const titles = useMemo(
    () => Array.from({ length: 6 }, (_, i) => {
      const p = players.find((pl) => pl.seatIdx === i);
      if (!p) return "";
      return allFactions[p.factionId].name.split(" ")[0];
    }),
    [players],
  );

  const sorted = [...players].sort((a, b) => a.speakerOrder - b.speakerOrder);

  return (
    <Stack gap="lg">
      <Stack gap="xs">
        <Group gap="sm">
          <Title order={2} ff="heading">Draft Complete</Title>
          <Badge color="green" variant="filled">Random</Badge>
        </Group>
        <Text c="dimmed" size="sm">
          The galaxy has been distributed. Each player has been randomly assigned a faction and
          a seat on the map. The <Text span fw={600} c="yellow.4">Speaker</Text> picks strategy cards first each round.
        </Text>
      </Stack>

      <Box style={{ width: "100%", minHeight: 320 }}>
        <DemoMap id="tutorial-draft" map={demoMapTiles} padding={0} titles={titles} />
      </Box>

      <Stack gap="xs">
        <Text size="sm" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: "0.08em" }}>
          Player Assignments
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
          {sorted.map((p) => (
            <PlayerRow key={p.seatIdx} player={p} isUser={false} />
          ))}
        </SimpleGrid>
      </Stack>

      <Group justify="flex-end">
        <Button onClick={onContinue} rightSection={<IconChevronRight size={16} />}>
          Choose Your Commander
        </Button>
      </Group>
    </Stack>
  );
}

function PlayerPicker({
  players,
  demoMapTiles,
  onPick,
}: {
  players: TutorialPlayer[];
  demoMapTiles: ReturnType<typeof hydrateDemoMap>;
  onPick: (seatIdx: number) => void;
}) {
  const [hoveredSeat, setHoveredSeat] = useState<number | null>(null);

  const titles = useMemo(
    () => Array.from({ length: 6 }, (_, i) => {
      const p = players.find((pl) => pl.seatIdx === i);
      if (!p) return "";
      if (hoveredSeat === i) return "YOU?";
      return allFactions[p.factionId].name.split(" ")[0];
    }),
    [players, hoveredSeat],
  );

  const sorted = [...players].sort((a, b) => a.speakerOrder - b.speakerOrder);

  return (
    <Stack gap="lg">
      <Stack gap="xs">
        <Title order={2} ff="heading">Who Are You?</Title>
        <Text c="dimmed" size="sm">
          You are joining this game. Choose a faction to control for the tutorial.
          Each faction has unique abilities, starting units, and faction technologies.
        </Text>
      </Stack>

      <Box style={{ width: "100%", minHeight: 320 }}>
        <DemoMap id="tutorial-pick" map={demoMapTiles} padding={0} titles={titles} />
      </Box>

      <Stack gap="xs">
        <Text size="sm" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: "0.08em" }}>
          Select a Faction
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
          {sorted.map((p) => (
            <Box
              key={p.seatIdx}
              onMouseEnter={() => setHoveredSeat(p.seatIdx)}
              onMouseLeave={() => setHoveredSeat(null)}
            >
              <PlayerRow
                player={p}
                isUser={false}
                onClick={() => onPick(p.seatIdx)}
              />
            </Box>
          ))}
        </SimpleGrid>
      </Stack>
    </Stack>
  );
}

function StrategyPhase({
  players,
  userSeatIdx,
  onDone,
}: {
  players: TutorialPlayer[];
  userSeatIdx: number;
  onDone: (initiative: number) => void;
}) {
  const [pickedInitiative, setPickedInitiative] = useState<number | null>(null);

  const userPlayer = players.find((p) => p.seatIdx === userSeatIdx)!;
  const userSpeakerOrder = userPlayer.speakerOrder;

  // Determine which cards earlier players took (randomized once on mount)
  const prePickedMap = useMemo<Map<number, FactionId>>(() => {
    const earlierPlayers = players
      .filter((p) => p.speakerOrder < userSpeakerOrder)
      .sort((a, b) => a.speakerOrder - b.speakerOrder);
    const shuffledInitiatives = shuffle([1, 2, 3, 4, 5, 6, 7, 8]);
    const result = new Map<number, FactionId>();
    earlierPlayers.forEach((p, i) => {
      result.set(shuffledInitiatives[i], p.factionId);
    });
    return result;
  }, [players, userSpeakerOrder]);

  const handlePick = (initiative: number) => {
    if (prePickedMap.has(initiative) || pickedInitiative !== null) return;
    setPickedInitiative(initiative);
    onDone(initiative);
  };

  const userCard = STRATEGY_CARDS.find((c) => c.initiative === pickedInitiative);

  return (
    <Stack gap="lg">
      <Stack gap="xs">
        <Title order={2} ff="heading">Strategy Phase</Title>
        <Text c="dimmed" size="sm">
          At the start of every round, players take turns picking a <Text span fw={600}>strategy card</Text>.
          Each card gives you a powerful primary ability and lets others use a weaker secondary.
          Cards are picked in speaker order — lower is better.
        </Text>
      </Stack>

      <Paper withBorder p="sm" bg="dark.7">
        <Group gap="md">
          <FactionIcon
            faction={userPlayer.factionId}
            style={{ width: 36, height: 36 }}
          />
          <Stack gap={0}>
            <Text size="sm" fw={600}>{allFactions[userPlayer.factionId].name}</Text>
            <Text size="xs" c="dimmed">
              You are{" "}
              <Text span fw={700} c="yellow.4">
                {SPEAKER_LABELS[userSpeakerOrder]}
              </Text>{" "}
              in speaker order — {userSpeakerOrder === 0
                ? "you pick first!"
                : `${userSpeakerOrder} player${userSpeakerOrder > 1 ? "s" : ""} pick before you.`}
            </Text>
          </Stack>
        </Group>
      </Paper>

      {pickedInitiative === null ? (
        <Stack gap="xs">
          <Text size="sm" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: "0.08em" }}>
            {prePickedMap.size > 0
              ? `${prePickedMap.size} card${prePickedMap.size > 1 ? "s" : ""} already taken — pick one of the remaining`
              : "You pick first — choose a strategy card"}
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="sm">
            {STRATEGY_CARDS.map((card) => (
              <StrategyCardTile
                key={card.initiative}
                card={card}
                takenByFaction={prePickedMap.get(card.initiative)}
                onPick={() => handlePick(card.initiative)}
              />
            ))}
          </SimpleGrid>
        </Stack>
      ) : (
        <Stack gap="md">
          <Text size="sm" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: "0.08em" }}>
            All cards assigned
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="sm">
            {STRATEGY_CARDS.map((card) => (
              <StrategyCardTile
                key={card.initiative}
                card={card}
                takenByFaction={prePickedMap.get(card.initiative)}
                isUserPick={card.initiative === pickedInitiative}
              />
            ))}
          </SimpleGrid>

          {userCard && (
            <Paper withBorder p="md" style={{ borderColor: `var(--mantine-color-${userCard.color}-5)` }}>
              <Stack gap="xs">
                <Group gap="sm">
                  <Badge color={userCard.color} variant="filled" size="lg" circle>
                    {userCard.initiative}
                  </Badge>
                  <Text fw={700}>You chose: {userCard.name}</Text>
                </Group>
                <Text size="sm">
                  <Text span fw={600}>Primary: </Text>
                  {userCard.primary}
                </Text>
                <Text size="sm">
                  <Text span fw={600}>Secondary: </Text>
                  {userCard.secondary}
                </Text>
              </Stack>
            </Paper>
          )}
        </Stack>
      )}
    </Stack>
  );
}

function DoneStep({ players, userSeatIdx, cardInitiative }: {
  players: TutorialPlayer[];
  userSeatIdx: number;
  cardInitiative: number;
}) {
  const userPlayer = players.find((p) => p.seatIdx === userSeatIdx)!;
  const card = STRATEGY_CARDS.find((c) => c.initiative === cardInitiative)!;

  return (
    <Stack gap="xl" align="center" ta="center" py="xl">
      <IconStar size={48} color="var(--mantine-color-yellow-4)" />
      <Stack gap="xs">
        <Title order={2} ff="heading">Round 1 Begins!</Title>
        <Text c="dimmed" maw={500}>
          You are playing as{" "}
          <Text span fw={600} c="white">{allFactions[userPlayer.factionId].name}</Text>{" "}
          with the{" "}
          <Text span fw={600} c={`${card.color}.4`}>{card.name}</Text>{" "}
          strategy card. Now the Action Phase begins — players take turns
          activating systems to move ships, build units, and compete for objectives.
        </Text>
      </Stack>

      <Stack gap="xs" maw={400} w="100%">
        <Text size="sm" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: "0.08em" }}>
          What happens next
        </Text>
        {[
          "Players take turns activating systems and moving fleets",
          "Use your strategy card's primary ability on your turn",
          "Other players may use the secondary ability by spending strategy tokens",
          "Score objectives — first to 10 Victory Points wins",
        ].map((item, i) => (
          <Group key={i} gap="sm" align="flex-start">
            <IconCheck size={16} color="var(--mantine-color-green-5)" style={{ flexShrink: 0, marginTop: 2 }} />
            <Text size="sm" ta="left">{item}</Text>
          </Group>
        ))}
      </Stack>

      <Group>
        <Button
          component={Link}
          to="/draft/prechoice"
          size="lg"
          rightSection={<IconChevronRight size={18} />}
        >
          Start a Real Draft
        </Button>
        <Button
          variant="subtle"
          component={Link}
          to="/about"
        >
          About TI4 Lab
        </Button>
      </Group>
    </Stack>
  );
}

// ─── main component ───────────────────────────────────────────────────────────

export default function Tutorial() {
  const [step, setStep] = useState<Step>("map");
  const [players, setPlayers] = useState<TutorialPlayer[]>([]);
  const [userSeatIdx, setUserSeatIdx] = useState<number | null>(null);
  const [cardInitiative, setCardInitiative] = useState<number | null>(null);

  const demoMapTiles = useMemo(() => hydrateDemoMap(milty), []);

  const handlePickMap = (_mapId: string) => {
    const selectedFactions = shuffle(BASE_FACTIONS).slice(0, 6);
    const speakerOrders = shuffle([0, 1, 2, 3, 4, 5]);
    const names = shuffle(PLAYER_NAMES);
    setPlayers(
      selectedFactions.map((factionId, i) => ({
        seatIdx: i,
        factionId,
        speakerOrder: speakerOrders[i],
        name: names[i] ?? `Player ${i + 1}`,
      })),
    );
    setStep("draft");
  };

  const handlePickPlayer = (seatIdx: number) => {
    setUserSeatIdx(seatIdx);
    setStep("strategy");
  };

  const handlePickCard = (initiative: number) => {
    setCardInitiative(initiative);
    setStep("done");
  };

  return (
    <MainAppShell>
      <Container size="lg" py="xl">
        <Stack gap={0}>
          {step !== "done" && <StepIndicator step={step} />}

          {step === "map" && (
            <MapPicker onPick={handlePickMap} />
          )}

          {step === "draft" && (
            <DraftReveal
              players={players}
              demoMapTiles={demoMapTiles}
              onContinue={() => setStep("player")}
            />
          )}

          {step === "player" && (
            <PlayerPicker
              players={players}
              demoMapTiles={demoMapTiles}
              onPick={handlePickPlayer}
            />
          )}

          {step === "strategy" && userSeatIdx !== null && (
            <StrategyPhase
              players={players}
              userSeatIdx={userSeatIdx}
              onDone={handlePickCard}
            />
          )}

          {step === "done" && userSeatIdx !== null && cardInitiative !== null && (
            <DoneStep
              players={players}
              userSeatIdx={userSeatIdx}
              cardInitiative={cardInitiative}
            />
          )}
        </Stack>
      </Container>
    </MainAppShell>
  );
}
