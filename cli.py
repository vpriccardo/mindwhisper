#!/usr/bin/env python3
"""Minimal CLI for the Italian mentalism word-reconstruction engine."""

from __future__ import annotations

import re
import sys
from pathlib import Path

from engine import BatchSimStats, Engine, EvidenceImpact, Probe, ScoredProbe, SimResult

HELP = """
Commands:
  theme=<name>     set theme (house, kitchen, living_room, bedroom, bathroom, office, generic_household)
  c=N / c>=N / c<=N   consonants exact / min / max
  v=N / v>=N / v<=N   vowels exact / min / max
  len=N / len>=N / len<=N   length exact / min / max
  start=v|c        starts with vowel / consonant
  end=v|c          ends with vowel / consonant
  has=X            contains letter X
  not=X            does not contain letter X
  pN=X             letter at position N is X
  pvN              position N is vowel
  pcN              position N is consonant
  double=yes|no    has consecutive double letter
  target=WORD      rehearsal target (display only; never affects ranking)
  why              why Top-5 currently survive
  impact           evidence usefulness history
  simulate=WORD    auto-simulate target from house_basic profile
  simulate-all     batch simulate every house concept
  undo             undo last evidence
  reset            clear all evidence
  show             reprint current state
  next             show top 5 next probes with branch previews
  help             show this help
  quit / exit      leave
""".strip()


def pct(p: float) -> str:
    return f"{100.0 * p:.1f}%"


def print_impact(impact: EvidenceImpact) -> None:
    print()
    print("EVIDENCE IMPACT")
    print("-" * 32)
    print(f"{impact.before} → {impact.after}")
    print(f"{100.0 * impact.reduction:.1f}% reduction")
    if impact.redundant:
        print()
        print("REDUNDANT EVIDENCE")
        print("-" * 32)
        print(f"{impact.label} adds no information.")
        print(f"Candidates before: {impact.before}")
        print(f"Candidates after: {impact.after}")
        print("Probability distribution unchanged.")


def print_rehearsal(engine: Engine) -> None:
    if engine.rehearsal_target is None:
        return
    rank = engine.target_rank()
    prob = engine.target_probability()
    print()
    print("REHEARSAL TARGET")
    print("-" * 32)
    print(engine.rehearsal_target.word)
    if engine.rehearsal_target.aliases:
        print("aliases: " + "|".join(engine.rehearsal_target.aliases))
    if rank is None:
        print("Rank: eliminated")
        print("Probability: 0%")
    else:
        print(f"Rank: {rank}")
        print(f"Probability: {pct(prob or 0.0)}")
    if len(engine.target_rank_history) > 1:
        trail = " → ".join(str(r) for r in engine.target_rank_history)
        print(f"Rank trail: {trail}")


def print_probe_list(engine: Engine, scored: list[ScoredProbe], *, with_branches: bool) -> None:
    print()
    print("NEXT BEST INFORMATION")
    print("-" * 32)
    if not scored:
        print("No informative binary probes left.")
        return
    for i, item in enumerate(scored, 1):
        print(f"\n{i}. {item.probe.label}")
        print(f"   YES {pct(item.yes_probability)}")
        print(f"   NO  {pct(item.no_probability)}")
        print(f"   split: {item.split_score:.2f}")
        print(f"   cost: {item.askability_penalty:.2f}")
        if item.repetition_penalty:
            print(f"   repetition: {item.repetition_penalty:.2f}")
        print(f"   utility: {item.utility:.2f}")
        if with_branches:
            _print_branches(engine, item.probe)


def print_state(engine: Engine, *, top_n: int = 10, probes_n: int = 5, last_impact: EvidenceImpact | None = None) -> None:
    if last_impact is not None:
        print_impact(last_impact)

    ranked = engine.probabilities()
    n = len(ranked)
    print()
    print("CURRENT STATE")
    print("-" * 32)
    summary = engine.evidence_summary()
    if summary:
        for line in summary:
            print(line)
    else:
        print("(no evidence yet)")
    print()
    print(f"CANDIDATES: {n}")
    if not ranked:
        print("No compatible concepts.")
        print_rehearsal(engine)
        return

    top = ranked[:top_n]
    for i, item in enumerate(top, 1):
        alias_note = f"  aliases: {'|'.join(item.aliases)}" if item.aliases else ""
        print(f"{i}. {item.word:<16} {pct(item.probability)}{alias_note}")

    if n > 5:
        outside = sum(r.probability for r in ranked[5:])
        print(f"\nRemaining probability outside Top 5: {pct(outside)}")

    print()
    print("TOP CANDIDATE")
    print("-" * 32)
    first = ranked[0]
    print(f"{first.word}  {pct(first.probability)}")
    if first.aliases:
        print("aliases: " + "|".join(first.aliases))
    if len(ranked) > 1:
        second = ranked[1]
        gap = first.probability - second.probability
        print(f"{second.word}  {pct(second.probability)}")
        print(f"Gap: {pct(gap)}")
    else:
        print("Gap: n/a (only one candidate)")

    print_rehearsal(engine)
    scored = engine.score_probes(limit=max(probes_n, 1))
    print_probe_list(engine, scored[:probes_n], with_branches=True)


def _print_branches(engine: Engine, probe: Probe, top_n: int = 5) -> None:
    print(f"\n   {probe.label}")
    for label, yes in (("IF YES", True), ("IF NO", False)):
        pool, top = engine.branch_preview(probe, yes, top_n=top_n)
        print(f"   {label}")
        print(f"   Candidates: {len(pool)}")
        if top:
            print("   Top:")
            for row in top:
                print(f"     {row.word:<14} {pct(row.probability)}")


def print_why(engine: Engine) -> None:
    print()
    print("WHY TOP-5 SURVIVE")
    print("-" * 32)
    for line in engine.why_lines(top_n=5):
        print(line)


def print_impact_history(engine: Engine) -> None:
    print()
    print("Evidence history")
    print("-" * 32)
    if not engine.impact_log:
        print("(no evidence yet)")
        return
    for impact in engine.impact_log:
        print()
        print(impact.label)
        print(f"{impact.before} → {impact.after}")
        print(f"{100.0 * impact.reduction:.1f}% reduction")
        if impact.redundant:
            print("REDUNDANT")


def print_sim_result(result: SimResult) -> None:
    print()
    print(f"SIMULATE {result.target}")
    print("-" * 32)
    print(f"concept_id: {result.concept_id}")
    print(f"Initial rank after house_basic: {result.initial_rank}")
    if not result.steps:
        print("Already Top-1 (or no probes available).")
    for i, step in enumerate(result.steps, 1):
        print()
        print(f"STEP {i}")
        print(f"Probe: {step.probe_label}")
        print(f"Answer: {step.answer}")
        print(f"Target rank: {step.rank_before} → {step.rank_after}")
        if step.redundant:
            print("REDUNDANT")
    print()
    print(f"Adaptive probes: {result.probes}")
    print(f"Final rank: {result.final_rank}")
    print(f"Reached Top-1: {result.reached_top1}")


def print_batch_stats(stats: BatchSimStats) -> None:
    print()
    print("SIMULATE-ALL")
    print("-" * 32)
    print(f"Total concepts: {stats.total}")
    print()
    for i, (t1, t3) in enumerate(zip(stats.top1_after, stats.top3_after), 1):
        print(f"Top-1 after {i} adaptive probe{'s' if i > 1 else ''}: {100.0 * t1:.1f}%")
        print(f"Top-3 after {i} probes: {100.0 * t3:.1f}%")
    print()
    print(f"Median probes to Top-1: {stats.median_probes:.1f}")
    print(f"Mean probes to Top-1: {stats.mean_probes:.2f}")
    print(f"90th percentile: {stats.p90_probes:.1f}")
    print(f"Unresolved after 5 probes: {100.0 * stats.unresolved_after_5:.1f}%")
    print()
    print("Hardest concepts:")
    for word, probes in stats.hardest[:10]:
        print(f"  {word:<16} {probes} probes")
    print()
    print("Most useful probe types:")
    for kind, count in sorted(stats.probe_kind_counts.items(), key=lambda x: (-x[1], x[0]))[:10]:
        print(f"  {kind:<24} {count}")
    print()
    print("Most frequently redundant evidence:")
    if not stats.redundant_kind_counts:
        print("  (none)")
    else:
        for kind, count in sorted(stats.redundant_kind_counts.items(), key=lambda x: (-x[1], x[0]))[:10]:
            print(f"  {kind:<24} {count}")


def parse_command(engine: Engine, raw: str) -> str | None:
    """Apply a command. Return an error string, a status token, or None on success."""
    cmd = raw.strip()
    if not cmd:
        return None
    lower = cmd.lower()

    if lower in {"help", "?"}:
        print(HELP)
        return "help"
    if lower in {"quit", "exit", "q"}:
        return "quit"
    if lower == "show":
        return "show"
    if lower == "next":
        print_state(engine, top_n=10, probes_n=5)
        return "next"
    if lower == "why":
        print_why(engine)
        return "why"
    if lower == "impact":
        print_impact_history(engine)
        return "impact"
    if lower == "undo":
        if not engine.undo():
            return "Nothing to undo."
        return None
    if lower == "reset":
        engine.reset()
        return None

    m = re.fullmatch(r"target\s*=\s*(.+)", cmd, re.IGNORECASE)
    if m:
        try:
            concept = engine.set_rehearsal_target(m.group(1).strip())
        except ValueError as exc:
            return str(exc)
        print(f"Rehearsal target set: {concept.word}")
        if concept.aliases:
            print("aliases: " + "|".join(concept.aliases))
        return "target"

    m = re.fullmatch(r"simulate\s*=\s*(.+)", cmd, re.IGNORECASE)
    if m:
        try:
            result = engine.simulate(m.group(1).strip())
        except ValueError as exc:
            return str(exc)
        print_sim_result(result)
        return "simulate"

    if lower in {"simulate-all", "simulate_all", "simulateall"}:
        stats = engine.simulate_all()
        print_batch_stats(stats)
        return "simulate-all"

    m = re.fullmatch(r"theme\s*=\s*([a-z_]+)", lower)
    if m:
        return ("evidence", engine.add_evidence("theme", m.group(1)))

    m = re.fullmatch(r"c\s*(=|>=|<=)\s*(\d+)", lower)
    if m:
        op, n = m.group(1), int(m.group(2))
        kind = {"=": "exact_consonants", ">=": "min_consonants", "<=": "max_consonants"}[op]
        return ("evidence", engine.add_evidence(kind, n))

    m = re.fullmatch(r"v\s*(=|>=|<=)\s*(\d+)", lower)
    if m:
        op, n = m.group(1), int(m.group(2))
        kind = {"=": "exact_vowels", ">=": "min_vowels", "<=": "max_vowels"}[op]
        return ("evidence", engine.add_evidence(kind, n))

    m = re.fullmatch(r"len\s*(=|>=|<=)\s*(\d+)", lower)
    if m:
        op, n = m.group(1), int(m.group(2))
        kind = {"=": "exact_length", ">=": "min_length", "<=": "max_length"}[op]
        return ("evidence", engine.add_evidence(kind, n))

    m = re.fullmatch(r"start\s*=\s*([vc])", lower)
    if m:
        return ("evidence", engine.add_evidence("starts_with_vowel", m.group(1) == "v"))

    m = re.fullmatch(r"end\s*=\s*([vc])", lower)
    if m:
        return ("evidence", engine.add_evidence("ends_with_vowel", m.group(1) == "v"))

    m = re.fullmatch(r"has\s*=\s*([a-z])", lower)
    if m:
        return ("evidence", engine.add_evidence("contains_letter", m.group(1).upper()))

    m = re.fullmatch(r"not\s*=\s*([a-z])", lower)
    if m:
        return ("evidence", engine.add_evidence("does_not_contain_letter", m.group(1).upper()))

    m = re.fullmatch(r"p(\d+)\s*=\s*([a-z])", lower)
    if m:
        return ("evidence", engine.add_evidence("letter_at_position", (int(m.group(1)), m.group(2).upper())))

    m = re.fullmatch(r"pv(\d+)", lower)
    if m:
        return ("evidence", engine.add_evidence("vowel_at_position", int(m.group(1))))

    m = re.fullmatch(r"pc(\d+)", lower)
    if m:
        return ("evidence", engine.add_evidence("consonant_at_position", int(m.group(1))))

    m = re.fullmatch(r"double\s*=\s*(yes|no|y|n|true|false)", lower)
    if m:
        return ("evidence", engine.add_evidence("has_double_letter", m.group(1) in {"yes", "y", "true"}))

    return f"Unknown command: {cmd!r}. Type help."


def handle_result(engine: Engine, result) -> bool:
    """Return True if the session should quit."""
    # Evidence tuples contain EvidenceImpact — check before any set membership.
    if isinstance(result, tuple) and result and result[0] == "evidence":
        print_state(engine, last_impact=result[1])
        return False
    if result == "quit":
        return True
    if result in {"help", "why", "impact", "next", "simulate", "simulate-all"}:
        return False
    if result == "show":
        print_state(engine)
        return False
    if result == "target":
        print_state(engine)
        return False
    if result:
        print(result)
        return False
    print_state(engine)
    return False


def run_session(commands: list[str] | None = None, csv_path: Path | None = None) -> None:
    engine = Engine.load(csv_path) if csv_path else Engine.load()
    print("MENTALISM ENGINE")
    print(f"Dictionary: {len(engine.words)} Italian household concepts")
    print()
    print(HELP)
    print()

    if commands is not None:
        for raw in commands:
            print(f"> {raw}")
            result = parse_command(engine, raw)
            if handle_result(engine, result):
                break
        return

    theme = input("Theme (or Enter to skip): ").strip()
    if theme:
        impact = engine.add_evidence("theme", theme.lower())
        print_state(engine, last_impact=impact)

    while True:
        try:
            raw = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        result = parse_command(engine, raw)
        if handle_result(engine, result):
            break


def main(argv: list[str] | None = None) -> None:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "--demo":
        which = argv[1] if len(argv) > 1 else "televisore"
        if which == "televisore":
            run_session(["theme=house", "c=5", "v>=4", "end=v", "next"])
        elif which == "latte":
            run_session(["theme=house", "len=5", "v=2", "next"])
        else:
            print("Usage: cli.py --demo [televisore|latte]")
            sys.exit(1)
        return
    if argv and argv[0] == "--cmds":
        run_session(argv[1:])
        return
    run_session()


if __name__ == "__main__":
    main()
