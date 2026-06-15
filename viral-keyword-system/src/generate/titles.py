"""
Step 3: Generate golden titles using Claude API.
Passes all collected/analyzed data and gets back ranked title candidates.
"""

import os
import json
import logging
from datetime import datetime

import anthropic

logger = logging.getLogger(__name__)


SYSTEM_PROMPT = """당신은 써큐톡스(혈당·혈압·콜레스테롤 복합 영양제) 바이럴 마케팅 전문가입니다.
네이버 카페에서 9,121 조회수를 기록한 검증된 황금 공식을 기반으로 제목을 생성합니다.

## 황금 공식
황금 제목 = [구체 수치] × [증상 OR 검진 상황] × [약 들어가기 직전 절박감] × ["진짜"/"정말"/"다들" 같은 검증·공감 어휘] × [짧은 호흡 + 흘림체 어미] − [자기 제품명 노출] − [정돈된 기사체 문장]

## 7가지 트리거 (영향력 순)
1. 구체 수치 ★★★★★ (예: 138/89, 콜레스테롤 240, 공복혈당 118)
2. 검증 어휘 ★★★★★ (진짜, 정말, 실제로, 후기, 효과 본)
3. 증상→영양제 다리 ★★★★ (손발 저림, 발 차가움, 어지러움 + 영양제)
4. 성분명/경쟁 제품 거론 ★★★★ (클로렐라, Q10, 은행잎, 모나콜린K)
5. 다중 영양제 피로 ★★★ (4~5개씩, 시간차, 합쳐진)
6. 연령·세대 박기 ★★★ (30대인데, 40대 끝나가는데, 50대 직장인)
7. 감정 어휘 ★★★ (너무, 무서워요, 미치겠어요, 어떡해요)

## 금지 사항
- 써큐톡스 직접 언급 절대 금지
- "건강관리 어떻게 하세요?" 류 일반론 금지
- 25자 초과 금지 (트리거 3개 이상이면 30자까지 허용)
- 마침표·물음표로 끝나는 정돈된 문장 금지
- "알려드립니다", "추천드립니다" 정보 제공형 어미 금지
- [정보], [추천] 부캐 금지 ([질문], [고민]은 허용)

## 톤앤매너
- 카페 실제 회원이 쓴 것처럼
- 흘림체 어미 (ㅠ, ;;, …, ?ㅠ)
- 제목 15~25자 권장
- 짧은 호흡, 구어체

반드시 JSON 형식으로만 응답하세요."""

USER_PROMPT_TEMPLATE = """오늘 수집된 데이터를 분석해서 황금 제목 TOP 3와 시리즈화 후보 5개를 생성해주세요.

## 오늘 날짜
{today}

## 시즌 신호
{seasonal_signals}

## 카페 빈출 키워드 TOP 20
{top_keywords}

## 페인 게시글 샘플 (최근 7일 고신호 글)
{pain_posts}

## 급상승 키워드 (데이터랩)
{rising_keywords}

## 방송발 바이럴 영상
{viral_videos}

## 카페별 페인 요약
{cafe_summary}

위 데이터를 바탕으로 다음 JSON 형식으로 응답하세요:

{{
  "top3": [
    {{
      "rank": 1,
      "title": "제목",
      "total_score": 숫자,
      "track": "트랙명",
      "triggers": ["트리거1", "트리거2"],
      "data_evidence": "이 제목을 선정한 데이터 근거 (카페글 언급, 검색량 등)",
      "usp_connection": "써큐톡스 연결 포인트",
      "recommended_cafes": ["카페slug1", "카페slug2"]
    }}
  ],
  "series_candidates": [
    {{
      "title": "제목",
      "pattern": "어떤 패턴의 변형인지"
    }}
  ],
  "analysis_memo": "오늘 전체 트렌드 한 줄 요약"
}}

TOP 3는 반드시 서로 다른 트랙에서 선정하세요. 트리거는 최소 3개 이상 포함해야 합니다."""


def _format_top_keywords(top_kws: list[dict]) -> str:
    return "\n".join(
        f"- {item['keyword']}: {item['count']}회"
        for item in top_kws[:20]
    ) or "데이터 없음"


def _format_pain_posts(pain_posts: list[dict]) -> str:
    lines = []
    for p in pain_posts[:15]:
        line = f"- [{p.get('cafe', '?')}] {p.get('title', '')} (트랙: {p.get('track', '?')})"
        lines.append(line)
    return "\n".join(lines) or "데이터 없음"


def _format_rising_keywords(trends: dict[str, float]) -> str:
    rising = {k: v for k, v in trends.items() if v >= 30}
    if not rising:
        return "데이터 없음 (API 키 미설정 또는 수집 실패)"
    return "\n".join(
        f"- {kw}: {chg:+.0f}%"
        for kw, chg in sorted(rising.items(), key=lambda x: -x[1])
    )


def _format_viral_videos(videos: list[dict]) -> str:
    viral = [v for v in videos if v.get("is_viral")]
    if not viral:
        return "데이터 없음 (API 키 미설정 또는 수집 실패)"
    return "\n".join(
        f"- [{v['channel']}] {v['title']} (조회수: {v['views']:,})"
        for v in viral[:10]
    )


def _format_cafe_summary(cafe_summary: dict) -> str:
    lines = []
    for cafe, info in cafe_summary.items():
        top_track = max(info["tracks"], key=info["tracks"].get) if info["tracks"] else "?"
        lines.append(
            f"- **{cafe}**: 총 {info['count']}건, 주요 트랙: {top_track}\n"
            f"  샘플 제목: {info['top_titles'][0] if info['top_titles'] else '-'}"
        )
    return "\n".join(lines) or "데이터 없음"


def generate_golden_titles(
    analysis: dict,
    trends: dict[str, float],
    videos: list[dict],
    seasonal_signals: list[str],
) -> dict:
    """
    Call Claude API to generate golden titles.
    Returns parsed JSON response with top3 + series candidates.
    """
    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    if not api_key:
        logger.error("ANTHROPIC_API_KEY 미설정 → 제목 생성 불가")
        return _fallback_titles()

    client = anthropic.Anthropic(api_key=api_key)
    today = datetime.today().strftime("%Y년 %m월 %d일")

    user_prompt = USER_PROMPT_TEMPLATE.format(
        today=today,
        seasonal_signals="\n".join(f"- {s}" for s in seasonal_signals) or "특이 시즌 없음",
        top_keywords=_format_top_keywords(analysis.get("top_keywords", [])),
        pain_posts=_format_pain_posts(analysis.get("pain_posts", [])),
        rising_keywords=_format_rising_keywords(trends),
        viral_videos=_format_viral_videos(videos),
        cafe_summary=_format_cafe_summary(analysis.get("cafe_summary", {})),
    )

    logger.info("Claude API 호출 중 (제목 생성)...")
    try:
        message = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=2000,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_prompt}],
        )
        raw = message.content[0].text.strip()

        # Strip markdown code fence if present
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.strip()

        result = json.loads(raw)
        logger.info("제목 생성 완료: TOP3 %d개, 시리즈 후보 %d개",
                    len(result.get("top3", [])),
                    len(result.get("series_candidates", [])))
        return result

    except json.JSONDecodeError as e:
        logger.error("Claude 응답 JSON 파싱 실패: %s", e)
        logger.debug("Raw response: %s", raw[:500])
        return _fallback_titles()
    except anthropic.APIError as e:
        logger.error("Claude API 오류: %s", e)
        return _fallback_titles()


def _fallback_titles() -> dict:
    """Return placeholder when API fails."""
    return {
        "top3": [
            {
                "rank": 1,
                "title": "콜레스테롤 240 진짜 약 안먹고 잡으신 분 있어요",
                "total_score": 0,
                "track": "검진_결과",
                "triggers": ["구체_수치", "검증_어휘", "감정_어휘"],
                "data_evidence": "API 오류로 자동 생성 불가 — 기본 템플릿 반환",
                "usp_connection": "6중 복합 USP, 모나콜린K",
                "recommended_cafes": ["dangsamo", "pyurion"],
            }
        ],
        "series_candidates": [],
        "analysis_memo": "API 오류로 분석 불가. ANTHROPIC_API_KEY를 확인하세요.",
    }
