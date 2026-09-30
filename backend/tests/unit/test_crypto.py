import pytest

from app.core import crypto


def test_round_trip():
    ct = crypto.encrypt("sk-live-123456")
    assert b"sk-live" not in ct
    assert crypto.decrypt(ct) == "sk-live-123456"


def test_ciphertext_is_randomized():
    assert crypto.encrypt("same") != crypto.encrypt("same")


def test_wrong_key_fails_clearly(monkeypatch):
    ct = crypto.encrypt("secret")
    other_key = crypto._derive_key("a-completely-different-master-key-000", b"secrets-v1")
    other = crypto.Fernet(other_key)
    monkeypatch.setattr(crypto, "_fernet", lambda: other)
    with pytest.raises(crypto.DecryptionError):
        crypto.decrypt(ct)
