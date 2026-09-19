"""Tests for Protocol v1 payload parsing and dictionary recovery."""

from __future__ import annotations

import hashlib
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine import Engine
from prototype.protocol import (
    PAYLOAD_CHARS,
    CandidateMapping,
    PayloadError,
    encode_payload,
    load_candidates,
    load_candidates_from_mappings,
    parse_payload,
    recover,
    seal_bytes,
)


CAFFE_SALT = bytes.fromhex("000102030405060708090a0b0c0d0e0f")
CAFFE_DIGEST = bytes.fromhex(
    "ad2fc692d551bed163b3498ca1bb539b3477be2d5af61b5accd9c09ad3cdda32"
)
CAFFE_PAYLOAD = "rS_GktVRvtFjs0mMobtTmzR3vi1a9htazNnAmtPN2jIAAQIDBAUGBwgJCgsMDQ4P"


class ParsePayloadTests(unittest.TestCase):
    def test_fixed_caffe_vector(self) -> None:
        parsed = parse_payload(CAFFE_PAYLOAD)
        self.assertEqual(parsed.digest, CAFFE_DIGEST)
        self.assertEqual(parsed.salt, CAFFE_SALT)
        digest, payload = seal_bytes("CAFFE", CAFFE_SALT)
        self.assertEqual(digest, CAFFE_DIGEST)
        self.assertEqual(payload, CAFFE_PAYLOAD)
        self.assertEqual(len(payload), PAYLOAD_CHARS)

    def test_trim_surrounding_whitespace(self) -> None:
        parsed = parse_payload(f"  {CAFFE_PAYLOAD}  ")
        self.assertEqual(parsed.digest, CAFFE_DIGEST)

    def test_empty_input(self) -> None:
        with self.assertRaises(PayloadError) as ctx:
            parse_payload("")
        self.assertEqual(ctx.exception.code, "EMPTY_INPUT")

        with self.assertRaises(PayloadError) as ctx:
            parse_payload("   ")
        self.assertEqual(ctx.exception.code, "EMPTY_INPUT")

        with self.assertRaises(PayloadError) as ctx:
            parse_payload(None)  # type: ignore[arg-type]
        self.assertEqual(ctx.exception.code, "EMPTY_INPUT")

    def test_invalid_length(self) -> None:
        with self.assertRaises(PayloadError) as ctx:
            parse_payload(CAFFE_PAYLOAD[:-1])
        self.assertEqual(ctx.exception.code, "INVALID_LENGTH")

        with self.assertRaises(PayloadError) as ctx:
            parse_payload(CAFFE_PAYLOAD + "A")
        self.assertEqual(ctx.exception.code, "INVALID_LENGTH")

    def test_invalid_charset(self) -> None:
        bad = "!" + CAFFE_PAYLOAD[1:]
        self.assertEqual(len(bad), 64)
        with self.assertRaises(PayloadError) as ctx:
            parse_payload(bad)
        self.assertEqual(ctx.exception.code, "INVALID_CHARSET")

        # Plus is not Base64URL
        bad_plus = CAFFE_PAYLOAD[:-1] + "+"
        with self.assertRaises(PayloadError) as ctx:
            parse_payload(bad_plus)
        self.assertEqual(ctx.exception.code, "INVALID_CHARSET")

    def test_invalid_decoded_size(self) -> None:
        # A well-formed 64-char Base64URL string always decodes to 48 bytes.
        # Exercise the defense-in-depth size guard by stubbing the decoder.
        import prototype.protocol as protocol_mod

        original = protocol_mod._b64url_decode
        protocol_mod._b64url_decode = lambda _text: b"\x00" * 47  # type: ignore[assignment]
        try:
            with self.assertRaises(PayloadError) as ctx:
                parse_payload(CAFFE_PAYLOAD)
            self.assertEqual(ctx.exception.code, "INVALID_PAYLOAD_SIZE")
        finally:
            protocol_mod._b64url_decode = original  # type: ignore[assignment]

class RecoverTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.engine = Engine.load()
        cls.candidates = load_candidates(cls.engine)

    def test_candidate_index_nonempty(self) -> None:
        self.assertGreater(self.candidates.concept_count, 0)
        self.assertGreater(self.candidates.candidate_count, 0)
        self.assertEqual(
            self.candidates.candidate_count,
            len(self.candidates.by_surface),
        )

    def test_recover_caffe_vector(self) -> None:
        response = recover(CAFFE_PAYLOAD, self.candidates)
        self.assertTrue(response.ok)
        assert response.result is not None
        self.assertEqual(response.result.matched_surface, "CAFFE")
        self.assertEqual(response.result.canonical_word, "CAFFE")
        self.assertEqual(response.result.match_type, "canonical")
        assert response.debug is not None
        self.assertEqual(response.debug["saltHex"], CAFFE_SALT.hex())
        self.assertEqual(response.debug["digestHex"], CAFFE_DIGEST.hex())

    def test_recover_known_canonical(self) -> None:
        salt = bytes.fromhex("101112131415161718191a1b1c1d1e1f")
        _, payload = seal_bytes("OMBRELLO", salt)
        response = recover(payload, self.candidates)
        self.assertTrue(response.ok)
        assert response.result is not None
        self.assertEqual(response.result.matched_surface, "OMBRELLO")
        self.assertEqual(response.result.canonical_word, "OMBRELLO")
        self.assertEqual(response.result.match_type, "canonical")

    def test_recover_alias_scolapasta(self) -> None:
        salt = bytes.fromhex("202122232425262728292a2b2c2d2e2f")
        _, payload = seal_bytes("SCOLAPASTA", salt)
        response = recover(payload, self.candidates)
        self.assertTrue(response.ok)
        assert response.result is not None
        self.assertEqual(response.result.matched_surface, "SCOLAPASTA")
        self.assertEqual(response.result.canonical_word, "COLAPASTA")
        self.assertEqual(response.result.concept_id, "colapasta")
        self.assertEqual(response.result.match_type, "alias")

    def test_no_dictionary_match(self) -> None:
        salt = bytes.fromhex("303132333435363738393a3b3c3d3e3f")
        _, payload = seal_bytes("NOTINDICTIONARYXYZ", salt)
        response = recover(payload, self.candidates)
        self.assertFalse(response.ok)
        assert response.error is not None
        self.assertEqual(response.error["code"], "NO_DICTIONARY_MATCH")
        assert response.diagnostics is not None
        self.assertEqual(response.diagnostics.match_count, 0)

    def test_tampered_payload_no_false_word(self) -> None:
        salt = bytes.fromhex("404142434445464748494a4b4c4d4e4f")
        _, payload = seal_bytes("OMBRELLO", salt)
        chars = list(payload)
        chars[0] = "A" if chars[0] != "A" else "B"
        tampered = "".join(chars)
        response = recover(tampered, self.candidates)
        if response.error and response.error["code"] in {
            "INVALID_CHARSET",
            "DECODE_FAILED",
            "INVALID_PAYLOAD_SIZE",
            "INVALID_LENGTH",
        }:
            return
        self.assertFalse(response.ok)
        self.assertEqual(response.error["code"], "NO_DICTIONARY_MATCH")  # type: ignore[index]

    def test_complete_search_even_when_match_early(self) -> None:
        # Put matching surface first in iteration order by using a tiny index
        # where the match is the first key, and count hook invocations.
        mappings = [
            CandidateMapping("CAFFE", "caffe", "CAFFE", "canonical"),
            CandidateMapping("OMBRELLO", "ombrello", "OMBRELLO", "canonical"),
            CandidateMapping("LATTE", "latte", "LATTE", "canonical"),
        ]
        index = load_candidates_from_mappings(mappings)
        visited: list[str] = []

        response = recover(CAFFE_PAYLOAD, index, search_hook=visited.append)
        self.assertTrue(response.ok)
        self.assertEqual(len(visited), index.candidate_count)
        self.assertEqual(set(visited), set(index.by_surface.keys()))

    def test_ambiguous_match_synthetic(self) -> None:
        # Same surface mapped to two concepts (future dictionary collision).
        mappings = [
            CandidateMapping("TWINSURFACE", "concept_a", "WORD_A", "canonical"),
            CandidateMapping("TWINSURFACE", "concept_b", "WORD_B", "canonical"),
            CandidateMapping("OTHER", "other", "OTHER", "canonical"),
        ]
        index = load_candidates_from_mappings(mappings)
        self.assertEqual(index.ambiguous_count, 1)

        salt = bytes.fromhex("505152535455565758595a5b5c5d5e5f")
        _, payload = seal_bytes("TWINSURFACE", salt)
        response = recover(payload, index)
        self.assertFalse(response.ok)
        assert response.error is not None
        self.assertEqual(response.error["code"], "AMBIGUOUS_MATCH")
        self.assertEqual(len(response.matches), 2)
        ids = {m.concept_id for m in response.matches}
        self.assertEqual(ids, {"concept_a", "concept_b"})

    def test_two_salts_different_payloads(self) -> None:
        salt_a = bytes.fromhex("606162636465666768696a6b6c6d6e6f")
        salt_b = bytes.fromhex("707172737475767778797a7b7c7d7e7f")
        _, payload_a = seal_bytes("OMBRELLO", salt_a)
        _, payload_b = seal_bytes("OMBRELLO", salt_b)
        self.assertNotEqual(payload_a, payload_b)
        self.assertEqual(len(payload_a), 64)
        self.assertEqual(len(payload_b), 64)

    def test_diagnostics_present(self) -> None:
        response = recover(CAFFE_PAYLOAD, self.candidates)
        assert response.diagnostics is not None
        self.assertEqual(response.diagnostics.surfaces_tested, self.candidates.candidate_count)
        self.assertGreaterEqual(response.diagnostics.search_ms, 0.0)
        self.assertGreaterEqual(response.diagnostics.parse_ms, 0.0)
        self.assertGreaterEqual(response.diagnostics.server_total_ms, 0.0)


class EncodeHelpersTests(unittest.TestCase):
    def test_encode_roundtrip(self) -> None:
        digest = hashlib.sha256(b"x").digest()
        salt = bytes(range(16))
        payload = encode_payload(digest, salt)
        parsed = parse_payload(payload)
        self.assertEqual(parsed.digest, digest)
        self.assertEqual(parsed.salt, salt)


if __name__ == "__main__":
    unittest.main()
