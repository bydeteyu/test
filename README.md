# 네이버 카페글 수집기 — 웹 어드민

## 설치

```bash
pip install -r requirements.txt
playwright install chromium
```

## 실행

```bash
python app.py
```

브라우저에서 http://localhost:5000 접속

## 사용법

1. 검색 키워드를 한 줄에 하나씩 (또는 콤마로 구분) 입력
2. **검색 시작** 클릭
3. 수집 완료 후 결과 테이블 확인
4. **엑셀 다운로드** 버튼으로 CSV 저장

> `output/` 폴더에 키워드별 CSV 파일이 저장됩니다.
