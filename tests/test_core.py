import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from takeoff import raster, swiss  # noqa: E402
from takeoff.geometry import contains, polygon_area  # noqa: E402
from takeoff.model import Intent  # noqa: E402
from takeoff.questions import parse  # noqa: E402
from takeoff.scoring import is_correct  # noqa: E402


def polyline(layer, points, closed=True):
    body = "".join(f"10\n{x}\n20\n{y}\n" for x, y in points)
    return f"0\nLWPOLYLINE\n8\n{layer}\n90\n{len(points)}\n70\n{int(closed)}\n{body}"


def text(layer, value, x, y):
    return f"0\nTEXT\n8\n{layer}\n10\n{x}\n20\n{y}\n1\n{value}\n"


def rect(x, y, w, h):
    return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]


def write_plan(entities):
    f = tempfile.NamedTemporaryFile("w", suffix=".dxf", delete=False, encoding="utf-8")
    f.write("0\nSECTION\n2\nENTITIES\n" + "".join(entities) + "0\nENDSEC\n0\nEOF\n")
    f.close()
    return f.name


class Geometry(unittest.TestCase):
    def test_area_and_containment(self):
        square = rect(0, 0, 2, 3)
        self.assertAlmostEqual(polygon_area(square), 6)
        self.assertTrue(contains(square, (1, 1)))
        self.assertFalse(contains(square, (3, 1)))


class Scoring(unittest.TestCase):
    def test_counts_must_be_exact(self):
        self.assertTrue(is_correct("count", 13, 13))
        self.assertFalse(is_correct("count", 13, 12))

    def test_measures_allow_two_percent(self):
        self.assertTrue(is_correct("area", 100.0, 101.9))
        self.assertFalse(is_correct("area", 100.0, 102.1))
        self.assertFalse(is_correct("volume", 100.0, None))

    def test_text_is_not_auto_scored(self):
        self.assertIsNone(is_correct("text", "Office building", "anything"))


class Questions(unittest.TestCase):
    def test_room_label_count_in_four_languages(self):
        for question, name in (
            ("How many rooms labelled 'Cage d'escalier' are there on this floor?", "Cage d'escalier"),
            ("Wie viele Räume mit der Bezeichnung «Korridor» gibt es in diesem Geschoss?", "Korridor"),
            ("Combien de pièces portant la désignation « Pièce » y a-t-il à cet étage ?", "Pièce"),
            ("Quanti locali con la denominazione «Stanza» ci sono in questo piano?", "Stanza"),
        ):
            self.assertEqual(parse(question, "count"), Intent("count_rooms_labelled", name=name))

    def test_symbol_counts(self):
        self.assertEqual(parse("Quante porte (porte interne e porte d'ingresso insieme) sono disegnate?", "count").kind,
                         "count_doors")
        self.assertEqual(parse("Wie viele WCs sind auf diesem Grundriss eingezeichnet?", "count").kind,
                         "count_toilets")
        self.assertEqual(parse("Combien d'appartements (logements) figurent sur ce plan d'étage ?", "count").kind,
                         "count_apartments")

    def test_areas(self):
        self.assertEqual(parse("Wie gross ist die Nettofläche von Raum U1.02 («Reduit») in m²?", "area"),
                         Intent("area_room", number="U1.02"))
        self.assertEqual(parse("Quelle est la surface nette de l'appartement B en m² ?", "area"),
                         Intent("area_apartment", unit="B"))
        self.assertEqual(parse("What is the total net area in m² of all rooms labelled 'Bad' on this floor?", "area"),
                         Intent("area_rooms_labelled", name="Bad"))

    def test_unknown_question_is_not_guessed(self):
        self.assertIsNone(parse("What is the fire rating of the stair core?", "text"))


class RasterGrading(unittest.TestCase):
    def test_answers_are_matched_to_questions_by_number(self):
        rows = [{"answer": 3}, {"answer": 5}, {"answer": 0}]
        results = [(got, right) for _, got, right in raster.graded(rows, {"2": 5, "1": 4})]
        self.assertEqual(results, [(4, False), (5, True), (None, False)])


class SwissPlan(unittest.TestCase):
    def setUp(self):
        self.path = write_plan([
            polyline("ROOM_OUTLINE", rect(0, 0, 4, 3)),
            text("ROOM_TEXT", "App. A", 2, 2.2), text("ROOM_TEXT", "Zimmer", 2, 1.8),
            text("ROOM_TEXT", "1.01", 2, 1.5), text("ROOM_TEXT", "12.00 m²", 2, 1.2),
            polyline("ROOM_OUTLINE", rect(4, 0, 1, 2)),
            text("ROOM_TEXT", "1.02", 4.5, 1.0),
            polyline("ROOM_OUTLINE", rect(0, 3, 4, 1)),
            text("ROOM_TEXT", "Balkon", 2, 3.8), text("ROOM_TEXT", "1.03", 2, 3.5), text("ROOM_TEXT", "4.00 m²", 2, 3.2),
            polyline("UNIT_OUTLINE", rect(0, 0, 5, 4)),
            polyline("DOOR", rect(3.9, 1, 0.2, 0.8)),
        ])
        self.plan = swiss.load(self.path)

    def tearDown(self):
        os.unlink(self.path)

    def value(self, intent):
        return self.plan.answer(intent).value

    def test_room_area_comes_from_its_outline(self):
        self.assertEqual(self.value(Intent("area_room", number="1.01")), 12.0)

    def test_number_only_room_counts_towards_totals_but_not_label_counts(self):
        self.assertEqual(self.value(Intent("area_all_indoor")), 14.0)
        self.assertEqual(self.value(Intent("count_rooms_labelled", name="zimmer")), 1)

    def test_apartment_area_excludes_outdoor_rooms(self):
        self.assertEqual(self.value(Intent("area_apartment", unit="A")), 14.0)
        self.assertEqual(self.value(Intent("count_apartments")), 1)

    def test_symbols_and_unknown_rooms(self):
        self.assertEqual(self.value(Intent("count_doors")), 1)
        self.assertIsNone(self.plan.answer(Intent("area_room", number="9.99")))


if __name__ == "__main__":
    unittest.main()
