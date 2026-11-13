"""The dataset's scoring rules: counts exact; areas, lengths and volumes within 2%."""

RELATIVE_TOLERANCE = 0.02
MEASURES = ("area", "length", "volume")


def is_correct(qtype, expected, value):
    """True/False for scorable types, None for free-form text answers."""
    if qtype == "count":
        return value is not None and round(value) == round(float(expected))
    if qtype in MEASURES:
        if value is None:
            return False
        expected = float(expected)
        return abs(value - expected) <= RELATIVE_TOLERANCE * abs(expected)
    return None
