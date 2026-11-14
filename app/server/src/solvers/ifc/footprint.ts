/** Plan-view measures of a triangle mesh: projected footprint area, its outline, convex hull, enclosed volume. */
import { contains, mid } from "../../geometry.js";
import type { Point, Polygon } from "../../types.js";

/** Triangles in plan coordinates: x east, y north, z up, in metres. Wound so that outward normals follow the right-hand rule. */
export interface Mesh {
  /** x, y, z per vertex. */
  positions: Float64Array;
  /** Three vertex indices per triangle. */
  indices: Uint32Array;
}

// Faces closer to vertical than this (normal z over normal length) do not count as seen from above.
const FACING_TOLERANCE = 0.01;
// Vertices closer than this in plan are the same outline corner.
const WELD = 1e-4;

/** Signed plan area of every triangle that is visible along the z axis; positive when counter-clockwise from above. */
function projectedAreas(mesh: Mesh): Float64Array {
  const { positions: p, indices } = mesh;
  const areas = new Float64Array(indices.length / 3);
  for (let t = 0; t < areas.length; t++) {
    const a = indices[3 * t] * 3, b = indices[3 * t + 1] * 3, c = indices[3 * t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length > 0 && Math.abs(nz) / length > FACING_TOLERANCE) areas[t] = nz / 2;
  }
  return areas;
}

/**
 * The faces that make up the footprint: of a closed solid, the upward and the downward faces cover the same plan area,
 * so either set works; of an open surface only one set exists. Returns the sign of the larger set.
 */
function footprintSide(areas: Float64Array): { sign: 1 | -1; area: number } {
  let up = 0, down = 0;
  for (const a of areas) {
    if (a > 0) up += a;
    else down -= a;
  }
  return up >= down ? { sign: 1, area: up } : { sign: -1, area: down };
}

/** Plan area covered by the mesh, in m². Exact for solids that any vertical line crosses at most once. */
export function footprintArea(mesh: Mesh): number {
  return footprintSide(projectedAreas(mesh)).area;
}

/**
 * Outlines of the footprint: boundary loops of the faces seen from above, outer loops counter-clockwise and
 * holes clockwise, largest first.
 */
export function footprintLoops(mesh: Mesh): Polygon[] {
  const { positions: p, indices } = mesh;
  const areas = projectedAreas(mesh);
  const { sign } = footprintSide(areas);

  const points: Point[] = [];
  const welded = new Map<string, number>();
  const weld = (vertex: number): number => {
    const x = p[vertex * 3], y = p[vertex * 3 + 1];
    const key = `${Math.round(x / WELD)},${Math.round(y / WELD)}`;
    let id = welded.get(key);
    if (id === undefined) {
      id = points.length;
      points.push([x, y]);
      welded.set(key, id);
    }
    return id;
  };

  // Directed edges of the chosen faces, counter-clockwise; an edge shared by two faces cancels against its reverse.
  const SHIFT = 2 ** 26;
  const edges = new Map<number, number>();
  const add = (from: number, to: number) => {
    if (from === to) return;
    const reverse = to * SHIFT + from;
    const pending = edges.get(reverse);
    if (pending) {
      if (pending === 1) edges.delete(reverse);
      else edges.set(reverse, pending - 1);
    } else {
      const key = from * SHIFT + to;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  };
  for (let t = 0; t < areas.length; t++) {
    if (areas[t] * sign <= 0) continue;
    const a = weld(indices[3 * t]), b = weld(indices[3 * t + 1]), c = weld(indices[3 * t + 2]);
    if (sign > 0) {
      add(a, b); add(b, c); add(c, a);
    } else {
      add(a, c); add(c, b); add(b, a);
    }
  }

  const outgoing = new Map<number, number[]>();
  for (const [key, count] of edges) {
    const from = Math.floor(key / SHIFT), to = key % SHIFT;
    if (!outgoing.has(from)) outgoing.set(from, []);
    for (let i = 0; i < count; i++) outgoing.get(from)!.push(to);
  }

  const loops: Polygon[] = [];
  for (const [start, targets] of outgoing) {
    while (targets.length > 0) {
      const loop: number[] = [start];
      let current = targets.pop()!;
      while (current !== start) {
        loop.push(current);
        const next = outgoing.get(current);
        if (!next || next.length === 0) break;
        current = next.pop()!;
      }
      if (current === start && loop.length >= 3) {
        const polygon = dropCollinear(loop.map((i) => points[i]));
        if (polygon.length >= 3) loops.push(polygon);
      }
    }
  }
  return loops.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
}

/**
 * The footprint as fillable polygons, largest first: every outer loop, with its holes joined in through a
 * zero-width slit so that one closed path draws the shape with the holes left empty.
 */
export function footprintShapes(mesh: Mesh): Polygon[] {
  const loops = footprintLoops(mesh);
  const outers = loops.filter((loop) => signedArea(loop) > 0);
  const shapes = outers.map((outer) => ({ outer, holes: [] as Polygon[] }));
  for (const hole of loops.filter((loop) => signedArea(loop) < 0)) {
    // Loops come largest first, so the last outer loop containing the hole is the tightest one.
    const owner = shapes.findLast((shape) => contains(shape.outer, hole[0]) || contains(shape.outer, mid(hole)));
    owner?.holes.push(hole);
  }
  return shapes.map(({ outer, holes }) => holes.reduce(bridge, outer));
}

/** Splices a hole into a polygon at their closest pair of vertices. */
function bridge(outer: Polygon, hole: Polygon): Polygon {
  let best = Infinity, at = 0, from = 0;
  for (let i = 0; i < outer.length; i++) {
    for (let j = 0; j < hole.length; j++) {
      const distance = (outer[i][0] - hole[j][0]) ** 2 + (outer[i][1] - hole[j][1]) ** 2;
      if (distance < best) [best, at, from] = [distance, i, j];
    }
  }
  const around = [...hole.slice(from), ...hole.slice(0, from), hole[from]];
  return [...outer.slice(0, at + 1), ...around, ...outer.slice(at)];
}

/** Positive for counter-clockwise polygons. */
export function signedArea(points: Polygon): number {
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    total += x1 * y2 - x2 * y1;
  }
  return total / 2;
}

function dropCollinear(points: Polygon): Polygon {
  const kept: Polygon = [];
  for (let i = 0; i < points.length; i++) {
    const [px, py] = points[(i + points.length - 1) % points.length];
    const [x, y] = points[i];
    const [nx, ny] = points[(i + 1) % points.length];
    const cross = (x - px) * (ny - y) - (y - py) * (nx - x);
    const scale = Math.hypot(x - px, y - py) * Math.hypot(nx - x, ny - y);
    if (Math.abs(cross) > 1e-9 * Math.max(scale, 1e-12) && scale > 0) kept.push(points[i]);
  }
  return kept;
}

/** Convex hull of the mesh vertices in plan, counter-clockwise. */
export function planHull(mesh: Mesh): Polygon {
  const points: Point[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) points.push([mesh.positions[i], mesh.positions[i + 1]]);
  return convexHull(points);
}

/** Andrew's monotone chain. */
export function convexHull(points: Point[]): Polygon {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (input: Point[]): Point[] => {
    const chain: Point[] = [];
    for (const point of input) {
      while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], point) <= 0) chain.pop();
      chain.push(point);
    }
    chain.pop();
    return chain;
  };
  return [...half(sorted), ...half(sorted.reverse())];
}

/** Volume enclosed by a closed mesh, in m³. */
export function meshVolume(mesh: Mesh): number {
  const { positions: p, indices } = mesh;
  // Sum of signed tetrahedra against a point near the mesh, to keep precision with georeferenced coordinates.
  const ox = p[0] ?? 0, oy = p[1] ?? 0, oz = p[2] ?? 0;
  let total = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = p[a] - ox, ay = p[a + 1] - oy, az = p[a + 2] - oz;
    const bx = p[b] - ox, by = p[b + 1] - oy, bz = p[b + 2] - oz;
    const cx = p[c] - ox, cy = p[c + 1] - oy, cz = p[c + 2] - oz;
    total += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return Math.abs(total) / 6;
}

/** Plan bounding box of a mesh: [minX, minY, maxX, maxY]. */
export function planBounds(mesh: Mesh): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i], y = mesh.positions[i + 1];
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
