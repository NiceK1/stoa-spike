"""2D polygon helpers. Polygons are lists of (x, y) without a repeated closing point."""


def polygon_area(points):
    total = 0.0
    for (x1, y1), (x2, y2) in zip(points, points[1:] + points[:1]):
        total += x1 * y2 - x2 * y1
    return abs(total) / 2


def contains(points, p):
    x, y = p
    inside = False
    for (x1, y1), (x2, y2) in zip(points, points[1:] + points[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def bbox(points):
    xs = [x for x, _ in points]
    ys = [y for _, y in points]
    return min(xs), min(ys), max(xs), max(ys)


def bbox_sides(points):
    """(short side, long side) of the axis-aligned bounding box."""
    x0, y0, x1, y1 = bbox(points)
    return tuple(sorted((x1 - x0, y1 - y0)))


def center(points):
    x0, y0, x1, y1 = bbox(points)
    return (x0 + x1) / 2, (y0 + y1) / 2
