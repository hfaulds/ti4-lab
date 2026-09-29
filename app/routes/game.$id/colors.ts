/** Plastic colors, tuned to stay legible on the dark board. */
const PLAYER_COLORS: Record<string, string> = {
  blue: "#4c8dff",
  red: "#ff5252",
  green: "#3ecf6e",
  yellow: "#f5d020",
  purple: "#b070ff",
  orange: "#ff9838",
  black: "#9aa0a6",
  magenta: "#ff5cc8",
};

export const playerColor = (color: string) =>
  PLAYER_COLORS[color.toLowerCase()] ?? "#9aa0a6";

const DARK_TEXT = ["yellow", "green", "orange", "black", "magenta"];
export const playerTextColor = (color: string) =>
  DARK_TEXT.includes(color.toLowerCase()) ? "#111" : "#fff";
