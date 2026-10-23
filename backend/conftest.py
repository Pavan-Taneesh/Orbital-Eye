
import os
import sys
from pathlib import Path

# Add workspace root to sys.path so that 'backend' package imports work
workspace_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(workspace_root))

# Set test environment to connect to PostgreSQL on host (via Docker port mapping)
# Tests run outside Docker, so they need localhost:5433 instead of postgres:5432
os.environ.setdefault("DB_HOST", "localhost")
os.environ.setdefault("DB_PORT", "5433")
os.environ.setdefault("DB_NAME", "project_db")
os.environ.setdefault("DB_USER", "postgres")
os.environ.setdefault("DB_PASSWORD", "SpaceDB@2026")

collect_ignore = ["db_test.py", "fetch_test.py"]