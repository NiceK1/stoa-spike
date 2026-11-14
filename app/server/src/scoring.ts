/** The dataset's scoring rules: counts exact; areas, lengths and volumes within 2%; text is not auto-scored. */
const RELATIVE_TOLERANCE = 0.02;

export function isCorrect(type: string, expected: number | string, value: number | string | null): boolean | null {
  if (type === "count") return typeof value === "number" && Math.round(value) === Math.round(Number(expected));
  if (type === "area" || type === "length" || type === "volume") {
    if (typeof value !== "number") return false;
    return Math.abs(value - Number(expected)) <= RELATIVE_TOLERANCE * Math.abs(Number(expected));
  }
  return null;
}
