import {
  ActionIcon,
  Badge,
  Blockquote,
  Button,
  Group,
  Paper,
  SegmentedControl,
  Slider,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
  IconHistory,
  IconMessageChatbot,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconX,
} from "@tabler/icons-react";
import { ReactNode, useEffect, useState } from "react";
import { HistoryStep, MoveNote } from "~/game/history";
import { GameView } from "~/game/view";
import { useGame } from "../gameStore";
import { PlayerName } from "./shared";

const PHASE_NAMES = {
  setup: "Setup",
  strategy: "Strategy",
  action: "Action",
  status: "Status",
  agenda: "Agenda",
  finished: "Game over",
};

/** Milliseconds between moves when playing history back. */
const SPEEDS = { "1×": 1200, "4×": 300, "16×": 75 };
type Speed = keyof typeof SPEEDS;

/** "SCORE_OBJECTIVE" reads as "Score objective". */
const actionName = (type: string) =>
  type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, " ");

const samePhase = (a: HistoryStep, b: HistoryStep) =>
  a.round === b.round && a.phase === b.phase;

/** Where the phase containing `index` begins. */
function phaseStart(steps: HistoryStep[], index: number) {
  let start = index;
  while (start > 0 && samePhase(steps[start - 1], steps[index])) start--;
  return start;
}

/**
 * Steps back through every move of the game. While an earlier point is on
 * screen the rest of the page shows the game as it stood then.
 */
export function HistoryBar({ view }: { view: GameView }) {
  const steps = useGame((state) => state.steps);
  const viewing = useGame((state) => state.viewing);
  const { openHistory, closeHistory, viewVersion } = useGame.getState();
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>("4×");

  const index = steps
    ? viewing === undefined
      ? steps.length - 1
      : steps.findIndex((step) => step.version === viewing)
    : -1;
  const atEnd = !steps || index >= steps.length - 1;
  const goTo = (target: number) => {
    if (!steps || steps.length === 0) return;
    const clamped = Math.max(0, Math.min(steps.length - 1, target));
    void viewVersion(
      clamped === steps.length - 1 ? undefined : steps[clamped].version,
    );
  };

  const previousPhase = () => {
    if (!steps) return;
    const start = phaseStart(steps, index);
    goTo(start < index ? start : phaseStart(steps, Math.max(0, start - 1)));
  };
  /** The nearest move either side with reasoning the viewer may read. */
  const reasoned = (direction: 1 | -1) => {
    if (!steps) return;
    for (
      let i = index + direction;
      i >= 0 && i < steps.length;
      i += direction
    ) {
      if (steps[i].note) return goTo(i);
    }
  };
  const nextPhase = () => {
    if (!steps) return;
    let next = index;
    while (next < steps.length - 1 && samePhase(steps[next], steps[index])) {
      next++;
    }
    goTo(next);
  };

  useEffect(() => {
    if (!playing) return;
    if (atEnd) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => goTo(index + 1), SPEEDS[speed]);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, index, speed, atEnd]);

  // Arrow keys step through moves; with shift, through phases.
  useEffect(() => {
    if (!steps) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [role=slider]")) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (event.shiftKey) previousPhase();
        else goTo(index - 1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        if (event.shiftKey) nextPhase();
        else goTo(index + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!steps) {
    return (
      <Group>
        <Button
          size="compact-sm"
          variant="default"
          leftSection={<IconHistory size={16} />}
          onClick={() => void openHistory()}
        >
          History
        </Button>
      </Group>
    );
  }

  if (steps.length === 0) {
    return (
      <Paper withBorder p="sm">
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            This game was saved before moves were recorded, so its history
            cannot be shown.
          </Text>
          <CloseButton onClick={closeHistory} />
        </Group>
      </Paper>
    );
  }

  const step = steps[index] ?? steps[steps.length - 1];
  const rounds = [...new Set(steps.map((s) => s.round))];
  const anyReasoning = steps.some((s) => s.note);

  return (
    <Paper withBorder p="sm">
      <Stack gap="xs">
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Group gap={4} wrap="nowrap">
            <Control label="Previous phase (shift ←)" onClick={previousPhase}>
              <IconChevronsLeft size={18} />
            </Control>
            <Control label="Previous move (←)" onClick={() => goTo(index - 1)}>
              <IconChevronLeft size={18} />
            </Control>
            <Control
              label={playing ? "Pause" : "Play"}
              onClick={() => {
                if (!playing && atEnd) goTo(0);
                setPlaying(!playing);
              }}
            >
              {playing ? (
                <IconPlayerPauseFilled size={16} />
              ) : (
                <IconPlayerPlayFilled size={16} />
              )}
            </Control>
            <Control label="Next move (→)" onClick={() => goTo(index + 1)}>
              <IconChevronRight size={18} />
            </Control>
            <Control label="Next phase (shift →)" onClick={nextPhase}>
              <IconChevronsRight size={18} />
            </Control>
            {anyReasoning && (
              <>
                <Control
                  label="Previous move with reasoning"
                  onClick={() => reasoned(-1)}
                >
                  <IconChevronLeft size={12} />
                  <IconMessageChatbot size={16} />
                </Control>
                <Control
                  label="Next move with reasoning"
                  onClick={() => reasoned(1)}
                >
                  <IconMessageChatbot size={16} />
                  <IconChevronRight size={12} />
                </Control>
              </>
            )}
            <SegmentedControl
              size="xs"
              ml="xs"
              data={Object.keys(SPEEDS)}
              value={speed}
              onChange={(value) => setSpeed(value as Speed)}
            />
          </Group>
          <Group gap="xs">
            <Text size="sm" c="dimmed">
              Move {index} of {steps.length - 1}
            </Text>
            {viewing !== undefined && (
              <Button
                size="compact-sm"
                onClick={() => {
                  setPlaying(false);
                  void viewVersion(undefined);
                }}
              >
                Back to now
              </Button>
            )}
            <CloseButton
              onClick={() => {
                setPlaying(false);
                closeHistory();
              }}
            />
          </Group>
        </Group>

        <Slider
          min={0}
          max={steps.length - 1}
          value={index}
          onChange={goTo}
          label={(value) => {
            const at = steps[value];
            return at ? `Round ${at.round} · ${PHASE_NAMES[at.phase]}` : "";
          }}
          marks={rounds.map((round) => ({
            value: steps.findIndex((s) => s.round === round),
            label: `R${round}`,
          }))}
          mb="md"
        />

        <Group gap="xs" wrap="wrap" mt="xs">
          <Badge variant="light">
            Round {step.round} · {PHASE_NAMES[step.phase]}
          </Badge>
          {step.player !== undefined ? (
            <>
              <PlayerName view={view} player={step.player} />
              <Text size="sm" fw={600}>
                {actionName(step.action ?? "")}
              </Text>
            </>
          ) : (
            <Text size="sm" fw={600}>
              Start of the game
            </Text>
          )}
        </Group>
        {step.events.length > 0 && (
          <Stack gap={0}>
            {step.events.map((event, i) => (
              <Text key={i} size="sm">
                {event}
              </Text>
            ))}
          </Stack>
        )}
        {step.note && <Reasoning note={step.note} />}
      </Stack>
    </Paper>
  );
}

/** Why the player chose the move, as they explained it. */
export function Reasoning({ note }: { note: MoveNote }) {
  const [showOptions, setShowOptions] = useState(false);
  return (
    <Blockquote p="sm" mt={4} color="violet">
      <Stack gap={6}>
        <Text size="sm" fw={600}>
          Chose {note.chosen}
        </Text>
        {note.fallback && (
          <Text size="sm" c="orange">
            The agent&apos;s own choice failed ({note.fallback}), so the
            bot&apos;s top option was played.
          </Text>
        )}
        {note.rationale && (
          <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
            {note.rationale}
          </Text>
        )}
        {note.plan && (
          <Text size="sm" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
            Plan: {note.plan}
          </Text>
        )}
        <Group>
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={() => setShowOptions(!showOptions)}
          >
            {showOptions ? "Hide" : "Show"} the {note.options.length} options
          </Button>
        </Group>
        {showOptions && (
          <Stack gap={2}>
            {note.options.map((option) => (
              <Text
                key={option}
                size="xs"
                fw={option === note.chosen ? 700 : undefined}
                c={option === note.chosen ? undefined : "dimmed"}
              >
                {option}
              </Text>
            ))}
          </Stack>
        )}
      </Stack>
    </Blockquote>
  );
}

function Control({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip label={label}>
      <ActionIcon
        variant="default"
        aria-label={label}
        onClick={onClick}
        w="auto"
        miw={28}
        px={4}
      >
        {children}
      </ActionIcon>
    </Tooltip>
  );
}

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip label="Close history">
      <ActionIcon variant="subtle" aria-label="Close history" onClick={onClick}>
        <IconX size={16} />
      </ActionIcon>
    </Tooltip>
  );
}
