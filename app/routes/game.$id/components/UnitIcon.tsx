import { UNIT_NAMES } from "~/game/data";
import { UnitType } from "~/game/types";

/**
 * Top-down silhouettes on a 24×24 grid, ships pointing up. Filled with the
 * owner's color and outlined dark so they read on any tile art.
 */
const SHAPES: Record<UnitType, string> = {
  warsun:
    "M12 2.5a9.5 9.5 0 1 1 0 19a9.5 9.5 0 1 1 0-19z M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z M2.5 12h4 M17.5 12h4 M12 2.5v4 M12 17.5v4",
  flagship:
    "M12 1.5l3 5.5v4l7 4v3l-7-1.5v3.5l2.5 2v1.5h-11V22l2.5-2v-3.5L2 18v-3l7-4V7z",
  dreadnought: "M12 2l3.5 5v4.5l2.5 1.5v5l-2.5 1v3H8.5v-3L6 18v-5l2.5-1.5V7z",
  carrier: "M8 3h8l2 3v15l-2 1.5H8L6 21V6z M9 7.5h6 M9 11h6 M9 14.5h6",
  cruiser: "M12 2.5l2.5 6v3.5l4.5 3.5v2.5l-4.5-1v3.5h-5V17L5 18v-2.5L9.5 12V8.5z",
  destroyer: "M12 4l2.5 6v6.5l2 2.5v1.5h-9V19l2-2.5V10z",
  fighter: "M12 5l7 12.5l-3.5-1.5L12 19l-3.5-3L5 17.5z",
  mech: "M9.5 3h5v3.5h3L19 13h-2.5l-1-3v4.5l1.5 7.5h-3L12 16l-2 6H7l1.5-7.5V10l-1 3H5l1.5-6.5h3z",
  infantry:
    "M12 3a3 3 0 1 1 0 6a3 3 0 1 1 0-6z M6 21v-6.5C6 11.5 8.5 10 12 10s6 1.5 6 4.5V21z",
  spacedock:
    "M10 2h4v3.2a7 7 0 0 1 3.6 2.1l2.8-1.6l2 3.5l-2.8 1.6a7 7 0 0 1 0 4.4l2.8 1.6l-2 3.5l-2.8-1.6a7 7 0 0 1-3.6 2.1V22h-4v-3.2a7 7 0 0 1-3.6-2.1l-2.8 1.6l-2-3.5l2.8-1.6a7 7 0 0 1 0-4.4L1.6 9.2l2-3.5l2.8 1.6A7 7 0 0 1 10 5.2z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z",
  pds: "M10.5 2h3v8h-3z M4 21v-3a8 6 0 0 1 16 0v3z M7 11h10v4H7z",
};

export function UnitIcon({
  type,
  color,
  size = 12,
}: {
  type: UnitType;
  color: string;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={UNIT_NAMES[type]}
      style={{ flexShrink: 0, overflow: "visible" }}
    >
      <path
        d={SHAPES[type]}
        fill={color}
        fillRule="evenodd"
        stroke="#0b0d17"
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
