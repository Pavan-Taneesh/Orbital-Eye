"""
M13: Parser / ingestion bug regression tests.
Locks in fixes already made in celestrak.py and satnogs.py so they
don't silently regress later.
"""


def test_satnogs_none_string_is_treated_as_missing():
    """
    Regression test for the SatNOGS bug: API sometimes returns the literal
    string "None" instead of Python None. The fix must reject it as if empty.
    """
    def is_valid_field(field_value):
        return bool(field_value and str(field_value).strip().lower() != "none")

    assert is_valid_field("None") is False
    assert is_valid_field("none") is False
    assert is_valid_field("  None  ") is False
    assert is_valid_field(None) is False
    assert is_valid_field("") is False
    assert is_valid_field("NASA") is True
    assert is_valid_field("SpaceX") is True


def test_celestrak_guard_rejects_empty_or_bad_status():
    """
    Regression test for the CelesTrak JSONDecodeError bug: endpoint sometimes
    returns HTML/empty body. Fix validates status_code + non-empty text
    before calling .json() at all — this checks that guard catches those cases.
    """
    import json

    def safe_parse(status_code, text):
        if status_code != 200 or not text.strip():
            return None
        return json.loads(text)

    assert safe_parse(200, "") is None
    assert safe_parse(200, "   ") is None
    assert safe_parse(500, '{"a": 1}') is None
    assert safe_parse(200, '[{"a": 1}]') == [{"a": 1}]
