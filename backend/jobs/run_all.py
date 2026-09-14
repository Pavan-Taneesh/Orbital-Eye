import subprocess
import sys
from datetime import datetime

# Scripts to run in order — ingestion first, resolver last
SCRIPTS = [
    "ingestion/celestrak.py",
    "ingestion/satnogs.py",
    "ingestion/spacetrack.py",
    "ingestion/discos.py",
    "logic/resolve_conflicts.py",
]

LOG_FILE = "jobs/run_log.txt"

def log(message):
    timestamp = datetime.now().isoformat()
    line = f"[{timestamp}] {message}"
    print(line)
    with open(LOG_FILE, "a") as f:
        f.write(line + "\n")

log("=== Starting full ingestion run ===")

for script in SCRIPTS:
    log(f"Running {script}...")
    result = subprocess.run([sys.executable, script], capture_output=True, text=True)

    if result.returncode == 0:
        log(f"{script} SUCCESS")
    else:
        log(f"{script} FAILED — {result.stderr.strip()[:300]}")

log("=== Run complete ===")
