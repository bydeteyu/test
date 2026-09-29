import sys
from pathlib import Path

# Vercel에서 프로젝트 루트를 path에 추가
sys.path.insert(0, str(Path(__file__).parent.parent))

from web.app import app
