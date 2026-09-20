"""Verify the OpenAPI schema by starting the server and inspecting /openapi.json."""
import json
import subprocess
import sys
import time

# Start the server
cwd = r"C:\Users\suman\projects\Space-website\backend"
proc = subprocess.Popen(
    [sys.executable, "-m", "uvicorn", "main:app", "--port", "8000", "--host", "127.0.0.1"],
    cwd=cwd,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
)

# Wait for server to start
time.sleep(3)

# Fetch OpenAPI schema
try:
    import urllib.request
    req = urllib.request.Request("http://127.0.0.1:8000/openapi.json")
    with urllib.request.urlopen(req, timeout=5) as response:
        schema = json.loads(response.read().decode())
    print("OpenAPI schema fetched successfully!")
    print(f"Number of paths: {len(schema.get('paths', {}))}")

    # Check for key endpoints
    paths = schema.get("paths", {})
    expected_endpoints = [
        "/api/v1/health",
        "/api/v1/objects/search",
        "/api/v1/objects",
        "/api/v1/objects/{object_id}",
        "/api/v1/objects/{object_id}/state",
        "/api/v1/objects/{object_id}/diagnostics",
        "/api/v1/objects/{object_id}/media",
    ]

    print("\nEndpoint check:")
    for ep in expected_endpoints:
        exists = ep in paths
        status = "✓" if exists else "✗"
        print(f"  {status} {ep}")

    # Check request/response models for key endpoints
    print("\nModel validation:")

    # Check /health response model
    health_path = paths.get("/api/v1/health", {})
    health_get = health_path.get("get", {})
    health_resp = health_get.get("responses", {})
    print(f"  /health: {health_get}")

    # Check /media response model
    media_path = paths.get("/api/v1/objects/{object_id}/media", {})
    media_get = media_path.get("get", {})
    media_resp = media_get.get("responses", {})
    content = media_get.get("responses", {}).get("200", {}).get("content", {})
    print(f"  /media: produces = {list(content.keys()) if content else 'N/A'}")

    # Check /objects/{object_id} response model
    obj_path = paths.get("/api/v1/objects/{object_id}", {})
    obj_get = obj_path.get("get", {})
    obj_resp = obj_get.get("responses", {})
    obj_content = obj_get.get("responses", {}).get("200", {}).get("content", {})
    print(f"  /objects/{{object_id}}: produces = {list(obj_content.keys()) if obj_content else 'N/A'}")

    # Write schema to temp file for inspection
    with open("/tmp/openapi_schema.json", "w") as f:
        json.dump(schema, f, indent=2)
    print("\nFull schema saved to /tmp/openapi_schema.json")

except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
    print(f"\nError fetching OpenAPI schema: {e}")
    import traceback
    traceback.print_exc()

# Kill the server
proc.terminate()
proc.wait()
print(f"\nServer stopped (PID {proc.pid})")