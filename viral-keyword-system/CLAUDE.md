# 써큐톡스 황금 키워드 발굴 시스템

## 실행 방법

```bash
# 오늘 리포트 생성
python daily_keyword.py

# 특정 날짜
python daily_keyword.py --date 2026-06-15

# 수집 재실행 없이 캐시 재사용 (빠름)
python daily_keyword.py --skip-collect

# 상세 로그
python daily_keyword.py --verbose
```

출력: `output/YYYY-MM-DD.md`

## 환경 설정

`.env.example`을 `.env`로 복사 후 API 키 입력:
```bash
cp .env.example .env
# .env 파일 편집하여 키 입력
```

- `ANTHROPIC_API_KEY`: 필수 (제목 생성)
- `NAVER_CLIENT_ID` / `NAVER_CLIENT_SECRET`: 선택 (데이터랩 급상승 키워드)
- `YOUTUBE_API_KEY`: 선택 (방송발 트렌드)

## 의존성 설치

```bash
pip install -r requirements.txt
```

## 구조

```
viral-keyword-system/
├── daily_keyword.py        # 메인 진입점
├── config/
│   ├── seeds.json          # 시드 키워드 23개 + USP 매핑
│   ├── cafes.json          # 모니터링 카페 6곳
│   ├── channels.json       # 유튜브 채널 4곳
│   └── seasonal.json       # 월별 시즌 신호
├── src/
│   ├── collect/            # Step 1: 데이터 수집
│   │   ├── naver_cafe.py
│   │   ├── datalab.py
│   │   └── youtube.py
│   ├── analyze/            # Step 2: 분석
│   │   ├── keywords.py
│   │   └── scorer.py
│   ├── generate/           # Step 3: 제목 생성 (Claude API)
│   │   └── titles.py
│   └── report/             # Step 4: 마크다운 리포트
│       └── renderer.py
├── output/                 # 생성된 일일 리포트
└── .cache/                 # 수집 캐시 (--skip-collect용)
```

## /daily-keyword 스킬

이 프로젝트에서 `/daily-keyword` 명령을 실행하면:
```bash
python daily_keyword.py
```
