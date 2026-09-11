"""Protocol v1: payload parse and dictionary recovery for the QR seal prototype."""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    from engine import Concept, Engine

DIGEST_BYTES = 32
SALT_BYTES = 16
PAYLOAD_BYTES = 48
PAYLOAD_CHARS = 64

PAYLOAD_RE = re.compile(r"^[A-Za-z0-9_-]{64}$")


class PayloadError(Exception):
    """Malformed or invalid commitment payload."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ParsedPayload:
    digest: bytes
    salt: bytes


@dataclass(frozen=True)
class CandidateMapping:
    surface: str
    concept_id: str
    canonical_word: str
    match_type: str  # "canonical" | "alias"


@dataclass
class CandidateIndex:
    """Deduplicated surfaces mapped to one or more concepts."""

    by_surface: dict[str, list[CandidateMapping]]
    concept_count: int
    alias_count: int
    candidate_count: int
    ambiguous_count: int

    def surfaces(self) -> list[str]:
        return list(self.by_surface.keys())


@dataclass
class MatchResult:
    matched_surface: str
    canonical_word: str
    concept_id: str
    match_type: str


@dataclass
class RecoverDiagnostics:
    concept_count: int
    candidate_count: int
    match_count: int
    parse_ms: float
    search_ms: float
    server_total_ms: float
    surfaces_tested: int = 0


@dataclass
class RecoverResponse:
    ok: bool
    result: Optional[MatchResult] = None
    matches: list[MatchResult] = field(default_factory=list)
    diagnostics: Optional[RecoverDiagnostics] = None
    debug: Optional[dict[str, str]] = None
    error: Optional[dict[str, str]] = None


def _b64url_decode(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    try:
        return base64.urlsafe_b64decode(text + pad)
    except Exception as exc:  # noqa: BLE001 — map to stable error code
        raise PayloadError("DECODE_FAILED", "Base64URL decoding failed.") from exc


def parse_payload(text: str | None) -> ParsedPayload:
    """Validate and unpack a Protocol v1 payload string."""
    if text is None or not str(text).strip():
        raise PayloadError("EMPTY_INPUT", "Payload is required.")

    stripped = str(text).strip()

    if len(stripped) != PAYLOAD_CHARS:
        raise PayloadError(
            "INVALID_LENGTH",
            f"Payload must be exactly {PAYLOAD_CHARS} characters.",
        )

    if not PAYLOAD_RE.fullmatch(stripped):
        raise PayloadError(
            "INVALID_CHARSET",
            "Payload must match Base64URL alphabet without padding.",
        )

    raw = _b64url_decode(stripped)

    if len(raw) != PAYLOAD_BYTES:
        raise PayloadError(
            "INVALID_PAYLOAD_SIZE",
            f"Decoded payload must be exactly {PAYLOAD_BYTES} bytes.",
        )

    return ParsedPayload(
        digest=raw[0:DIGEST_BYTES],
        salt=raw[DIGEST_BYTES:PAYLOAD_BYTES],
    )


def encode_payload(digest: bytes, salt: bytes) -> str:
    """Pack digest||salt and encode as unpadded Base64URL (test helper)."""
    if len(digest) != DIGEST_BYTES or len(salt) != SALT_BYTES:
        raise ValueError("digest must be 32 bytes and salt 16 bytes")
    raw = digest + salt
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def seal_bytes(normalized_word: str, salt: bytes) -> tuple[bytes, str]:
    """Compute digest and payload string for a normalized surface (test helper)."""
    if len(salt) != SALT_BYTES:
        raise ValueError(f"salt must be {SALT_BYTES} bytes")
    digest = hashlib.sha256(salt + normalized_word.encode("utf-8")).digest()
    return digest, encode_payload(digest, salt)


def load_candidates(engine: "Engine") -> CandidateIndex:
    """Build unique candidate surfaces from Engine concepts and aliases."""
    by_surface: dict[str, list[CandidateMapping]] = {}
    alias_count = 0

    for concept in engine.words:
        _add_mapping(
            by_surface,
            CandidateMapping(
                surface=concept.word,
                concept_id=concept.concept_id,
                canonical_word=concept.word,
                match_type="canonical",
            ),
        )
        for alias in concept.aliases:
            alias_count += 1
            _add_mapping(
                by_surface,
                CandidateMapping(
                    surface=alias,
                    concept_id=concept.concept_id,
                    canonical_word=concept.word,
                    match_type="alias",
                ),
            )

    ambiguous_count = sum(1 for maps in by_surface.values() if len(_unique_concepts(maps)) > 1)

    return CandidateIndex(
        by_surface=by_surface,
        concept_count=len(engine.words),
        alias_count=alias_count,
        candidate_count=len(by_surface),
        ambiguous_count=ambiguous_count,
    )


def load_candidates_from_mappings(
    mappings: list[CandidateMapping],
    *,
    concept_count: Optional[int] = None,
) -> CandidateIndex:
    """Build a CandidateIndex from an explicit mapping list (tests)."""
    by_surface: dict[str, list[CandidateMapping]] = {}
    alias_count = 0
    concept_ids: set[str] = set()

    for mapping in mappings:
        concept_ids.add(mapping.concept_id)
        if mapping.match_type == "alias":
            alias_count += 1
        _add_mapping(by_surface, mapping)

    ambiguous_count = sum(1 for maps in by_surface.values() if len(_unique_concepts(maps)) > 1)
    return CandidateIndex(
        by_surface=by_surface,
        concept_count=concept_count if concept_count is not None else len(concept_ids),
        alias_count=alias_count,
        candidate_count=len(by_surface),
        ambiguous_count=ambiguous_count,
    )


def _add_mapping(
    by_surface: dict[str, list[CandidateMapping]],
    mapping: CandidateMapping,
) -> None:
    existing = by_surface.setdefault(mapping.surface, [])
    for item in existing:
        if (
            item.concept_id == mapping.concept_id
            and item.match_type == mapping.match_type
            and item.canonical_word == mapping.canonical_word
        ):
            return
    existing.append(mapping)


def _unique_concepts(maps: list[CandidateMapping]) -> set[str]:
    return {m.concept_id for m in maps}


def recover(
    payload_text: str,
    candidates: CandidateIndex,
    *,
    search_hook: Any = None,
) -> RecoverResponse:
    """Parse payload and search the full candidate set for matching surfaces."""
    total_start = time.perf_counter_ns()

    parse_start = time.perf_counter_ns()
    try:
        parsed = parse_payload(payload_text)
    except PayloadError as exc:
        parse_ms = (time.perf_counter_ns() - parse_start) / 1_000_000
        total_ms = (time.perf_counter_ns() - total_start) / 1_000_000
        return RecoverResponse(
            ok=False,
            diagnostics=RecoverDiagnostics(
                concept_count=candidates.concept_count,
                candidate_count=candidates.candidate_count,
                match_count=0,
                parse_ms=parse_ms,
                search_ms=0.0,
                server_total_ms=total_ms,
                surfaces_tested=0,
            ),
            error={"code": exc.code, "message": exc.message},
        )
    parse_ms = (time.perf_counter_ns() - parse_start) / 1_000_000

    search_start = time.perf_counter_ns()
    matches: list[MatchResult] = []
    surfaces_tested = 0

    for surface, mappings in candidates.by_surface.items():
        surfaces_tested += 1
        if search_hook is not None:
            search_hook(surface)
        digest = hashlib.sha256(parsed.salt + surface.encode("utf-8")).digest()
        if hmac.compare_digest(digest, parsed.digest):
            for mapping in mappings:
                matches.append(
                    MatchResult(
                        matched_surface=surface,
                        canonical_word=mapping.canonical_word,
                        concept_id=mapping.concept_id,
                        match_type=mapping.match_type,
                    )
                )

    search_ms = (time.perf_counter_ns() - search_start) / 1_000_000
    total_ms = (time.perf_counter_ns() - total_start) / 1_000_000

    # Deduplicate by concept for ambiguity classification
    unique_by_concept: dict[str, MatchResult] = {}
    for match in matches:
        if match.concept_id not in unique_by_concept:
            unique_by_concept[match.concept_id] = match
    unique_matches = list(unique_by_concept.values())

    diagnostics = RecoverDiagnostics(
        concept_count=candidates.concept_count,
        candidate_count=candidates.candidate_count,
        match_count=len(unique_matches),
        parse_ms=parse_ms,
        search_ms=search_ms,
        server_total_ms=total_ms,
        surfaces_tested=surfaces_tested,
    )
    debug = {
        "digestHex": parsed.digest.hex(),
        "saltHex": parsed.salt.hex(),
    }

    if len(unique_matches) == 0:
        return RecoverResponse(
            ok=False,
            diagnostics=diagnostics,
            debug=debug,
            error={
                "code": "NO_DICTIONARY_MATCH",
                "message": "No dictionary surface matched the commitment.",
            },
        )

    if len(unique_matches) > 1:
        return RecoverResponse(
            ok=False,
            matches=unique_matches,
            diagnostics=diagnostics,
            debug=debug,
            error={
                "code": "AMBIGUOUS_MATCH",
                "message": "Multiple concepts matched the commitment.",
            },
        )

    return RecoverResponse(
        ok=True,
        result=unique_matches[0],
        matches=unique_matches,
        diagnostics=diagnostics,
        debug=debug,
    )


def recover_to_json(response: RecoverResponse) -> dict[str, Any]:
    """Serialize a RecoverResponse to the stable API JSON shape."""
    out: dict[str, Any] = {"ok": response.ok}

    if response.result is not None:
        out["result"] = {
            "matchedSurface": response.result.matched_surface,
            "canonicalWord": response.result.canonical_word,
            "conceptId": response.result.concept_id,
            "matchType": response.result.match_type,
        }

    if response.matches and (not response.ok or len(response.matches) > 1):
        out["matches"] = [
            {
                "matchedSurface": m.matched_surface,
                "canonicalWord": m.canonical_word,
                "conceptId": m.concept_id,
                "matchType": m.match_type,
            }
            for m in response.matches
        ]

    if response.diagnostics is not None:
        d = response.diagnostics
        out["diagnostics"] = {
            "conceptCount": d.concept_count,
            "candidateCount": d.candidate_count,
            "matchCount": d.match_count,
            "parseMs": round(d.parse_ms, 3),
            "searchMs": round(d.search_ms, 3),
            "serverTotalMs": round(d.server_total_ms, 3),
        }

    if response.debug is not None:
        out["debug"] = response.debug

    if response.error is not None:
        out["error"] = response.error

    return out


# Silence unused Concept import for type checkers when not TYPE_CHECKING
_ = TYPE_CHECKING
