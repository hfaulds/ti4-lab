import {
  ActionIcon,
  Badge,
  Blockquote,
  Button,
  Group,
  Paper,
  ScrollArea,
  SegmentedControl,
  Slider,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  IconChevronLeft,
  IconChevronLeftPipe,
  IconChevronRight,
  IconChevronRightPipe,
  IconChevronsLeft,
  IconChevronsRight,
  IconHistory,
  IconMessageChatbot,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconX,
} from "@tabler/icons-react";
import { ReactNode, useEffect, useRef, useState } from "react";
import { HistoryStep, MoveNote } from "~/game/history";
import { GameView } from "~/game/view";
import { storeHistoryOpen, useGame } from "../gameStore";
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

/** What a player did with their turn, from the move that began it. */
const TURN_KINDS: Partial<Record<string, string>> = {
  ACTIVATE_SYSTEM: "Tactical action",
  STRATEGIC_ACTION: "Strategic action",
  COMPONENT_ACTION: "Component action",
  PLAY_ACTION_CARD: "Component action",
  USE_ABILITY: "Component action",
  PASS: "Passed",
  PICK_STRATEGY_CARD: "Picked a strategy card",
};

/** A heading for the action a group of moves resolved. */
function sectionTitle(section: HistoryStep[], when: HistoryStep) {
  const first = section[0];
  if (first.player === undefined) return "Start of the game";
  for (const step of section) {
    const kind = step.player === step.turn && TURN_KINDS[step.action ?? ""];
    if (kind) return kind;
  }
  return first.turn !== undefined
    ? actionName(first.action ?? "")
    : `${PHASE_NAMES[when.phase]} phase`;
}

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
  const urlName = useGame((state) => state.urlName);
  const { openHistory, closeHistory, viewVersion } = useGame.getState();
  const open = () => {
    storeHistoryOpen(urlName, true);
    void openHistory();
  };
  const close = () => {
    storeHistoryOpen(urlName, false);
    closeHistory();
  };
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
  const previousSection = () => {
    if (!steps) return;
    const start = steps.findIndex((s) => s.section === steps[index].section);
    if (start < index) return goTo(start);
    const before = steps[Math.max(0, start - 1)].section;
    goTo(steps.findIndex((s) => s.section === before));
  };
  const nextSection = () => {
    if (!steps) return;
    const next = steps.findIndex(
      (s, i) => i > index && s.section !== steps[index].section,
    );
    goTo(next === -1 ? steps.length - 1 : next);
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
          onClick={open}
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
          <CloseButton onClick={close} />
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
            <Control label="Previous action" onClick={previousSection}>
              <IconChevronLeftPipe size={18} />
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
            <Control label="Next action" onClick={nextSection}>
              <IconChevronRightPipe size={18} />
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
                close();
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

        <Section
          view={view}
          steps={steps.filter((s) => s.section === step.section)}
          before={steps[steps.findIndex((s) => s.section === step.section) - 1]}
          current={step}
          onSelect={(target) => goTo(steps.indexOf(target))}
        />
      </Stack>
    </Paper>
  );
}

/**
 * Every move of the action the step on screen belongs to, so the moves other
 * players made while resolving it, such as strategy card secondaries, read
 * as part of it. Moves still to come are faded.
 */
function Section({
  view,
  steps,
  before,
  current,
  onSelect,
}: {
  view: GameView;
  steps: HistoryStep[];
  /** The point just before the action began, which says when it was taken. */
  before?: HistoryStep;
  current: HistoryStep;
  onSelect: (step: HistoryStep) => void;
}) {
  const first = steps[0];
  const when = before ?? first;
  const viewport = useRef<HTMLDivElement>(null);
  const selectedRow = useRef<HTMLDivElement>(null);

  // Keep the move on screen in view within the list, without scrolling the page.
  useEffect(() => {
    const list = viewport.current;
    const row = selectedRow.current;
    if (!list || !row) return;
    const top =
      row.getBoundingClientRect().top -
      list.getBoundingClientRect().top +
      list.scrollTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = top + row.offsetHeight - list.clientHeight;
    }
  }, [current.version]);

  return (
    <Stack gap={6} mt="xs">
      <Group gap="xs" wrap="wrap">
        <Badge variant="light">
          Round {when.round} · {PHASE_NAMES[when.phase]}
        </Badge>
        {first.turn !== undefined && (
          <PlayerName view={view} player={first.turn} />
        )}
        <Text size="sm" fw={600}>
          {sectionTitle(steps, when)}
        </Text>
        {steps.length > 1 && (
          <Text size="xs" c="dimmed">
            {steps.length} moves
          </Text>
        )}
      </Group>
      <ScrollArea.Autosize mah={360} type="auto" viewportRef={viewport}>
        <Stack gap={2}>
          {steps.map((step) => {
            const selected = step.version === current.version;
            const aside =
              step.turn !== undefined &&
              step.player !== undefined &&
              step.player !== step.turn;
            return (
              <Stack
                key={step.version}
                ref={selected ? selectedRow : undefined}
                gap={2}
                ml={aside ? "lg" : 0}
                pl="xs"
                py={2}
                opacity={step.version > current.version ? 0.5 : 1}
                style={{
                  borderLeft: `3px solid ${
                    selected
                      ? "var(--mantine-primary-color-filled)"
                      : "var(--mantine-color-default-border)"
                  }`,
                  background: selected
                    ? "var(--mantine-primary-color-light)"
                    : undefined,
                }}
              >
                <UnstyledButton onClick={() => onSelect(step)}>
                  <Group gap="xs" wrap="nowrap">
                    {step.player !== undefined ? (
                      <>
                        <PlayerName view={view} player={step.player} />
                        <Text size="sm" fw={selected ? 600 : undefined}>
                          {actionName(step.action ?? "")}
                        </Text>
                      </>
                    ) : (
                      <Text size="sm" fw={selected ? 600 : undefined}>
                        Start of the game
                      </Text>
                    )}
                    {!selected && step.events[0] && (
                      <Text size="xs" c="dimmed" truncate>
                        {step.events[0]}
                      </Text>
                    )}
                    {!selected && step.note && (
                      <IconMessageChatbot size={14} color="gray" />
                    )}
                  </Group>
                </UnstyledButton>
                {selected && step.events.length > 0 && (
                  <Stack gap={0}>
                    {step.events.map((event, i) => (
                      <Text key={i} size="sm">
                        {event}
                      </Text>
                    ))}
                  </Stack>
                )}
                {selected && step.note && <Reasoning note={step.note} />}
              </Stack>
            );
          })}
        </Stack>
      </ScrollArea.Autosize>
    </Stack>
  );
}

/** Why the player chose the move, as they explained it. */
export function Reasoning({ note }: { note: MoveNote }) {
  const [showOptions, setShowOptions] = useState(false);
  return (
    <Blockquote p="sm" mt={4} color="violet">
      <Stack gap={6}>
        {note.chosen && (
          <Text size="sm" fw={600}>
            {note.forced ? "No choice: " : "Chose "}
            {note.chosen}
          </Text>
        )}
        {note.talk && note.talk.length > 0 && (
          <Stack gap={2}>
            <Text size="xs" c="dimmed" fw={600}>
              Table talk
            </Text>
            {note.talk.map((line, i) => (
              <Text key={i} size="xs">
                {line}
              </Text>
            ))}
          </Stack>
        )}
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
        {note.citations && note.citations.length > 0 && (
          <Stack gap={2}>
            <Text size="xs" c="dimmed" fw={600}>
              Guides cited
            </Text>
            {note.citations.map((citation) => (
              <Text key={citation} size="xs" c="dimmed">
                {citation}
              </Text>
            ))}
          </Stack>
        )}
        {note.options.length > 0 && (
          <Group>
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => setShowOptions(!showOptions)}
            >
              {showOptions ? "Hide" : "Show"} the {note.options.length} options
            </Button>
          </Group>
        )}
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
