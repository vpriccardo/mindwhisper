#!/usr/bin/env python3
"""Hard-filter concept reconstruction engine with next-probe recommendations."""

from __future__ import annotations

import copy
import csv
import statistics
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from build_dictionary import normalize_word

VOWELS = set("AEIOU")
ROOT = Path(__file__).resolve().parent
DEFAULT_CSV = ROOT / "data" / "italian_words.csv"

# Theatrical cost of obtaining a piece of information. Experimental, not truths.
ASKABILITY = {
    "contains_letter": 0.05,
    "has_double_letter": 0.10,
    "starts_or_ends_with_vowel": 0.10,
    "another_vowel_exists": 0.10,
    "vowel_at_position": 0.20,
    "consonant_at_position": 0.20,
    "letter_at_position": 0.25,
    "exact_vowel_count": 0.25,
    "exact_consonant_count": 0.20,
    "exact_length": 0.30,
    # Internal kind aliases map to the same costs
    "starts_with_vowel": 0.10,
    "ends_with_vowel": 0.10,
    "exact_vowels": 0.25,
    "exact_consonants": 0.20,
}

FAMILY = {
    "contains_letter": "LETTER",
    "does_not_contain_letter": "LETTER",
    "letter_at_position": "POSITION",
    "not_letter_at_position": "POSITION",
    "vowel_at_position": "POSITION",
    "not_vowel_at_position": "POSITION",
    "consonant_at_position": "POSITION",
    "not_consonant_at_position": "POSITION",
    "starts_with_vowel": "BOUNDARY",
    "ends_with_vowel": "BOUNDARY",
    "has_double_letter": "SHAPE",
    "another_vowel_exists": "VOWEL",
    "exact_length": "COUNT",
    "not_exact_length": "COUNT",
    "min_length": "COUNT",
    "max_length": "COUNT",
    "exact_vowels": "VOWEL",
    "not_exact_vowels": "VOWEL",
    "min_vowels": "VOWEL",
    "max_vowels": "VOWEL",
    "exact_consonants": "CONSONANT",
    "not_exact_consonants": "CONSONANT",
    "min_consonants": "CONSONANT",
    "max_consonants": "CONSONANT",
    "theme": "SHAPE",
}

HOUSE_BASIC = "house_basic"
MAX_ADAPTIVE_PROBES = 10


def _parse_bool(value: str | bool) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "y"}


def _parse_positions(value: str) -> list[int]:
    value = (value or "").strip()
    if not value:
        return []
    return [int(x) for x in value.split("|") if x]


def _parse_aliases(value: str) -> tuple[str, ...]:
    value = (value or "").strip()
    if not value:
        return ()
    return tuple(a.strip().upper() for a in value.split("|") if a.strip())


def _same_distribution(a: list["RankedConcept"], b: list["RankedConcept"]) -> bool:
    if len(a) != len(b):
        return False
    for x, y in zip(a, b):
        if x.word != y.word or abs(x.probability - y.probability) > 1e-12:
            return False
    return True


@dataclass
class Concept:
    concept_id: str
    word: str
    aliases: tuple[str, ...]
    language: str
    themes: set[str]
    base_weight: float
    length: int
    vowel_count: int
    consonant_count: int
    internal_vowel_count: int
    starts_with_vowel: bool
    ends_with_vowel: bool
    vowel_positions: list[int]
    consonant_positions: list[int]
    vowel_sequence: str
    first_letter: str
    last_letter: str
    double_letter: bool

    def letter_at(self, position: int) -> Optional[str]:
        if position < 1 or position > self.length:
            return None
        return self.word[position - 1]


@dataclass
class Evidence:
    kind: str
    value: Any
    family: str = ""

    def __post_init__(self) -> None:
        if not self.family:
            self.family = FAMILY.get(self.kind, "SHAPE")


@dataclass
class Probe:
    kind: str
    value: Any
    label: str
    family: str
    askability: float


@dataclass
class ScoredProbe:
    probe: Probe
    yes_probability: float
    no_probability: float
    split_score: float
    askability_penalty: float
    repetition_penalty: float
    utility: float

    @property
    def final_score(self) -> float:
        return self.utility


@dataclass
class RankedConcept:
    word: str
    probability: float
    base_weight: float
    concept_id: str = ""
    aliases: tuple[str, ...] = ()


@dataclass
class EvidenceImpact:
    kind: str
    value: Any
    label: str
    before: int
    after: int
    reduction: float
    redundant: bool


@dataclass
class SimStep:
    probe_label: str
    probe_kind: str
    answer: str
    rank_before: int
    rank_after: int
    redundant: bool


@dataclass
class SimResult:
    target: str
    concept_id: str
    initial_rank: int
    steps: list[SimStep]
    probes: int
    reached_top1: bool
    final_rank: int
    unresolved: bool
    probe_kinds: list[str]
    redundant_labels: list[str]


@dataclass
class BatchSimStats:
    total: int
    top1_after: list[float]
    top3_after: list[float]
    median_probes: float
    mean_probes: float
    p90_probes: float
    unresolved_after_5: float
    hardest: list[tuple[str, int]]
    probe_kind_counts: dict[str, int]
    redundant_kind_counts: dict[str, int]
    results: list[SimResult]


@dataclass
class Engine:
    words: list[Concept]
    evidence: list[Evidence] = field(default_factory=list)
    history_families: list[str] = field(default_factory=list)
    impact_log: list[EvidenceImpact] = field(default_factory=list)
    rehearsal_target: Optional[Concept] = None
    target_rank_history: list[int] = field(default_factory=list)
    _stack: list[tuple[list[Evidence], list[str], list[EvidenceImpact], list[int]]] = field(
        default_factory=list
    )
    _by_surface: dict[str, Concept] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path | str = DEFAULT_CSV) -> "Engine":
        words: list[Concept] = []
        with Path(path).open(encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                words.append(
                    Concept(
                        concept_id=row["concept_id"],
                        word=row["canonical_word"].upper(),
                        aliases=_parse_aliases(row.get("aliases", "")),
                        language=row["language"],
                        themes={t for t in row["themes"].split("|") if t},
                        base_weight=float(row["base_weight"]),
                        length=int(row["length"]),
                        vowel_count=int(row["vowel_count"]),
                        consonant_count=int(row["consonant_count"]),
                        internal_vowel_count=int(row["internal_vowel_count"]),
                        starts_with_vowel=_parse_bool(row["starts_with_vowel"]),
                        ends_with_vowel=_parse_bool(row["ends_with_vowel"]),
                        vowel_positions=_parse_positions(row["vowel_positions"]),
                        consonant_positions=_parse_positions(row["consonant_positions"]),
                        vowel_sequence=row["vowel_sequence"],
                        first_letter=row["first_letter"],
                        last_letter=row["last_letter"],
                        double_letter=_parse_bool(row["double_letter"]),
                    )
                )
        engine = cls(words=words)
        engine._index_surfaces()
        return engine

    def _index_surfaces(self) -> None:
        self._by_surface = {}
        for concept in self.words:
            self._by_surface[concept.word] = concept
            for alias in concept.aliases:
                self._by_surface[alias] = concept

    def resolve_surface(self, text: str) -> Optional[Concept]:
        key = normalize_word(text)
        if not key:
            return None
        return self._by_surface.get(key)

    def set_rehearsal_target(self, text: str) -> Concept:
        concept = self.resolve_surface(text)
        if concept is None:
            raise ValueError(f"Unknown concept: {text!r}")
        self.rehearsal_target = concept
        rank = self.target_rank()
        self.target_rank_history = [rank] if rank is not None else []
        return concept

    def clear_rehearsal_target(self) -> None:
        self.rehearsal_target = None
        self.target_rank_history.clear()

    def target_rank(self) -> Optional[int]:
        if self.rehearsal_target is None:
            return None
        for i, item in enumerate(self.probabilities(), 1):
            if item.word == self.rehearsal_target.word:
                return i
        return None

    def target_probability(self) -> Optional[float]:
        if self.rehearsal_target is None:
            return None
        for item in self.probabilities():
            if item.word == self.rehearsal_target.word:
                return item.probability
        return None

    def push_checkpoint(self) -> None:
        self._stack.append(
            (
                copy.deepcopy(self.evidence),
                list(self.history_families),
                copy.deepcopy(self.impact_log),
                list(self.target_rank_history),
            )
        )

    def undo(self) -> bool:
        if not self._stack:
            return False
        (
            self.evidence,
            self.history_families,
            self.impact_log,
            self.target_rank_history,
        ) = self._stack.pop()
        return True

    def reset(self) -> None:
        self.evidence.clear()
        self.history_families.clear()
        self.impact_log.clear()
        self._stack.clear()
        if self.rehearsal_target is not None:
            rank = self.target_rank()
            self.target_rank_history = [rank] if rank is not None else []
        else:
            self.target_rank_history.clear()

    def add_evidence(self, kind: str, value: Any, *, record_history: bool = True) -> EvidenceImpact:
        before = self.probabilities()
        self.push_checkpoint()
        ev = Evidence(kind=kind, value=value)
        self.evidence.append(ev)
        if record_history:
            self.history_families.append(ev.family)
        after = self.probabilities()
        n_before, n_after = len(before), len(after)
        reduction = 0.0 if n_before == 0 else (n_before - n_after) / n_before
        impact = EvidenceImpact(
            kind=kind,
            value=value,
            label=self._evidence_label(ev),
            before=n_before,
            after=n_after,
            reduction=reduction,
            redundant=_same_distribution(before, after),
        )
        self.impact_log.append(impact)
        if self.rehearsal_target is not None:
            rank = self.target_rank()
            if rank is not None:
                self.target_rank_history.append(rank)
        return impact

    def matches(self, word: Concept, evidence: list[Evidence] | None = None) -> bool:
        for ev in evidence if evidence is not None else self.evidence:
            if not self._match_one(word, ev):
                return False
        return True

    def _match_one(self, word: Concept, ev: Evidence) -> bool:
        k, v = ev.kind, ev.value
        if k == "theme":
            return str(v) in word.themes
        if k == "exact_length":
            return word.length == int(v)
        if k == "min_length":
            return word.length >= int(v)
        if k == "max_length":
            return word.length <= int(v)
        if k == "exact_vowels":
            return word.vowel_count == int(v)
        if k == "min_vowels":
            return word.vowel_count >= int(v)
        if k == "max_vowels":
            return word.vowel_count <= int(v)
        if k == "exact_consonants":
            return word.consonant_count == int(v)
        if k == "min_consonants":
            return word.consonant_count >= int(v)
        if k == "max_consonants":
            return word.consonant_count <= int(v)
        if k == "starts_with_vowel":
            return word.starts_with_vowel is bool(v)
        if k == "ends_with_vowel":
            return word.ends_with_vowel is bool(v)
        if k == "contains_letter":
            return str(v).upper() in word.word
        if k == "does_not_contain_letter":
            return str(v).upper() not in word.word
        if k == "letter_at_position":
            pos, letter = v
            ch = word.letter_at(int(pos))
            return ch is not None and ch == str(letter).upper()
        if k == "not_letter_at_position":
            pos, letter = v
            ch = word.letter_at(int(pos))
            return ch is None or ch != str(letter).upper()
        if k == "vowel_at_position":
            ch = word.letter_at(int(v))
            return ch is not None and ch in VOWELS
        if k == "not_vowel_at_position":
            ch = word.letter_at(int(v))
            return ch is None or ch not in VOWELS
        if k == "consonant_at_position":
            ch = word.letter_at(int(v))
            return ch is not None and ch not in VOWELS
        if k == "not_consonant_at_position":
            ch = word.letter_at(int(v))
            return ch is None or ch in VOWELS
        if k == "has_double_letter":
            return word.double_letter is bool(v)
        if k == "another_vowel_exists":
            return (word.internal_vowel_count > 0) is bool(v)
        if k == "not_exact_length":
            return word.length != int(v)
        if k == "not_exact_vowels":
            return word.vowel_count != int(v)
        if k == "not_exact_consonants":
            return word.consonant_count != int(v)
        raise ValueError(f"unknown evidence kind: {k}")

    def candidates(self, evidence: list[Evidence] | None = None) -> list[Concept]:
        return [w for w in self.words if self.matches(w, evidence)]

    def probabilities(self, words: list[Concept] | None = None) -> list[RankedConcept]:
        pool = words if words is not None else self.candidates()
        total = sum(w.base_weight for w in pool)
        if total <= 0:
            return []
        ranked = [
            RankedConcept(
                word=w.word,
                probability=w.base_weight / total,
                base_weight=w.base_weight,
                concept_id=w.concept_id,
                aliases=w.aliases,
            )
            for w in pool
        ]
        ranked.sort(key=lambda r: (-r.probability, r.word))
        return ranked

    def known_facts(self) -> dict[str, Any]:
        facts: dict[str, Any] = {}
        for ev in self.evidence:
            if ev.kind == "theme":
                facts["theme"] = ev.value
            elif ev.kind == "exact_length":
                facts["exact_length"] = int(ev.value)
            elif ev.kind == "exact_vowels":
                facts["exact_vowels"] = int(ev.value)
            elif ev.kind == "exact_consonants":
                facts["exact_consonants"] = int(ev.value)
            elif ev.kind == "starts_with_vowel":
                facts["starts_with_vowel"] = bool(ev.value)
            elif ev.kind == "ends_with_vowel":
                facts["ends_with_vowel"] = bool(ev.value)
            elif ev.kind == "has_double_letter":
                facts["has_double_letter"] = bool(ev.value)
            elif ev.kind == "another_vowel_exists":
                facts["another_vowel_exists"] = bool(ev.value)
            elif ev.kind == "contains_letter":
                facts.setdefault("contains", set()).add(str(ev.value).upper())
            elif ev.kind == "does_not_contain_letter":
                facts.setdefault("not_contains", set()).add(str(ev.value).upper())
            elif ev.kind == "letter_at_position":
                pos, letter = ev.value
                facts.setdefault("letter_at", {})[int(pos)] = str(letter).upper()
            elif ev.kind == "vowel_at_position":
                facts.setdefault("vowel_at", set()).add(int(ev.value))
            elif ev.kind == "not_vowel_at_position":
                facts.setdefault("not_vowel_at", set()).add(int(ev.value))
            elif ev.kind == "consonant_at_position":
                facts.setdefault("consonant_at", set()).add(int(ev.value))
            elif ev.kind == "not_consonant_at_position":
                facts.setdefault("not_consonant_at", set()).add(int(ev.value))
            elif ev.kind == "min_vowels":
                facts["min_vowels"] = max(int(facts.get("min_vowels", 0)), int(ev.value))
            elif ev.kind == "max_vowels":
                facts["max_vowels"] = min(int(facts.get("max_vowels", 10**9)), int(ev.value))
            elif ev.kind == "min_consonants":
                facts["min_consonants"] = max(int(facts.get("min_consonants", 0)), int(ev.value))
            elif ev.kind == "max_consonants":
                facts["max_consonants"] = min(int(facts.get("max_consonants", 10**9)), int(ev.value))
            elif ev.kind == "min_length":
                facts["min_length"] = max(int(facts.get("min_length", 0)), int(ev.value))
            elif ev.kind == "max_length":
                facts["max_length"] = min(int(facts.get("max_length", 10**9)), int(ev.value))
        return facts

    def _evidence_label(self, ev: Evidence) -> str:
        k, v = ev.kind, ev.value
        if k == "theme":
            return f"theme={v}"
        if k == "exact_length":
            return f"len={v}"
        if k == "min_length":
            return f"len>={v}"
        if k == "max_length":
            return f"len<={v}"
        if k == "exact_vowels":
            return f"v={v}"
        if k == "min_vowels":
            return f"v>={v}"
        if k == "max_vowels":
            return f"v<={v}"
        if k == "exact_consonants":
            return f"c={v}"
        if k == "min_consonants":
            return f"c>={v}"
        if k == "max_consonants":
            return f"c<={v}"
        if k == "starts_with_vowel":
            return "start=v" if v else "start=c"
        if k == "ends_with_vowel":
            return "end=v" if v else "end=c"
        if k == "contains_letter":
            return f"has={str(v).upper()}"
        if k == "does_not_contain_letter":
            return f"not={str(v).upper()}"
        if k == "letter_at_position":
            pos, letter = v
            return f"p{pos}={str(letter).upper()}"
        if k == "not_letter_at_position":
            pos, letter = v
            return f"p{pos}!={str(letter).upper()}"
        if k == "vowel_at_position":
            return f"pv{v}"
        if k == "not_vowel_at_position":
            return f"not_pv{v}"
        if k == "consonant_at_position":
            return f"pc{v}"
        if k == "not_consonant_at_position":
            return f"not_pc{v}"
        if k == "has_double_letter":
            return "double=yes" if v else "double=no"
        if k == "another_vowel_exists":
            return "another_vowel=yes" if v else "another_vowel=no"
        if k == "not_exact_length":
            return f"len!={v}"
        if k == "not_exact_vowels":
            return f"v!={v}"
        if k == "not_exact_consonants":
            return f"c!={v}"
        return f"{k}={v}"

    def evidence_summary(self) -> list[str]:
        return [self._evidence_label(ev) for ev in self.evidence]

    def why_lines(self, top_n: int = 5) -> list[str]:
        ranked = self.probabilities()[:top_n]
        summaries = self.evidence_summary()
        if not ranked:
            return ["No compatible concepts."]
        lines: list[str] = []
        for item in ranked:
            lines.append(item.word)
            if item.aliases:
                lines.append("aliases: " + "|".join(item.aliases))
            if not summaries:
                lines.append("  (no evidence yet)")
            else:
                for summary in summaries:
                    lines.append(f"  ✓ {summary}")
            lines.append("")
        return lines

    def _repetition_penalty(self, family: str) -> float:
        penalty = 0.0
        if self.history_families and self.history_families[-1] == family:
            penalty += 0.15
        recent = self.history_families[-3:]
        if sum(1 for f in recent if f == family) >= 2:
            penalty += 0.25
        return penalty

    def _is_known(self, probe: Probe, facts: dict[str, Any]) -> bool:
        k, v = probe.kind, probe.value
        if k == "contains_letter":
            letter = str(v).upper()
            return letter in facts.get("contains", set()) or letter in facts.get("not_contains", set())
        if k == "starts_with_vowel":
            return "starts_with_vowel" in facts
        if k == "ends_with_vowel":
            return "ends_with_vowel" in facts
        if k == "has_double_letter":
            return "has_double_letter" in facts
        if k == "another_vowel_exists":
            return "another_vowel_exists" in facts
        if k == "letter_at_position":
            pos, _letter = v
            known = facts.get("letter_at", {})
            return int(pos) in known
        if k == "vowel_at_position":
            pos = int(v)
            return (
                pos in facts.get("vowel_at", set())
                or pos in facts.get("not_vowel_at", set())
                or pos in facts.get("consonant_at", set())
                or pos in facts.get("letter_at", {})
            )
        if k == "consonant_at_position":
            pos = int(v)
            return (
                pos in facts.get("consonant_at", set())
                or pos in facts.get("not_consonant_at", set())
                or pos in facts.get("vowel_at", set())
                or pos in facts.get("letter_at", {})
            )
        if k == "exact_length":
            return "exact_length" in facts
        if k == "exact_vowels":
            return "exact_vowels" in facts
        if k == "exact_consonants":
            return "exact_consonants" in facts
        return False

    def _predicate(self, probe: Probe) -> Callable[[Concept], bool]:
        k, v = probe.kind, probe.value
        if k == "contains_letter":
            letter = str(v).upper()
            return lambda w: letter in w.word
        if k == "starts_with_vowel":
            return lambda w: w.starts_with_vowel
        if k == "ends_with_vowel":
            return lambda w: w.ends_with_vowel
        if k == "has_double_letter":
            return lambda w: w.double_letter
        if k == "another_vowel_exists":
            return lambda w: w.internal_vowel_count > 0
        if k == "letter_at_position":
            pos, letter = int(v[0]), str(v[1]).upper()
            return lambda w: w.letter_at(pos) == letter
        if k == "vowel_at_position":
            pos = int(v)

            def vowel_pred(w: Concept, p: int = pos) -> bool:
                ch = w.letter_at(p)
                return ch is not None and ch in VOWELS

            return vowel_pred
        if k == "consonant_at_position":
            pos = int(v)

            def cons_pred(w: Concept, p: int = pos) -> bool:
                ch = w.letter_at(p)
                return ch is not None and ch not in VOWELS

            return cons_pred
        if k == "exact_length":
            n = int(v)
            return lambda w: w.length == n
        if k == "exact_vowels":
            n = int(v)
            return lambda w: w.vowel_count == n
        if k == "exact_consonants":
            n = int(v)
            return lambda w: w.consonant_count == n
        raise ValueError(f"unknown probe kind: {k}")

    def generate_probes(self, pool: list[Concept] | None = None) -> list[Probe]:
        words = pool if pool is not None else self.candidates()
        facts = self.known_facts()
        probes: list[Probe] = []

        def maybe_add(kind: str, value: Any, label: str) -> None:
            ask_key = kind
            if kind in {"starts_with_vowel", "ends_with_vowel"}:
                ask_key = "starts_or_ends_with_vowel"
            elif kind == "exact_vowels":
                ask_key = "exact_vowel_count"
            elif kind == "exact_consonants":
                ask_key = "exact_consonant_count"
            probe = Probe(
                kind=kind,
                value=value,
                label=label,
                family=FAMILY.get(kind, "SHAPE"),
                askability=ASKABILITY.get(ask_key, ASKABILITY.get(kind, 0.2)),
            )
            if self._is_known(probe, facts):
                return
            probes.append(probe)

        for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
            maybe_add("contains_letter", letter, f"Contains {letter}?")

        max_len = max((w.length for w in words), default=0)
        for pos in range(1, max_len + 1):
            letters_here = sorted({ch for w in words if (ch := w.letter_at(pos))})
            for letter in letters_here:
                maybe_add("letter_at_position", (pos, letter), f"Letter {pos} is {letter}?")
            maybe_add("vowel_at_position", pos, f"Position {pos} is vowel?")
            maybe_add("consonant_at_position", pos, f"Position {pos} is consonant?")

        maybe_add("starts_with_vowel", True, "Starts with vowel?")
        maybe_add("ends_with_vowel", True, "Ends with vowel?")
        maybe_add("has_double_letter", True, "Has double letter?")
        maybe_add("another_vowel_exists", True, "Another vowel exists?")

        if "exact_length" not in facts:
            for n in sorted({w.length for w in words}):
                maybe_add("exact_length", n, f"Length exactly {n}?")
        if "exact_vowels" not in facts:
            for n in sorted({w.vowel_count for w in words}):
                maybe_add("exact_vowels", n, f"Vowels exactly {n}?")
        if "exact_consonants" not in facts:
            for n in sorted({w.consonant_count for w in words}):
                maybe_add("exact_consonants", n, f"Consonants exactly {n}?")

        return probes

    def score_probes(self, limit: int | None = None) -> list[ScoredProbe]:
        pool = self.candidates()
        ranked = self.probabilities(pool)
        if not ranked:
            return []
        prob_map = {r.word: r.probability for r in ranked}
        word_map = {w.word: w for w in pool}
        scored: list[ScoredProbe] = []

        for probe in self.generate_probes(pool):
            pred = self._predicate(probe)
            yes_p = 0.0
            no_p = 0.0
            for name, p in prob_map.items():
                if pred(word_map[name]):
                    yes_p += p
                else:
                    no_p += p
            if yes_p < 0.05 or yes_p > 0.95:
                continue
            split_score = 1.0 - abs(yes_p - no_p)
            ask = probe.askability
            rep = self._repetition_penalty(probe.family)
            scored.append(
                ScoredProbe(
                    probe=probe,
                    yes_probability=yes_p,
                    no_probability=no_p,
                    split_score=split_score,
                    askability_penalty=ask,
                    repetition_penalty=rep,
                    utility=split_score - ask - rep,
                )
            )

        scored.sort(key=lambda s: (-s.utility, -s.split_score, s.probe.label))
        if limit is not None:
            return scored[:limit]
        return scored

    def branch_preview(
        self, probe: Probe, answer_yes: bool, top_n: int = 5
    ) -> tuple[list[Concept], list[RankedConcept]]:
        pred = self._predicate(probe)
        pool = [w for w in self.candidates() if pred(w) is answer_yes]
        return pool, self.probabilities(pool)[:top_n]

    def apply_probe_answer(self, probe: Probe, yes: bool) -> EvidenceImpact:
        k, v = probe.kind, probe.value
        if k == "contains_letter":
            kind = "contains_letter" if yes else "does_not_contain_letter"
            return self.add_evidence(kind, v)
        if k in {"starts_with_vowel", "ends_with_vowel", "has_double_letter", "another_vowel_exists"}:
            return self.add_evidence(k, yes)
        if k == "letter_at_position":
            if yes:
                return self.add_evidence("letter_at_position", v)
            return self.add_evidence("not_letter_at_position", v)
        if k == "vowel_at_position":
            return self.add_evidence("vowel_at_position" if yes else "not_vowel_at_position", v)
        if k == "consonant_at_position":
            return self.add_evidence("consonant_at_position" if yes else "not_consonant_at_position", v)
        if k == "exact_length":
            return self.add_evidence("exact_length" if yes else "not_exact_length", v)
        if k == "exact_vowels":
            return self.add_evidence("exact_vowels" if yes else "not_exact_vowels", v)
        if k == "exact_consonants":
            return self.add_evidence("exact_consonants" if yes else "not_exact_consonants", v)
        raise ValueError(f"unknown probe kind: {k}")

    def apply_profile(self, concept: Concept, name: str = HOUSE_BASIC) -> None:
        if name != HOUSE_BASIC:
            raise ValueError(f"unknown profile: {name}")
        self.add_evidence("theme", "house")
        self.add_evidence("exact_consonants", concept.consonant_count)
        self.add_evidence("min_vowels", concept.vowel_count)

    def simulate(
        self,
        text: str,
        *,
        profile: str = HOUSE_BASIC,
        max_probes: int = MAX_ADAPTIVE_PROBES,
    ) -> SimResult:
        concept = self.resolve_surface(text)
        if concept is None:
            raise ValueError(f"Unknown concept: {text!r}")
        saved_target = self.rehearsal_target
        saved_history = list(self.target_rank_history)
        saved_evidence = copy.deepcopy(self.evidence)
        saved_families = list(self.history_families)
        saved_impact = copy.deepcopy(self.impact_log)
        saved_stack = copy.deepcopy(self._stack)

        self.rehearsal_target = None
        self.reset()
        self.apply_profile(concept, profile)
        self.rehearsal_target = concept
        rank = self.target_rank()
        self.target_rank_history = [rank] if rank is not None else []
        initial_rank = rank if rank is not None else -1

        steps: list[SimStep] = []
        for _ in range(max_probes):
            current = self.target_rank()
            if current == 1:
                break
            scored = self.score_probes(limit=1)
            if not scored:
                break
            probe = scored[0].probe
            pred = self._predicate(probe)
            yes = pred(concept)
            rank_before = current if current is not None else -1
            impact = self.apply_probe_answer(probe, yes)
            rank_after = self.target_rank()
            steps.append(
                SimStep(
                    probe_label=probe.label,
                    probe_kind=probe.kind,
                    answer="YES" if yes else "NO",
                    rank_before=rank_before,
                    rank_after=rank_after if rank_after is not None else -1,
                    redundant=impact.redundant,
                )
            )

        final_rank = self.target_rank()
        result = SimResult(
            target=concept.word,
            concept_id=concept.concept_id,
            initial_rank=initial_rank,
            steps=steps,
            probes=len(steps),
            reached_top1=final_rank == 1,
            final_rank=final_rank if final_rank is not None else -1,
            unresolved=final_rank != 1,
            probe_kinds=[s.probe_kind for s in steps],
            redundant_labels=[s.probe_label for s in steps if s.redundant],
        )

        self.rehearsal_target = saved_target
        self.target_rank_history = saved_history
        self.evidence = saved_evidence
        self.history_families = saved_families
        self.impact_log = saved_impact
        self._stack = saved_stack
        return result

    def simulate_all(
        self,
        *,
        profile: str = HOUSE_BASIC,
        theme: str = "house",
        max_probes: int = MAX_ADAPTIVE_PROBES,
    ) -> BatchSimStats:
        pool = [w for w in self.words if theme in w.themes]
        results = [self.simulate(w.word, profile=profile, max_probes=max_probes) for w in pool]
        n = len(results)
        if n == 0:
            return BatchSimStats(
                total=0,
                top1_after=[0.0, 0.0, 0.0],
                top3_after=[0.0, 0.0, 0.0],
                median_probes=0.0,
                mean_probes=0.0,
                p90_probes=0.0,
                unresolved_after_5=0.0,
                hardest=[],
                probe_kind_counts={},
                redundant_kind_counts={},
                results=[],
            )

        def rank_after(result: SimResult, k: int) -> int:
            if not result.steps:
                return result.initial_rank
            if k <= 0:
                return result.initial_rank
            idx = min(k, len(result.steps)) - 1
            return result.steps[idx].rank_after

        top1_after = []
        top3_after = []
        for k in (1, 2, 3):
            top1_after.append(sum(1 for r in results if rank_after(r, k) == 1) / n)
            top3_after.append(sum(1 for r in results if 0 < rank_after(r, k) <= 3) / n)

        probes = [r.probes if r.reached_top1 else max_probes for r in results]
        probes_sorted = sorted(probes)
        p90_index = min(len(probes_sorted) - 1, int(round(0.9 * (len(probes_sorted) - 1))))
        unresolved_after_5 = sum(1 for r in results if rank_after(r, 5) != 1) / n

        hardest = sorted(
            ((r.target, r.probes if r.reached_top1 else max_probes) for r in results),
            key=lambda x: (-x[1], x[0]),
        )[:15]

        probe_kind_counts: dict[str, int] = {}
        redundant_kind_counts: dict[str, int] = {}
        for r in results:
            for step in r.steps:
                probe_kind_counts[step.probe_kind] = probe_kind_counts.get(step.probe_kind, 0) + 1
                if step.redundant:
                    redundant_kind_counts[step.probe_kind] = (
                        redundant_kind_counts.get(step.probe_kind, 0) + 1
                    )

        return BatchSimStats(
            total=n,
            top1_after=top1_after,
            top3_after=top3_after,
            median_probes=float(statistics.median(probes)),
            mean_probes=float(statistics.mean(probes)),
            p90_probes=float(probes_sorted[p90_index]),
            unresolved_after_5=unresolved_after_5,
            hardest=hardest,
            probe_kind_counts=probe_kind_counts,
            redundant_kind_counts=redundant_kind_counts,
            results=results,
        )
