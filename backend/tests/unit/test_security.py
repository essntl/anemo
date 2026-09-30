from datetime import UTC, datetime, timedelta

from app.api.security import is_allowed_origin
from app.features.auth.models import AuthSession
from app.features.auth.service import has_recent_auth


def test_origin_rules():
    pub = "https://ai.example.com"
    assert is_allowed_origin(None, "anything", pub)
    assert is_allowed_origin("https://ai.example.com/x", "app:8080", pub)
    assert is_allowed_origin("http://localhost:8080", "localhost:8080", pub)
    assert not is_allowed_origin("https://evil.example", "ai.example.com", pub)
    assert not is_allowed_origin("https://ai.example.com.evil.io", "ai.example.com", pub)


def test_recent_auth_window():
    s = AuthSession(reauth_at=datetime.now(UTC) - timedelta(minutes=5))
    assert has_recent_auth(s)
    s.reauth_at = datetime.now(UTC) - timedelta(minutes=30)
    assert not has_recent_auth(s)
    s.reauth_at = None
    assert not has_recent_auth(s)
