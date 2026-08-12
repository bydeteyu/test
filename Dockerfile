FROM mcr.microsoft.com/playwright/python:v1.60.0-jammy

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 5000

# Flask의 개발 서버(app.run())는 들어오는 요청마다 스레드를 무제한으로
# 새로 만든다. 폴링 요청이 몇 시간 쌓이거나 어딘가 하나 오래 걸리는
# 요청이 생기면 스레드가 계속 쌓여서 결국 "can't start new thread"로
# 메모리가 고갈되며 죽는다 (실제로 두 번 발생). gunicorn은 워커/스레드
# 개수에 상한을 두고, --timeout이 지나도 응답 없는 워커는 강제로
# 죽였다 재시작한다. JOBS 딕셔너리·APScheduler·모니터 파일 락이 전부
# 프로세스 하나의 메모리를 공유하는 구조라 --workers는 반드시 1이어야
# 하고, 동시 요청 처리는 --threads로만 한다.
CMD gunicorn --bind 0.0.0.0:${PORT:-5000} --workers 1 --threads 8 --worker-class gthread --timeout 120 --max-requests 500 --max-requests-jitter 50 app:app
