"""Hidden envelope optical protocol HENV1 (Python reference / tests).

This compact token is a dictionary fingerprint, not encryption and not a
general-purpose secret.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

HENV_PROTOCOL_ID = "HENV1"
HENV_SALT_BYTES = 1
HENV_DIGEST_BYTES = 6
HENV_TOKEN_BYTES = 7
HENV_BIT_COUNT = 56


@dataclass(frozen=True)
class HiddenToken:
    protocol_id: str
    salt8: int
    digest6: bytes
    token: bytes
    normalized_word: str


def hidden_digest6(normalized: str, salt8: int) -> bytes:
    if not normalized:
        raise ValueError("Normalized word is empty.")
    if not isinstance(salt8, int) or salt8 < 0 or salt8 > 255:
        raise ValueError("salt8 must be an integer in 0..255.")
    return hashlib.sha256(bytes([salt8]) + normalized.encode("utf-8")).digest()[
        :HENV_DIGEST_BYTES
    ]


def create_hidden_token(normalized: str, salt8: int) -> HiddenToken:
    if not normalized:
        raise ValueError("Normalized word is empty.")
    digest6 = hidden_digest6(normalized, salt8)
    token = bytes([salt8]) + digest6
    return HiddenToken(
        protocol_id=HENV_PROTOCOL_ID,
        salt8=salt8,
        digest6=digest6,
        token=token,
        normalized_word=normalized,
    )


def token_to_bits(token: bytes) -> list[int]:
    if len(token) != HENV_TOKEN_BYTES:
        raise ValueError(f"Token must be exactly {HENV_TOKEN_BYTES} bytes.")
    bits: list[int] = []
    for byte in token:
        for bit in range(7, -1, -1):
            bits.append((byte >> bit) & 1)
    return bits


def bits_to_token(bits: list[int]) -> bytes:
    if len(bits) != HENV_BIT_COUNT:
        raise ValueError(f"Expected {HENV_BIT_COUNT} bits.")
    out = bytearray(HENV_TOKEN_BYTES)
    for b in range(HENV_TOKEN_BYTES):
        byte = 0
        for bit in range(8):
            v = bits[b * 8 + bit]
            if v not in (0, 1):
                raise ValueError("Bits must be 0 or 1.")
            byte = (byte << 1) | v
        out[b] = byte
    return bytes(out)


def token_to_hex(token: bytes) -> str:
    return token.hex()
