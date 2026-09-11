"""AENV1 packet / CRC / convolutional / interleave Python reference."""

from __future__ import annotations

from dataclasses import dataclass

AENV_VERSION_SEED = 0x41454E56
PACKET_BITS = 72
TAIL_BITS = 6
CONV_INPUT_BITS = 78
CODED_BITS = 156
CONV_K = 7
G0 = 0o171
G1 = 0o133
NUM_STATES = 1 << (CONV_K - 1)


def xorshift32(seed: int):
    state = seed & 0xFFFFFFFF
    if state == 0:
        state = 0x9E3779B9

    def next_u32() -> int:
        nonlocal state
        state ^= (state << 13) & 0xFFFFFFFF
        state &= 0xFFFFFFFF
        state ^= state >> 17
        state &= 0xFFFFFFFF
        state ^= (state << 5) & 0xFFFFFFFF
        state &= 0xFFFFFFFF
        return state

    return next_u32


def next_int(rng, max_inclusive: int) -> int:
    span = max_inclusive + 1
    limit = (0x100000000 // span) * span
    v = rng()
    while v >= limit:
        v = rng()
    return v % span


def crc16_ccitt_false(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
    return crc


def _parity(x: int) -> int:
    v = x & 0x7F
    v ^= v >> 4
    v ^= v >> 2
    v ^= v >> 1
    return v & 1


def _outputs(state: int, bit: int) -> tuple[int, int]:
    window = ((bit & 1) << (CONV_K - 1)) | (state & (NUM_STATES - 1))
    return _parity(window & G0), _parity(window & G1)


def _next_state(state: int, bit: int) -> int:
    window = ((bit & 1) << (CONV_K - 1)) | (state & (NUM_STATES - 1))
    return window >> 1


def bytes_to_bits(data: bytes) -> list[int]:
    bits: list[int] = []
    for byte in data:
        for b in range(7, -1, -1):
            bits.append((byte >> b) & 1)
    return bits


def bits_to_bytes(bits: list[int], n: int) -> bytes:
    out = bytearray(n)
    for i in range(n):
        byte = 0
        for b in range(8):
            byte = (byte << 1) | (bits[i * 8 + b] & 1)
        out[i] = byte
    return bytes(out)


def conv_encode(packet_bits: list[int]) -> list[int]:
    if len(packet_bits) != PACKET_BITS:
        raise ValueError("expected 72 packet bits")
    inp = list(packet_bits) + [0] * TAIL_BITS
    out: list[int] = []
    state = 0
    for bit in inp:
        a, b = _outputs(state, bit)
        out.extend([a, b])
        state = _next_state(state, bit)
    if state != 0:
        raise RuntimeError("encoder did not terminate")
    if len(out) != CODED_BITS:
        raise RuntimeError("coded length")
    return out


def build_interleave():
    forward = list(range(CODED_BITS))
    rng = xorshift32(AENV_VERSION_SEED)
    for i in range(CODED_BITS - 1, 0, -1):
        j = next_int(rng, i)
        forward[i], forward[j] = forward[j], forward[i]
    inverse = [0] * CODED_BITS
    for i, v in enumerate(forward):
        inverse[v] = i
    checksum = 0
    for i, v in enumerate(forward):
        checksum = (checksum + (v + 1) * (i + 3)) & 0xFFFFFFFF
    return forward, inverse, checksum


INTERLEAVE_FORWARD, INTERLEAVE_INVERSE, INTERLEAVE_CHECKSUM = build_interleave()


def interleave(bits: list[int]) -> list[int]:
    return [bits[INTERLEAVE_FORWARD[i]] for i in range(CODED_BITS)]


def deinterleave(bits: list[int]) -> list[int]:
    out = [0] * CODED_BITS
    for i in range(CODED_BITS):
        out[INTERLEAVE_FORWARD[i]] = bits[i]
    return out


@dataclass
class EncodedPacket:
    token: bytes
    crc: int
    packet_bytes: bytes
    packet_bits: list[int]
    coded_bits: list[int]
    interleaved_bits: list[int]


def encode_aenv_packet(token: bytes) -> EncodedPacket:
    if len(token) != 7:
        raise ValueError("token must be 7 bytes")
    crc = crc16_ccitt_false(token)
    packet = token + bytes([(crc >> 8) & 0xFF, crc & 0xFF])
    packet_bits = bytes_to_bits(packet)
    coded = conv_encode(packet_bits)
    interleaved = interleave(coded)
    return EncodedPacket(
        token=token,
        crc=crc,
        packet_bytes=packet,
        packet_bits=packet_bits,
        coded_bits=coded,
        interleaved_bits=interleaved,
    )
