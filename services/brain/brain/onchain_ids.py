"""
ON-CHAIN IDS IN TEXT, by shape.

The detector from packages/core/src/ids.ts (`onchainIdsIn`), mirrored here
because Brain cannot import TypeScript.

THE SAME RULE, pattern for pattern:

  EVM      0x + 40 hex (an address) or 0x + 64 hex (a hash), not inside more hex.

The shape is enough; a match is never checked against a chain.

tests/data/onchain_ids.json pins this file and ids.ts to the same answers: CI's
brain job asserts it here, through tests/test_onchain_ids.py, and its app tests
assert it for ids.ts.

Pure and self-contained: no I/O, no dependency.
"""

from __future__ import annotations

import re
from typing import Literal, NamedTuple


class OnchainIdHit(NamedTuple):
    family: Literal["evm"]
    #: "address" (a 20-byte id) or "hash" (a 32-byte hash).
    shape: Literal["address", "hash"]
    value: str


_EVM_IN_TEXT = re.compile(r"0x[0-9a-fA-F]{64}(?![0-9a-fA-F])|0x[0-9a-fA-F]{40}(?![0-9a-fA-F])")


def onchain_ids_in(text: object) -> list[OnchainIdHit]:
    """Every on-chain id in a text, in ids.ts order: EVM addresses and hashes."""
    if not isinstance(text, str) or not text:
        return []
    return [OnchainIdHit("evm", "hash" if len(m[0]) == 66 else "address", m[0]) for m in _EVM_IN_TEXT.finditer(text)]


def onchain_id_in(text: object) -> bool:
    """Whether a text carries any on-chain id (onchain_ids_in)."""
    return bool(onchain_ids_in(text))
