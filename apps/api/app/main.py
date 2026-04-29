from fastapi import FastAPI

from app.config import settings

app = FastAPI(title="semper-api")


@app.get("/health")
def health():
    return {"status": "ok", "env": settings.environment}
