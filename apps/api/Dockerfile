# UBI9 Python — runs in FIPS mode when host kernel is FIPS-enabled.
FROM registry.access.redhat.com/ubi9/python-311:latest

WORKDIR /app

COPY pyproject.toml ./
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir .

COPY app ./app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
