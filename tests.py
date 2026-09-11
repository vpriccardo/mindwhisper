#!/usr/bin/env python3
"""Minimal correctness tests for the mentalism engine."""

from __future__ import annotations

import unittest

from build_dictionary import analyze
from engine import Engine


class StructuralTests(unittest.TestCase):
    def test_ombrello(self) -> None:
        f = analyze("ombrello")
        self.assertEqual(f["word"], "OMBRELLO")
        self.assertEqual(f["length"], 8)
        self.assertEqual(f["vowel_count"], 3)
        self.assertEqual(f["consonant_count"], 5)
        self.assertTrue(f["starts_with_vowel"])
        self.assertTrue(f["ends_with_vowel"])

    def test_televisore(self) -> None:
        f = analyze("televisore")
        self.assertEqual(f["word"], "TELEVISORE")
        self.assertEqual(f["length"], 10)
        self.assertEqual(f["vowel_count"], 5)
        self.assertEqual(f["consonant_count"], 5)
        self.assertEqual(f["internal_vowel_count"], 4)
        self.assertTrue(f["ends_with_vowel"])
        self.assertFalse(f["starts_with_vowel"])

    def test_latte(self) -> None:
        f = analyze("latte")
        self.assertEqual(f["word"], "LATTE")
        self.assertEqual(f["length"], 5)
        self.assertEqual(f["vowel_count"], 2)
        self.assertEqual(f["consonant_count"], 3)
        self.assertTrue(f["double_letter"])


class EngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.engine = Engine.load()

    def setUp(self) -> None:
        self.engine.reset()
        self.engine.clear_rehearsal_target()

    def test_dictionary_size(self) -> None:
        n = len(self.engine.words)
        self.assertGreaterEqual(n, 1000)
        self.assertLessEqual(n, 2500)

    def test_schema_fields(self) -> None:
        w = self.engine.words[0]
        self.assertTrue(w.concept_id)
        self.assertTrue(w.word)
        self.assertIsInstance(w.aliases, tuple)
        self.assertIn(w.base_weight, {1, 3, 5})

    def test_probabilities_sum_to_one(self) -> None:
        self.engine.add_evidence("theme", "house")
        ranked = self.engine.probabilities()
        total = sum(r.probability for r in ranked)
        self.assertAlmostEqual(total, 1.0, places=9)

    def test_required_concepts_present(self) -> None:
        names = {w.word for w in self.engine.words}
        for word in [
            "TELEVISORE",
            "OMBRELLO",
            "LATTE",
            "QUADRO",
            "COLAPASTA",
            "POLTRONA",
            "CENTRINO",
            "CENTROTAVOLA",
        ]:
            self.assertIn(word, names)
        # Aliases must not be separate concepts
        self.assertNotIn("SCOLAPASTA", names)
        self.assertNotIn("FRIGO", names)
        self.assertNotIn("TV", names)

    def test_alias_resolution(self) -> None:
        concept = self.engine.resolve_surface("SCOLAPASTA")
        self.assertIsNotNone(concept)
        assert concept is not None
        self.assertEqual(concept.word, "COLAPASTA")
        self.assertEqual(concept.concept_id, "colapasta")
        self.assertIn("SCOLAPASTA", concept.aliases)

    def test_aliases_do_not_split_probability(self) -> None:
        self.engine.add_evidence("theme", "kitchen")
        ranked = self.engine.probabilities()
        words = [r.word for r in ranked]
        self.assertIn("COLAPASTA", words)
        self.assertNotIn("SCOLAPASTA", words)

    def test_evidence_filters_ends_with_vowel(self) -> None:
        self.engine.add_evidence("ends_with_vowel", True)
        for w in self.engine.candidates():
            self.assertTrue(w.ends_with_vowel)
        self.assertTrue(any(w.word == "TELEVISORE" for w in self.engine.candidates()))

    def test_exact_consonants_keeps_televisore(self) -> None:
        self.engine.add_evidence("theme", "house")
        self.engine.add_evidence("exact_consonants", 5)
        names = {w.word for w in self.engine.candidates()}
        self.assertIn("TELEVISORE", names)
        for w in self.engine.candidates():
            self.assertEqual(w.consonant_count, 5)

    def test_televisore_like_session_keeps_target(self) -> None:
        self.engine.add_evidence("theme", "house")
        self.engine.add_evidence("exact_consonants", 5)
        self.engine.add_evidence("min_vowels", 4)
        self.engine.add_evidence("ends_with_vowel", True)
        names = {w.word for w in self.engine.candidates()}
        self.assertIn("TELEVISORE", names)
        self.assertGreater(len(names), 1)

    def test_latte_like_session_keeps_target(self) -> None:
        self.engine.add_evidence("theme", "house")
        self.engine.add_evidence("exact_length", 5)
        self.engine.add_evidence("exact_vowels", 2)
        names = {w.word for w in self.engine.candidates()}
        self.assertIn("LATTE", names)

    def test_probe_scores_are_ordered(self) -> None:
        self.engine.add_evidence("theme", "house")
        scored = self.engine.score_probes(limit=10)
        self.assertTrue(scored)
        finals = [s.final_score for s in scored]
        self.assertEqual(finals, sorted(finals, reverse=True))
        for s in scored:
            self.assertGreaterEqual(s.yes_probability, 0.05)
            self.assertLessEqual(s.yes_probability, 0.95)

    def test_redundant_evidence_detected(self) -> None:
        self.engine.add_evidence("theme", "house")
        self.engine.add_evidence("min_length", 3)
        # Almost all household words are length >= 3; may or may not be redundant.
        # Force redundancy: exact consonants then same again effectively via min lower.
        self.engine.reset()
        self.engine.add_evidence("theme", "house")
        before = self.engine.probabilities()
        impact = self.engine.add_evidence("theme", "house")
        after = self.engine.probabilities()
        self.assertEqual(len(before), len(after))
        self.assertTrue(impact.redundant)

    def test_rehearsal_target_does_not_affect_ranking(self) -> None:
        self.engine.add_evidence("theme", "house")
        self.engine.add_evidence("exact_consonants", 5)
        without = [(r.word, r.probability) for r in self.engine.probabilities()]
        self.engine.set_rehearsal_target("COLAPASTA")
        with_target = [(r.word, r.probability) for r in self.engine.probabilities()]
        self.assertEqual(without, with_target)
        self.assertIsNotNone(self.engine.target_rank())


if __name__ == "__main__":
    unittest.main()
