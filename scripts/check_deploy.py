"""Build gate for hosted deployments. Never test against the live database."""
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
environment = os.environ.copy()
for key in ['BOARD_ORIGIN', 'RENDER_EXTERNAL_URL', 'BOARD_COOKIE_SECURE', 'BOARD_DATA_DIR', 'BOARD_PASSWORD',
            'BOARD_DATABASE_MODE', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN']:
    environment.pop(key, None)
result = subprocess.run([sys.executable, '-B', '-m', 'unittest', 'discover', '-s', 'tests', '-v'],
                        cwd=root, env=environment)
raise SystemExit(result.returncode)
