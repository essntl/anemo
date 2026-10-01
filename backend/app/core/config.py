"""Process configuration, read once from environment variables.

Only deployment-level values live here (connection strings, secrets, paths).
User-editable preferences live in the database (`app_settings`) and are
managed through the Settings API instead.
"""

from functools import lru_cache
from typing import Literal

from pydantic import SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    env: Literal["production", "development", "test"] = "production"
    log_level: str = "INFO"

    database_url: str = "postgresql+asyncpg://aiw:aiw@postgres:5432/aiw"
    redis_url: str = "redis://valkey:6379/0"

    # Master key for encrypting secrets at rest and signing nothing else.
    app_secret_key: SecretStr = SecretStr("")

    # Single-user credentials. Prefer the argon2 hash; plaintext is accepted with a warning.
    admin_username: str = "admin"
    admin_password_hash: SecretStr | None = None
    admin_password: SecretStr | None = None

    public_url: str = "http://localhost:8080"
    cookie_secure: bool = True
    session_days: int = 30
    trusted_proxies: str = ""
    tz: str = "UTC"

    workspace_path: str = "/workspace"
    data_path: str = "/data"
    static_dir: str = "/app/static"

    worker_concurrency: int = 4
    enable_fake_provider: bool = False
    searxng_url: str | None = None

    # Shell sandboxes (worker only): execd URLs and the token files they write.
    sandbox_url: str = "http://sandbox:7070"
    sandbox_net_url: str = "http://sandbox-net:7070"
    sandbox_token_file: str = "/run/sandbox-token/sandbox/token"  # noqa: S105 (a path)
    sandbox_net_token_file: str = "/run/sandbox-token/sandbox-net/token"  # noqa: S105
    sandbox_ssh_dir: str = "/run/sandbox-ssh"  # app: the agents' SSH key (public half shown)

    # Local MCP servers run in the optional mcp-host container (worker only).
    mcp_host_url: str = "http://mcp-host:7080"
    mcp_host_token_file: str = "/run/mcp-host-token/token"  # noqa: S105 (a path)

    @model_validator(mode="after")
    def _check_secret_key(self) -> "Settings":
        if self.env != "test" and len(self.app_secret_key.get_secret_value()) < 32:
            raise ValueError(
                "APP_SECRET_KEY must be set to at least 32 characters "
                "(generate one with: openssl rand -hex 32)"
            )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
