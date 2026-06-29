"""
Loads TalentSift-AI settings from config.yaml at the project root.
Access via: from app.config import config
"""
from dataclasses import dataclass
from pathlib import Path
import yaml

# Always resolve relative to this file's location (project_root/app/config.py)
_CONFIG_PATH = Path(__file__).parent.parent / "config.yaml"


@dataclass
class BackendConfig:
    host: str
    port: int
    reload: bool
    debug: bool


@dataclass
class DatabaseConfig:
    url: str


@dataclass
class SecurityConfig:
    secret_key: str
    algorithm: str
    access_token_expire_minutes: int


@dataclass
class OllamaConfig:
    base_url: str


@dataclass
class FrontendConfig:
    port: int
    api_base_url: str


@dataclass
class AppConfig:
    backend: BackendConfig
    database: DatabaseConfig
    security: SecurityConfig
    ollama: OllamaConfig
    frontend: FrontendConfig


def _load() -> AppConfig:
    if not _CONFIG_PATH.exists():
        raise FileNotFoundError(
            f"config.yaml not found at {_CONFIG_PATH}. "
            "Make sure you run the application from the project root."
        )
    with open(_CONFIG_PATH, "r") as f:
        data = yaml.safe_load(f)

    return AppConfig(
        backend=BackendConfig(**data["backend"]),
        database=DatabaseConfig(**data["database"]),
        security=SecurityConfig(**data["security"]),
        ollama=OllamaConfig(**data["ollama"]),
        frontend=FrontendConfig(**data["frontend"]),
    )


# Singleton — imported once, shared across all modules
config: AppConfig = _load()
