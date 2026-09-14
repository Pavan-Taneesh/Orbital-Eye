"""Start the FastAPI server for OpenAPI verification."""
import subprocess
import sys
import time

proc = subprocess.Popen(
    [sys.executable, "-m", "uvicorn", "main:app", "--port", "8000", "--host", "127.0.0.1"],
    cwd=r"C:\Users\suman\projects\Space-website\backend",
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
)

time.sleep(3)
print(f"Server started with PID {proc.pid}")

# Fetch OpenAPI schema
import json
import urllib.request

try:
    req = urllib.request.Request("http://127.0.0.1:8000/openapi.json")
    with urllib.request.urlopen(req, timeout=5) as response:
        schema = json.loads(response.read().decode())
    print(f"\nOpenAPI schema fetched successfully!")
    print(f"Number of paths: {len(schema.get('paths', {}))}")
    
    # Check for key endpoints
    paths = schema.get("paths", {})
    expected_endpoints = [
        "/api/v1/health",
        "/api/v1/objects/search",
        "/api/v1/objects",
        "/api/v1/objects/{{object_id}}",
        "/api/v1/objects/{{object_id}}/state",
        "/api/v1/objects/{{object_id}}/diagnostics",
        "/api/v1/objects/{{object_id}}/media",
    ]
    
    for ep in expected_endpoints:
        exists = ep in paths
        status = "✓" if exists else "✗"
        print(f"  {status} {ep}")
    
    # Write schema to temp file for inspection
    with open("/tmp/openapi_schema.json", "w") as f:
        json.dump(schema, f, indent=2)
    print("\nSchema saved to /tmp/openapi_schema.json")
    
except Exception as e:
    print(f"\nError fetching OpenAPI schema: {e}")

# Kill the server after 15 seconds
import subprocess
proc.terminate()
proc.wait()
print(f"\nServer stopped (PID {proc.pid})")