# Naver Keyword Collector

네이버 검색광고 API로 연관키워드·검색량·경쟁도를 수집하고, 점수식으로 황금키워드를 자동 선별해 주간 CSV로 출력하는 파이프라인.

GitHub Actions가 **매주 월요일 오전 9시(KST)**에 자동 실행합니다.

## 파일 구조

```
naver-keyword-collector/
├── naver_keywords.py          # 메인 스크립트
├── test_naver_keywords.py     # 단위 테스트
├── seeds.txt                  # 시드 키워드 목록 (한 줄에 하나)
├── requirements.txt
├── .github/workflows/
│   └── keywords.yml           # GitHub Actions 워크플로
└── output/                    # CSV 저장 폴더 (자동 생성, git 추적 제외)
```

## 환경 설정

### 1. 의존성 설치

```bash
pip install -r requirements.txt
```

### 2. 환경변수 설정

프로젝트 루트에 `.env` 파일 생성 (git에 커밋하지 말 것):

```
NAVER_API_KEY=발급받은_API_KEY
NAVER_SECRET_KEY=발급받은_SECRET_KEY
NAVER_CUSTOMER_ID=검색광고_고객ID
```

> API 키는 [네이버 검색광고](https://searchad.naver.com) → 설정 → API 관리에서 발급.

### 3. 시드 키워드 설정

`seeds.txt`에 수집을 시작할 키워드를 한 줄에 하나씩 입력:

```
다이어트
헬스
운동화
```

### 4. 실행

```bash
python naver_keywords.py
```

`output/keywords_YYYY-MM-DD.csv` 파일이 생성됩니다.

## 점수식

```
score = (PC월간검색량 + 모바일월간검색량) / (경쟁도지수 + 1)
```

| 경쟁도 | 지수 |
|--------|------|
| 낮음   | 1    |
| 보통   | 2    |
| 높음   | 3    |

`RISK_TERMS`(도박·불법·성인·마약·사기)가 포함된 키워드는 score = 0으로 처리됩니다.

## GitHub Actions 자동화

1. 저장소 → **Settings → Secrets and variables → Actions**에서 아래 시크릿 등록:
   - `NAVER_API_KEY`
   - `NAVER_SECRET_KEY`
   - `NAVER_CUSTOMER_ID`

2. 워크플로는 매주 월요일 00:00 UTC(= 09:00 KST)에 실행되며, 결과 CSV는 Actions 아티팩트로 90일간 보관됩니다.

3. 수동 실행: **Actions → Naver Keyword Collector → Run workflow**

## 테스트

```bash
pip install pytest
pytest test_naver_keywords.py -v
```
