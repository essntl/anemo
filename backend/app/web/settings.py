"""Settings > Web & Search (a security-sensitive section: the allowlist opens your
network to agents)."""

from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.core.config import get_settings


class WebSettings(BaseModel):
    # SearXNG instance for web search. Empty: SEARXNG_URL from the .env file.
    searxng_url: str = Field("", max_length=500)
    search_results: int = Field(8, ge=1, le=20)
    safesearch: Literal["off", "moderate", "strict"] = "moderate"
    language: str = Field("auto", max_length=20)  # "auto" or a code like "en" / "de-DE"
    # Hosts on your own network that agents may reach with web tools (hostnames, IP
    # addresses or CIDR ranges). Everything private is blocked otherwise.
    allowed_private_hosts: list[str] = Field(default_factory=list, max_length=100)

    @field_validator("searxng_url")
    @classmethod
    def _url(cls, v: str) -> str:
        v = v.strip().rstrip("/")
        if v and not v.startswith(("http://", "https://")):
            raise ValueError("must start with http:// or https://")
        return v

    @field_validator("allowed_private_hosts")
    @classmethod
    def _hosts(cls, v: list[str]) -> list[str]:
        from app.web.safe_http import parse_allowlist  # avoid an import cycle

        cleaned = [h.strip().lower() for h in v if h.strip()]
        parse_allowlist(cleaned)  # raises ValueError for malformed entries
        return cleaned

    def search_url(self) -> str:
        return self.searxng_url or (get_settings().searxng_url or "").strip().rstrip("/")
