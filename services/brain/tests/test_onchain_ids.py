"""
ON-CHAIN IDS IN THE BACKSTOP: the detector gives the same answers as
packages/core/src/ids.ts, case for case, from a fixture both languages read,
and `_reject_executable` refuses an address or calldata in every field it
screens, model output and desk-policy input alike.

No model is called and nothing leaves the process.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from brain.onchain_ids import onchain_id_in, onchain_ids_in
from brain.schemas import BrainDecision, Cost, DeskAnalysis, Evidence

from test_prompt_snapshot import pulse_memecoin

CASES = json.loads((Path(__file__).resolve().parent / "data" / "onchain_ids.json").read_text(encoding="utf-8"))["cases"]


def test_the_shared_cases_are_there():
    # An empty list would parametrize into one skip, and a skip is green.
    assert len(CASES) >= 10


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["text"][:40] or "empty")
def test_the_detector_answers_as_ids_ts_does(case):
    got = [h._asdict() for h in onchain_ids_in(case["text"])]
    assert got == case["hits"]
    assert onchain_id_in(case["text"]) is bool(case["hits"])


def test_anything_but_text_is_no_hit():
    assert onchain_ids_in(None) == [] and onchain_ids_in(42) == [] and onchain_ids_in(["x"]) == []


def _decision(**over) -> dict:
    base = dict(
        decision_id="dec_1", agent_id="agent-a", created_at=1, action="hold", instrument_id="agentcap:meme",
        symbol="MEME", confidence=0.5, suggested_delta_usdg=0, thesis="Buys are thinning into strength.",
        tier="pulse", cost=Cost(model_calls=0, tokens_in=0, tokens_out=0, usd=0.0),
    )
    return {**base, **over}


@pytest.mark.parametrize("text", [
    "PEPE pumped 40% on the week; 41 buys / 22 sells from 37 distinct buyers.",
    "Held MEME for 20 minutes; exited flat after volume faded.",
    "[ref:d3fa91cr2c1] reports two tracked wallets added",
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "supercalifragilisticexpialidociousandmorewordsjoined",
    "read https://x.com/agentcap/status/1845123456789012345",
])
def test_prose_still_passes(text):
    d = BrainDecision(**_decision(thesis=text, risks=[text], evidence=[Evidence(source="s", ref=text, claim=text)]))
    assert d.thesis == text
    assert pulse_memecoin(strategy_terms=text).strategy_terms == text


@pytest.mark.parametrize("text,why", [
    ("route via 0x" + "ab" * 20, "contains an address-shaped string"),
    ("calldata 0xdeadbeefcafebabe00", "contains a hex blob that could be calldata"),
])
def test_every_evm_refusal_keeps_its_words(text, why):
    with pytest.raises(ValidationError) as e:
        BrainDecision(**_decision(thesis=text))
    msg = e.value.errors()[0]["msg"]
    assert msg.startswith(f"Value error, field {why}"), msg


def test_a_desk_read_and_policy_carrying_an_address_are_refused():
    good = dict(
        read="price is holding above the 0.0041 level after a 12% push, but volume has faded.",
        stance="cautious", watch="whether 0.0041 holds", invalidation="an hourly close under 0.0036",
        confidence=0.6,
    )
    DeskAnalysis(**good)
    bad = " 0x" + "ab" * 20
    for field in ("read", "watch", "invalidation"):
        with pytest.raises(ValidationError):
            DeskAnalysis(**dict(good, **{field: good[field] + bad}))
    with pytest.raises(ValidationError, match="address-shaped"):
        pulse_memecoin(strategy_terms=f"Route via{bad}.")
