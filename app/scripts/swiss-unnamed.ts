// Which number-only rooms does the ground truth leave out of the "numbered indoor rooms" total?
//   STOA_DATASET=../dataset-full npx tsx scripts/swiss-unnamed.ts
// For every drawing the rooms to drop are found by subset sum against the expected total, then compared by feature.
import { join } from "node:path";
import { datasetRoot } from "../server/src/config.js";
import { questionsByPath } from "../server/src/dataset.js";
import { contains, mid, polygonArea } from "../server/src/geometry.js";
import { loadPlan, type Room } from "../server/src/solvers/dxf.js";
import type { Point, Polygon } from "../server/src/types.js";

function distanceToBoundary(polygon: Polygon, [px, py]: Point): number {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i], [x2, y2] = polygon[(i + 1) % polygon.length];
    const dx = x2 - x1, dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)));
  }
  return best;
}

/** Indexes of items whose areas (in hundredths) add up to the target within the tolerance, or null. */
function subset(areas: number[], target: number, tolerance = 4): number[] | null {
  const reach = new Map<number, number[]>([[0, []]]);
  for (let i = 0; i < areas.length; i++) {
    for (const [sum, picked] of [...reach]) {
      const next = sum + areas[i];
      if (next <= target + tolerance && !reach.has(next)) reach.set(next, [...picked, i]);
    }
  }
  for (let d = 0; d <= tolerance; d++) for (const s of [target - d, target + d]) if (reach.has(s)) return reach.get(s)!;
  return null;
}

interface Sample { excluded: boolean; area: number; fixtures: number; doors: number; windows: number; inUnit: boolean; vertices: number; hasHoles: boolean }
const samples: Sample[] = [];
let drawings = 0, exact = 0, explained = 0, missing = 0, unexplained = 0;

for (const [path, rows] of questionsByPath()) {
  if (!path.includes("/swiss_dwellings/")) continue;
  const row = rows.find((r) => r.question.includes("numbered indoor rooms"));
  if (!row) continue;
  drawings++;
  const plan = await loadPlan(join(datasetRoot(), path.replace(/\.pdf$/, ".dxf")));
  const numbered = plan.rooms.filter((r) => r.number && r.area !== null && !["balkon", "balcon", "balcone", "loggia", "terrasse", "terrazza"].includes((r.name ?? "").toLowerCase()));
  const unnamed = numbered.filter((r) => r.name === null && r.polygon);
  const got = numbered.reduce((s, r) => s + r.area!, 0);
  const excess = Math.round((got - Number(row.answer)) * 100);

  let dropped: number[] = [];
  if (Math.abs(excess) <= 4) exact++;
  else if (excess < 0) { missing++; continue; }
  else {
    const found = subset(unnamed.map((r) => Math.round(r.area! * 100)), excess);
    if (!found) { unexplained++; continue; }
    explained++;
    dropped = found;
  }
  const fixtures = [...plan.toilets, ...plan.washbasins, ...plan.bathtubs, ...plan.showers].map(mid);
  unnamed.forEach((room: Room, i) => {
    const polygon = room.polygon!;
    samples.push({
      excluded: dropped.includes(i), area: room.area!, vertices: polygon.length,
      fixtures: fixtures.filter((f) => contains(polygon, f)).length,
      doors: plan.doors.filter((d) => distanceToBoundary(polygon, mid(d)) < 0.25).length,
      windows: plan.windows.filter((w) => distanceToBoundary(polygon, mid(w)) < 0.35).length,
      inUnit: plan.unitOutlines.some((o) => contains(o, room.point)),
      hasHoles: plan.roomOutlines.some((o) => o !== polygon && contains(polygon, mid(o)) && polygonArea(o) < polygonArea(polygon)),
    });
  });
}

console.log(`${drawings} drawings: total already exact ${exact}, explained by dropping unnamed rooms ${explained}, rooms missing ${missing}, unexplained ${unexplained}`);
const included = samples.filter((s) => !s.excluded), excluded = samples.filter((s) => s.excluded);
console.log(`unnamed numbered rooms: ${included.length} counted by the ground truth, ${excluded.length} left out`);
const share = (list: Sample[], test: (s: Sample) => boolean) => `${((list.filter(test).length / Math.max(1, list.length)) * 100).toFixed(0)}%`;
const report = (name: string, test: (s: Sample) => boolean) => console.log(`  ${name.padEnd(28)} counted ${share(included, test).padStart(4)}   left out ${share(excluded, test).padStart(4)}`);
report("has a fixture inside", (s) => s.fixtures > 0);
report("no door on its boundary", (s) => s.doors === 0);
report("exactly one door", (s) => s.doors === 1);
report("two or more doors", (s) => s.doors >= 2);
report("has a window", (s) => s.windows > 0);
report("inside a unit outline", (s) => s.inUnit);
report("area under 1.5 m2", (s) => s.area < 1.5);
report("area 1.5 to 4 m2", (s) => s.area >= 1.5 && s.area < 4);
report("area 4 m2 or more", (s) => s.area >= 4);
report("four vertices", (s) => s.vertices === 4);
for (const rule of [
  ["no fixture and no door", (s: Sample) => s.fixtures === 0 && s.doors === 0],
  ["no fixture, window, no door", (s: Sample) => s.fixtures === 0 && s.windows > 0 && s.doors === 0],
  ["no fixture, has window", (s: Sample) => s.fixtures === 0 && s.windows > 0],
] as [string, (s: Sample) => boolean][]) {
  const hit = samples.filter(rule[1]);
  console.log(`rule "${rule[0]}" => leave out: fires on ${hit.length}, of which ${hit.filter((s) => s.excluded).length} are truly left out; misses ${excluded.filter((s) => !rule[1](s)).length} left-out rooms`);
}
