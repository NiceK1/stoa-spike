import { describe, expect, it } from "vitest";
import { polygonArea } from "../src/geometry.js";
import { convexHull, footprintArea, footprintLoops, footprintShapes, longSide, meshVolume, signedArea, unionArea, type Mesh } from "../src/solvers/ifc/footprint.js";
import type { Point, Polygon } from "../src/types.js";

/** A closed prism over a plan polygon (counter-clockwise, convex or star-shaped around its first corner). */
function prism(outline: Polygon, z0: number, z1: number): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const vertex = ([x, y]: Point, z: number) => positions.push(x, y, z) / 3 - 1;
  const cap = (z: number, up: boolean) => {
    const ids = outline.map((point) => vertex(point, z));
    for (let i = 1; i + 1 < ids.length; i++) indices.push(ids[0], up ? ids[i] : ids[i + 1], up ? ids[i + 1] : ids[i]);
  };
  cap(z1, true);
  cap(z0, false);
  outline.forEach((a, i) => {
    const b = outline[(i + 1) % outline.length];
    const [a0, b0, b1, a1] = [vertex(a, z0), vertex(b, z0), vertex(b, z1), vertex(a, z1)];
    indices.push(a0, b0, b1, a0, b1, a1);
  });
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

const rectangle = (x: number, y: number, w: number, h: number): Polygon => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

function join(...meshes: Mesh[]): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const mesh of meshes) {
    const offset = positions.length / 3;
    positions.push(...mesh.positions);
    indices.push(...[...mesh.indices].map((i) => i + offset));
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

describe("footprint of a mesh", () => {
  it("is the plan area of a box, whatever its height", () => {
    const box = prism(rectangle(10, 20, 4, 3), 0, 2.5);
    expect(footprintArea(box)).toBeCloseTo(12, 9);
    expect(meshVolume(box)).toBeCloseTo(30, 9);
  });

  it("follows an L-shaped room", () => {
    const corner: Polygon = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 3], [0, 3]];
    const room = prism(corner, 0, 2.7);
    expect(footprintArea(room)).toBeCloseTo(6, 9);
    const [outline, ...rest] = footprintLoops(room);
    expect(rest).toEqual([]);
    expect(outline).toHaveLength(6);
    expect(signedArea(outline)).toBeCloseTo(6, 9);
  });

  it("counts stacked layers once", () => {
    const layers = join(prism(rectangle(0, 0, 5, 4), 0, 0.2), prism(rectangle(0, 0, 5, 4), 0.2, 0.3), prism(rectangle(1, 1, 2, 2), 0.3, 0.35));
    expect(footprintArea(layers)).toBeCloseTo(20, 9);
    expect(meshVolume(layers)).toBeCloseTo(4 + 2 + 0.2, 9);
  });

  it("keeps georeferenced coordinates exact", () => {
    const far = prism(rectangle(538_497.25, 6_591_600.5, 2.4, 1.5), 15.8, 18.3);
    expect(footprintArea(far)).toBeCloseTo(3.6, 6);
    expect(meshVolume(far)).toBeCloseTo(9, 6);
  });

  it("draws a ring-shaped footprint as one shape with the hole left open", () => {
    // Top face of a 4 x 4 slab with a 2 x 2 opening, as eight triangles around the hole.
    const outer = rectangle(0, 0, 4, 4), inner = rectangle(1, 1, 2, 2);
    const positions = new Float64Array([...outer, ...inner].flatMap(([x, y]) => [x, y, 0]));
    const indices = new Uint32Array([0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
    const ring = { positions, indices };
    expect(footprintArea(ring)).toBeCloseTo(12, 9);
    expect(footprintLoops(ring).map(signedArea).map(Math.round)).toEqual([16, -4]);
    const shapes = footprintShapes(ring);
    expect(shapes).toHaveLength(1);
    expect(polygonArea(shapes[0])).toBeCloseTo(12, 9);
  });
});

describe("plan helpers", () => {
  it("unions overlapping triangles", () => {
    const square = (x: number, y: number, size: number): Point[][] => [
      [[x, y], [x + size, y], [x + size, y + size]],
      [[x, y], [x + size, y + size], [x, y + size]],
    ];
    expect(unionArea([...square(0, 0, 2), ...square(1, 1, 2)])).toBeCloseTo(7, 9);
    expect(unionArea([...square(0, 0, 2), ...square(5, 0, 1)])).toBeCloseTo(5, 9);
  });

  it("finds the convex hull", () => {
    const hull = convexHull([[0, 0], [2, 0], [1, 1], [2, 2], [0, 2], [1, 0.5]]);
    expect(hull).toHaveLength(4);
    expect(polygonArea(hull)).toBeCloseTo(4, 9);
  });

  it("measures a slanted wall along its run", () => {
    const wall: Polygon = [[0, 0], [3, 4], [2.84, 4.12], [-0.16, 0.12]];
    expect(longSide(wall)).toBeCloseTo(5, 6);
  });
});
