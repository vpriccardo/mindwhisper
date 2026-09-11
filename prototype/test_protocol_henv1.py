"""HENV1 Python reference tests."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from build_dictionary import normalize_word
from prototype.protocol_henv1 import (
    HENV_BIT_COUNT,
    bits_to_token,
    create_hidden_token,
    token_to_bits,
    token_to_hex,
)


class Henv1Tests(unittest.TestCase):
    def test_normalize_parity(self) -> None:
        self.assertEqual(normalize_word("lettò"), "LETTO")

    def test_letto_vector(self) -> None:
        tok = create_hidden_token("LETTO", 0x2A)
        self.assertEqual(token_to_hex(tok.token), "2a60a5363d6eb3")
        bits = token_to_bits(tok.token)
        self.assertEqual(len(bits), HENV_BIT_COUNT)
        self.assertEqual(
            "".join(str(b) for b in bits),
            "00101010011000001010010100110110001111010110111010110011",
        )
        self.assertEqual(bits_to_token(bits), tok.token)


if __name__ == "__main__":
    unittest.main()
