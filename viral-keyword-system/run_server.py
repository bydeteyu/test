#!/usr/bin/env python3
"""웹 대시보드 실행: python run_server.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

import uvicorn

if __name__ == "__main__":
    print("🌅 써큐톡스 황금 키워드 대시보드 시작")
    print("   브라우저에서 열기: http://localhost:8000")
    uvicorn.run("web.app:app", host="0.0.0.0", port=8000, reload=False)
