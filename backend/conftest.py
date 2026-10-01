
import sys
from pathlib import Path

# Add workspace root to sys.path so that 'backend' package imports work
workspace_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(workspace_root))

collect_ignore = ["db_test.py", "fetch_test.py"]