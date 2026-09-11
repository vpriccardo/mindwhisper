# Mentalism Engine v2

A small Italian concept-reconstruction engine for a mentalism experiment.

**Purpose:** given a household dictionary and partial structural evidence, narrow candidates and recommend the most useful next piece of information — then measure how many extra binary probes are typically needed.

Not a product. No UI polish, Bayes soft updates, LLM phrasing, or reveal automation.

## Quick start

Requires Python 3.10+.

```bash
python3 build_dictionary.py   # regenerates data/italian_words.csv + dictionary_review.csv
python3 tests.py
python3 cli.py
```

Sample sessions:

```bash
python3 cli.py --demo televisore
python3 cli.py --cmds 'theme=house' 'target=COLAPASTA' 'c=5' 'simulate=TELEVISORE'
```

## Dictionary

| | |
|---|---|
| File | [`data/italian_words.csv`](data/italian_words.csv) |
| Size | **~1200–1800** canonical Italian household concepts |
| Language | Italian only |
| Themes | `house`, `kitchen`, `living_room`, `bedroom`, `bathroom`, `office`, `generic_household` |

Concepts are distinct from surface wording:

```text
concept_id,canonical_word,aliases
colapasta,COLAPASTA,SCOLAPASTA
televisore,TELEVISORE,TV|TELEVISIONE
frigorifero,FRIGORIFERO,FRIGO
```

Search/ranking uses **only** the canonical word. Aliases never create extra probability mass.

Edit the catalog in [`build_dictionary.py`](build_dictionary.py), then re-run the builder. Structural fields are always derived from `canonical_word`.

Vowels: `A E I O U` (accents stripped). `Y` counts as a consonant.

### Base weights (transparent classes)

```text
VERY_COMMON = 5
COMMON = 3
NORMAL = 1
```

Do not boost words because they appeared in development tests.

Review file: [`data/dictionary_review.csv`](data/dictionary_review.csv) lists suspicious synonym pairs for manual review (not auto-merged).

## CLI commands

```text
theme=house
c=5          exact consonants
c>=3         min consonants
v=2          exact vowels
v>=4         min vowels
len=5        exact length
start=v      starts with vowel
end=v        ends with vowel
has=f        contains F
not=f        does not contain F
p5=e         letter at position 5 is E
pv5          position 5 is vowel
pc5          position 5 is consonant
double=yes   has consecutive double letter
target=WORD  rehearsal target (display only)
why          why Top-5 survive
impact       evidence usefulness history
simulate=WORD
simulate-all
undo
reset
show
next         top 5 probes + YES/NO branch previews
help
quit
```

After every evidence command the CLI prints:

- evidence impact (before → after, reduction %, redundant flag)
- candidate count + top concepts with probabilities
- rehearsal target rank/probability (if set)
- top 5 next probes with YES/NO splits, cost, utility, and branch previews

## Probabilities

Hard filter only: incompatible concepts are removed.

```text
P(concept) = base_weight(concept) / sum(weights of compatible concepts)
```

Aliases do not contribute additional weight.

## Next-probe scoring

```text
split_score = 1 - abs(P(YES) - P(NO))
utility     = split_score - askability_penalty - repetition_penalty
```

Askability costs live in one dict at the top of [`engine.py`](engine.py).

Repetition: `+0.15` if the last observation shares the probe family; `+0.25` extra if that family appears twice in the last three observations.

Families: `LETTER`, `VOWEL`, `CONSONANT`, `POSITION`, `COUNT`, `BOUNDARY`, `SHAPE`.

## Rehearsal and simulation

`target=COLAPASTA` is rehearsal-only. It never affects filtering, probabilities, or probe scoring.

`simulate=WORD` applies the `house_basic` profile (truthful evidence derived from the target):

- `theme=house`
- `exact_consonants` = target consonant count
- `min_vowels` = target vowel count

then asks up to 10 adaptive probes, answering YES/NO from the target, until Top-1 or the limit.

`simulate-all` runs that process for every canonical concept with theme `house` and reports aggregate stats.

## Core experiment question

> Starting from realistic structural information, how many additional binary pieces of information does the engine typically need to identify a common household concept?

Report measurements only — median probes, Top-1/Top-3 after 1/2/3 probes, hardest concepts, useful probe types, redundant evidence. Do not claim success or failure.

## Project layout

```text
.
├── README.md
├── requirements.txt          # empty — stdlib only
├── data/
│   ├── italian_words.csv
│   └── dictionary_review.csv
├── build_dictionary.py
├── engine.py
├── cli.py
├── tests.py
└── prototype/                # Offline QR seal (spectator + performer)
```

## Offline QR seal prototype

Local dual-origin prototype: spectator seals a word offline (salted SHA-256 commitment) and shows it as **Standard QR**, **Wax seal** (Aztec), or **Postal mark** (Aztec); performer recovers via paste or continuous webcam scan (QR + Aztec). Spectator assets contain no dictionary or recovery code and work **offline after load** (no service worker / offline refresh). See [`prototype/RUN.txt`](prototype/RUN.txt).

Requires Node.js (for `npm ci` / build) and Python 3.10+.

```bash
cd prototype
npm ci
npm test
npm run build
cd ..
python3 -m unittest prototype.test_protocol
python3 tests.py
python3 prototype/server.py
```

Then open:

- http://127.0.0.1:8000/ — spectator
- http://127.0.0.1:8001/ — performer (camera needs this localhost/127.0.0.1 origin)

Copy the 64-character payload or scan the on-screen symbol. Ports: `--spectator-port` / `--performer-port`; bind defaults to `127.0.0.1`.

Third-party notices: [`prototype/THIRD_PARTY_NOTICES.md`](prototype/THIRD_PARTY_NOTICES.md).

## Philosophy

Keep it readable and easy to modify. Prefer a smaller clean dictionary to a large noisy one.
