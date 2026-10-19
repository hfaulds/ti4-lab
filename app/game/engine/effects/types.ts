import { PlayerId } from "~/types";
import {
  EffectTargets,
  GameState,
  WindowContext,
  WindowId,
} from "../../types";

export type TargetKind = keyof EffectTargets;

/**
 * The rules for one action card, faction ability, technology, unit ability,
 * law or promissory note that a player chooses to use.
 */
export type Effect = {
  /** Windows in which it can be used. */
  windows?: WindowId[];
  /** Usable as a component action ("ACTION:") on the owner's turn. */
  action?: boolean;
  /** Choices it needs, for the interface and for agents. */
  targets?: TargetKind[];
  /** Whether it can be used right now, beyond being held or owned. */
  usable?: (state: GameState, id: PlayerId, context: WindowContext) => boolean;
  /**
   * Checks the choices and pays any cost when it is played. Throws a
   * GameError for an illegal choice. Costs stay paid if it is cancelled.
   */
  play?: (
    state: GameState,
    id: PlayerId,
    targets: EffectTargets,
    context: WindowContext,
  ) => void;
  /** Carries the effect out once nobody has cancelled it. */
  resolve: (
    state: GameState,
    id: PlayerId,
    targets: EffectTargets,
    context: WindowContext,
  ) => void;
};

export type EffectTable = Record<string, Effect>;
