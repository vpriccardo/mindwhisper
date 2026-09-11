"""AENV1 Python parity tests."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from prototype.protocol_aenv1 import (
    CODED_BITS,
    INTERLEAVE_CHECKSUM,
    INTERLEAVE_FORWARD,
    PACKET_BITS,
    conv_encode,
    crc16_ccitt_false,
    deinterleave,
    encode_aenv_packet,
    interleave,
)
from prototype.protocol_henv1 import create_hidden_token, token_to_hex


class Aenv1Tests(unittest.TestCase):
    def test_crc_known_vector(self) -> None:
        # Empty
        self.assertEqual(crc16_ccitt_false(b""), 0xFFFF)
        # "123456789" classic CCITT-FALSE
        self.assertEqual(crc16_ccitt_false(b"123456789"), 0x29B1)

    def test_letto_packet(self) -> None:
        tok = create_hidden_token("LETTO", 0x2A)
        self.assertEqual(token_to_hex(tok.token), "2a60a5363d6eb3")
        enc = encode_aenv_packet(bytes(tok.token))
        self.assertEqual(len(enc.packet_bits), PACKET_BITS)
        self.assertEqual(len(enc.coded_bits), CODED_BITS)
        self.assertEqual(len(enc.interleaved_bits), CODED_BITS)
        # CRC over 7 token bytes only
        self.assertEqual(enc.crc, crc16_ccitt_false(bytes(tok.token)))
        self.assertEqual(enc.packet_bytes[:7], bytes(tok.token))
        self.assertEqual(enc.packet_bytes[7], (enc.crc >> 8) & 0xFF)
        self.assertEqual(enc.packet_bytes[8], enc.crc & 0xFF)

    def test_interleave_inverse(self) -> None:
        bits = [(i * 7 + 3) % 2 for i in range(CODED_BITS)]
        self.assertEqual(deinterleave(interleave(bits)), bits)
        self.assertEqual(len(set(INTERLEAVE_FORWARD)), CODED_BITS)
        self.assertIsInstance(INTERLEAVE_CHECKSUM, int)

    def test_conv_roundtrip_hard(self) -> None:
        tok = create_hidden_token("LETTO", 0x2A)
        enc = encode_aenv_packet(bytes(tok.token))
        coded = enc.coded_bits
        # Soft decode would be in TS; here just check length/termination path via re-encode
        again = conv_encode(enc.packet_bits)
        self.assertEqual(again, coded)


if __name__ == "__main__":
    unittest.main()
