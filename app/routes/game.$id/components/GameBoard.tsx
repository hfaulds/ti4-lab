import { Box, Text } from "@mantine/core";
import { Hex } from "~/components/Hex";
import { RawSystemTile } from "~/components/tiles/SystemTile";
import { systemData } from "~/data/systemData";
import { UNIT_NAMES } from "~/game/data";
import { MALLICE, WORMHOLE_NEXUS_ID, wormholesOf } from "~/game/engine/board";
import { Forces, SystemState } from "~/game/types";
import { GameView } from "~/game/view";
import { useDimensions } from "~/hooks/useDimensions";
import { SystemTile } from "~/types";
import { getHexPosition } from "~/utils/positioning";
import { playerColor, playerTextColor } from "../colors";
import { useGame } from "../gameStore";
import { sortedUnitTypes, UNIT_SHORT } from "./shared";

import classes from "./GameBoard.module.css";

const OFF_BOARD_NAMES: Record<string, string> = {
  "82": "Wormhole Nexus",
  "51": "Creuss",
};

const hasUnits = (forces: Forces) =>
  Object.values(forces).some((group) => sortedUnitTypes(group).length > 0);

/**
 * The Wormhole Nexus only matters once something can reach it: a gamma
 * wormhole elsewhere, the nexus turned to its active side, or anything
 * already there.
 */
function inPlay(view: GameView, system: SystemState) {
  if (system.systemId !== WORMHOLE_NEXUS_ID) return true;
  if (system.inactiveWormholes.length === 0) return true;
  if (system.commandTokens.length > 0 || hasUnits(system.space)) return true;
  const mallice = view.planets[MALLICE];
  if (
    mallice &&
    (mallice.controller !== undefined || hasUnits(mallice.units))
  ) {
    return true;
  }
  return Object.values(view.systems).some(
    (other) => other.key !== system.key && wormholesOf(other).includes("GAMMA"),
  );
}

type Point = { x: number; y: number };

/**
 * The largest radius at which every tile, drawn in a box twice its radius
 * wide and tall, stays inside the board.
 */
function fitRadius(cells: Point[], width: number, height: number, gap: number) {
  let radius = Infinity;
  for (const { x: col, y: row } of cells) {
    const across = Math.abs(col);
    const down = Math.abs(row + col / 2);
    radius = Math.min(
      radius,
      (width / 2 - gap * across) / (1.5 * across + 1),
      (height / 2 - gap * down) / (Math.sqrt(3) * down + 1),
    );
  }
  return Math.max(0, radius);
}

/**
 * Spots in the board's corners far enough from every tile, and from each
 * other, that an off-board system drawn there cannot overlap anything.
 */
function cornerSpots(
  centers: Point[],
  count: number,
  radius: number,
  width: number,
  height: number,
) {
  // Some tile art, like Mallice's planet, pokes out past the hex, so keep
  // clear of the top and bottom edges.
  const inset = { x: width / 2 - radius, y: height / 2 - radius * 1.3 };
  const corners = [
    { x: -inset.x, y: -inset.y },
    { x: inset.x, y: -inset.y },
    { x: -inset.x, y: inset.y },
    { x: inset.x, y: inset.y },
  ];
  const clear = 2 * radius;
  const taken: Point[] = [];
  for (const corner of corners) {
    if (taken.length === count) break;
    const free = [...centers, ...taken].every(
      (c) => Math.hypot(c.x - corner.x, c.y - corner.y) >= clear,
    );
    if (free) taken.push(corner);
  }
  return taken.length === count ? taken : undefined;
}

function Units({ view, forces }: { view: GameView; forces: Forces }) {
  const owners = Object.keys(forces)
    .map(Number)
    .filter((id) => sortedUnitTypes(forces[id]).length > 0);
  if (owners.length === 0) return null;
  return (
    <>
      {owners.map((id) => {
        const color = view.players[id]?.color ?? "black";
        const group = forces[id];
        return (
          <span
            key={id}
            className={classes.units}
            style={{
              background: playerColor(color),
              color: playerTextColor(color),
            }}
            title={sortedUnitTypes(group)
              .map((type) => `${group[type]!.count} ${UNIT_NAMES[type]}`)
              .join(", ")}
          >
            {sortedUnitTypes(group)
              .map((type) => `${group[type]!.count}${UNIT_SHORT[type]}`)
              .join(" ")}
          </span>
        );
      })}
    </>
  );
}

function SystemOverlay({
  view,
  system,
}: {
  view: GameView;
  system: SystemState;
}) {
  return (
    <div className={classes.overlay}>
      <div className={classes.top}>
        <div className={classes.tokens}>
          {system.commandTokens.map((id) => (
            <span
              key={id}
              className={classes.token}
              style={{ borderBottomColor: playerColor(view.players[id].color) }}
              title={`${view.players[id].name} command token`}
            />
          ))}
          {system.frontier && (
            <span className={classes.frontier} title="Frontier token">
              F
            </span>
          )}
        </div>
        <Units view={view} forces={system.space} />
      </div>
      <div className={classes.bottom}>
        {system.planets.map((name) => {
          const planet = view.planets[name];
          const controller =
            planet.controller !== undefined
              ? view.players[planet.controller]
              : undefined;
          const custodians = name === "Mecatol Rex" && view.custodians;
          return (
            <div key={name} className={classes.planet}>
              <span
                className={classes.control}
                style={{
                  background: controller
                    ? playerColor(controller.color)
                    : "transparent",
                  opacity: planet.exhausted ? 0.45 : 1,
                }}
                title={
                  controller
                    ? `${name}: ${controller.name}${planet.exhausted ? " (exhausted)" : ""}`
                    : `${name}: uncontrolled`
                }
              />
              {custodians && (
                <span className={classes.frontier} title="Custodians token">
                  C
                </span>
              )}
              <Units view={view} forces={planet.units} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Tile({
  view,
  system,
  tile,
  radius,
}: {
  view: GameView;
  system: SystemState;
  tile: SystemTile;
  radius: number;
}) {
  const selected = useGame((state) => state.selectedSystem === system.key);
  const selectSystem = useGame((state) => state.selectSystem);
  const active = view.tactical?.system === system.key;
  const known = !!systemData[tile.systemId];

  return (
    <div
      className={[
        classes.tile,
        selected ? classes.selected : "",
        active ? classes.active : "",
      ].join(" ")}
      role="button"
      tabIndex={0}
      aria-label={
        system.planets.length > 0
          ? system.planets.join(" / ")
          : `System ${system.systemId}`
      }
      onClick={() => selectSystem(system.key)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectSystem(system.key);
        }
      }}
    >
      {known ? (
        <RawSystemTile
          mapId="game"
          tile={tile}
          radius={radius}
          disablePopover
        />
      ) : (
        <Hex id={`game-${tile.systemId}`} radius={radius} color="#1b1f3a">
          <Text size="xs" c="dimmed">
            Creuss Gate
          </Text>
        </Hex>
      )}
      <SystemOverlay view={view} system={system} />
    </div>
  );
}

export function GameBoard({ view }: { view: GameView }) {
  const { ref, width, height } = useDimensions<HTMLDivElement>();
  const gap = Math.min(width, height) * 0.006;
  const tiles = view.map.flatMap((tile, idx) =>
    tile.type === "SYSTEM" ? [{ tile, idx }] : [],
  );
  const radius = fitRadius(
    tiles.map(({ tile }) => tile.position),
    width,
    height,
    gap,
  );
  const centers = tiles.map(({ tile }) =>
    getHexPosition(tile.position.x, tile.position.y, radius, gap),
  );
  const offBoard = Object.values(view.systems).filter(
    (s) => !s.onBoard && inPlay(view, s),
  );
  const corners =
    offBoard.length > 0
      ? cornerSpots(centers, offBoard.length, radius, width, height)
      : undefined;

  const offBoardTile = (system: SystemState) => (
    <Tile
      view={view}
      system={system}
      tile={{
        idx: system.key,
        position: { x: 0, y: 0 },
        type: "SYSTEM",
        systemId: system.systemId,
      }}
      radius={radius}
    />
  );
  const offBoardName = (system: SystemState) =>
    OFF_BOARD_NAMES[system.systemId] ?? "Off the board";

  return (
    <Box>
      <div ref={ref} className={classes.board}>
        {radius > 0 &&
          tiles.map(({ tile, idx }, i) => {
            const { x, y } = centers[i];
            const system = view.systems[idx];
            return (
              <div
                key={idx}
                className={classes.position}
                style={{
                  left: x - radius + width * 0.5,
                  top: y - radius + height * 0.5,
                }}
              >
                {system ? (
                  <Tile
                    view={view}
                    system={system}
                    tile={tile}
                    radius={radius}
                  />
                ) : (
                  // Hyperlanes are scenery: nothing can be placed on them.
                  <RawSystemTile mapId="game" tile={tile} radius={radius} />
                )}
              </div>
            );
          })}
        {radius > 0 &&
          corners &&
          offBoard.map((system, i) => (
            <div
              key={system.key}
              className={classes.position}
              title={offBoardName(system)}
              style={{
                left: corners[i].x - radius + width * 0.5,
                top: corners[i].y - radius + height * 0.5,
              }}
            >
              {offBoardTile(system)}
            </div>
          ))}
      </div>
      {radius > 0 && !corners && offBoard.length > 0 && (
        <div className={classes.offBoard}>
          {offBoard.map((system) => (
            <div key={system.key} className={classes.offBoardTile}>
              {offBoardTile(system)}
              <Text size="xs" c="dimmed" ta="center">
                {offBoardName(system)}
              </Text>
            </div>
          ))}
        </div>
      )}
    </Box>
  );
}
