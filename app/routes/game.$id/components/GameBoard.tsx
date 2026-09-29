import { Box, Text } from "@mantine/core";
import { Hex } from "~/components/Hex";
import { RawSystemTile } from "~/components/tiles/SystemTile";
import { systemData } from "~/data/systemData";
import { UNIT_NAMES } from "~/game/data";
import { Forces, SystemState } from "~/game/types";
import { GameView } from "~/game/view";
import { useDimensions } from "~/hooks/useDimensions";
import { SystemTile } from "~/types";
import {
  calculateConcentricCircles,
  calculateMaxHexRadius,
  getHexPosition,
} from "~/utils/positioning";
import { playerColor, playerTextColor } from "../colors";
import { useGame } from "../gameStore";
import { sortedUnitTypes, UNIT_SHORT } from "./shared";

import classes from "./GameBoard.module.css";

const OFF_BOARD_NAMES: Record<string, string> = {
  "82": "Wormhole Nexus",
  "51": "Creuss",
};

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
  const rings = calculateConcentricCircles(view.map.length);
  const gap = Math.min(width, height) * 0.006;
  const radius = calculateMaxHexRadius(rings, width, height, gap);
  const offBoard = Object.values(view.systems).filter((s) => !s.onBoard);

  return (
    <Box>
      <div ref={ref} className={classes.board}>
        {radius > 0 &&
          view.map.map((tile, idx) => {
            if (tile.type !== "SYSTEM") return null;
            const { x, y } = getHexPosition(
              tile.position.x,
              tile.position.y,
              radius,
              gap,
            );
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
      </div>
      {offBoard.length > 0 && radius > 0 && (
        <div className={classes.offBoard}>
          {offBoard.map((system) => (
            <div key={system.key} className={classes.offBoardTile}>
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
              <Text size="xs" c="dimmed" ta="center">
                {OFF_BOARD_NAMES[system.systemId] ?? "Off the board"}
              </Text>
            </div>
          ))}
        </div>
      )}
    </Box>
  );
}
