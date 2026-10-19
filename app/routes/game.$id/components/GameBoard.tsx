import { Box, Text } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { Hex } from "~/components/Hex";
import { RawSystemTile } from "~/components/tiles/SystemTile";
import { systemData } from "~/data/systemData";
import { UNIT_NAMES } from "~/game/data";
import { MALLICE, WORMHOLE_NEXUS_ID, wormholesOf } from "~/game/engine/board";
import { openPrompts } from "~/game/engine/helpers";
import { Forces, SystemState } from "~/game/types";
import { asState, GameView } from "~/game/view";
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
 * The size of a box that holds every tile with a tile's width spare on
 * either side, for a board the given width.
 */
function wideBoardSize(cells: Point[], width: number) {
  let across = 0;
  let down = 0;
  for (const { x: col, y: row } of cells) {
    across = Math.max(across, Math.abs(col));
    down = Math.max(down, Math.abs(row + col / 2));
  }
  // Tiles are drawn in boxes twice their radius wide; the map spans
  // 3 * across + 2 radii, and the margins add two tiles more.
  const radius = width / (3 * across + 6);
  return {
    width: radius * (3 * across + 2),
    height: radius * (2 * Math.sqrt(3) * down + 2),
  };
}

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
  // Points the player at the home system their starting units go in.
  const placing = useGame(
    (state) =>
      state.player !== undefined &&
      view.players[state.player]?.home === system.key &&
      openPrompts(asState(view)).some(
        (p) => p.kind === "placeStartingUnits" && p.player === state.player,
      ),
  );

  return (
    <div
      className={[
        classes.tile,
        selected ? classes.selected : "",
        active ? classes.active : "",
        placing ? classes.placing : "",
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

/** How tall an element can be without running past the bottom of the window. */
function useHeightToWindowBottom(ref: React.RefObject<HTMLElement>) {
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    const measure = () => {
      const element = ref.current;
      if (!element) return;
      const top = element.getBoundingClientRect().top + window.scrollY;
      setHeight(Math.max(240, window.innerHeight - top - 16));
    };
    measure();
    // Banners above the board, like the disconnection alert, move it down.
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref]);
  return height;
}

/**
 * A wide board fills its width at the map's own shape, leaving a tile's
 * width either side, and the page scrolls to show the rest; otherwise it
 * fits in the window.
 */
export function GameBoard({
  view,
  wide,
  baseWidth,
}: {
  view: GameView;
  wide?: boolean;
  baseWidth: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const fitHeight = useHeightToWindowBottom(ref);
  const tiles = view.map.flatMap((tile, idx) =>
    tile.type === "SYSTEM" ? [{ tile, idx }] : [],
  );
  const { width, height } = wide
    ? wideBoardSize(
        tiles.map(({ tile }) => tile.position),
        baseWidth,
      )
    : { width: baseWidth, height: Math.min(baseWidth, fitHeight ?? baseWidth) };
  const gap = Math.min(width, height) * 0.006;
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
    <Box w={baseWidth}>
      <div ref={ref} className={classes.board} style={{ width, height }}>
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
