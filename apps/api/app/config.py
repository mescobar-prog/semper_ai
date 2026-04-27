from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://semper:semper@db:5432/semper"
    api_secret_key: str = "dev-only-change-me"
    environment: str = "development"


settings = Settings()
