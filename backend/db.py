import os
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

# Only load .env if DB_HOST is not already set (e.g., by test configuration)
# This prevents test environment variables from being overridden
if not os.getenv("DB_HOST"):
    env_path = Path(__file__).resolve().parent / ".env"
    load_dotenv(dotenv_path=env_path, override=False)

def get_connection():
    return psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=os.getenv("DB_PORT", "5432"),
        dbname=os.getenv("DB_NAME", "project_db"),
        user=os.getenv("DB_USER", "postgres"),
        password=os.getenv("DB_PASSWORD", ""),
    )