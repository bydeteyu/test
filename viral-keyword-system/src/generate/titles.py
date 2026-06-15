"""
Step 3: Generate golden titles.

Primary:  Claude API (claude-sonnet-4-6) — requires ANTHROPIC_API_KEY
Fallback: Rule-based generator using golden formula templates
          (works with zero API keys, uses collected data signals)
"""

import os
import json
import random
import logging
from datetime import datetime

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


# ── 규칙 기반 폴백 ────────────────────────────────────────────────────────────

# Templates: {수치}, {검증어}, {감정어} are filled from collected signals
_TEMPLATES = [
    # 트랙: 검진_결과
    {
        "template": "{검증어} {수치_콜} 약 안먹고 잡으신 분 있어요",
        "track": "검진_결과",
        "triggers": ["구체_수치", "검증_어휘", "감정_어휘"],
        "cafes": ["dangsamo", "pyurion", "thyroidcancers"],
        "usp": "6중 복합 USP, 모나콜린K 직격",
    },
    {
        "template": "공복혈당 {수치_혈당} {감정어} 어떡하죠 ㅠ",
        "track": "검진_결과",
        "triggers": ["구체_수치", "감정_어휘", "검증_어휘"],
        "cafes": ["dangsamo", "t1d"],
        "usp": "혈당 조절 6중 복합 USP",
    },
    {
        "template": "LDL {수치_LDL} 나온 {연령} 영양제 뭐 드세요",
        "track": "검진_결과",
        "triggers": ["구체_수치", "연령_세대", "다중영양제_피로"],
        "cafes": ["dangsamo", "pyurion", "cantsb"],
        "usp": "모나콜린K + 6중 복합",
    },
    # 트랙: 몸의_신호
    {
        "template": "손발 저림 {감정어} 심해져서 영양제 알아보는데요",
        "track": "몸의_신호",
        "triggers": ["증상_영양제_다리", "감정_어휘", "다중영양제_피로"],
        "cafes": ["dangsamo", "cantsb", "thyroidcancers"],
        "usp": "은행잎 + Q10 말초순환",
    },
    {
        "template": "{연령} 발 차가움 + 어지러움 {검증어} 혈관 문제일까요",
        "track": "몸의_신호",
        "triggers": ["증상_영양제_다리", "연령_세대", "검증_어휘"],
        "cafes": ["dangsamo", "cantsb"],
        "usp": "은행잎 + 바나바잎 혈행",
    },
    # 트랙: 약_치료
    {
        "template": "영양제 {개수} 먹는데 {검증어} 이래도 되나요 ;;",
        "track": "약_치료",
        "triggers": ["다중영양제_피로", "검증_어휘", "감정_어휘"],
        "cafes": ["dangsamo", "pyurion", "rksghwhantk"],
        "usp": "6중 복합 = 여러 개 대체",
    },
    {
        "template": "Q10이랑 은행잎 같이 먹어도 되나요 {감정어}",
        "track": "약_치료",
        "triggers": ["성분명_경쟁제품", "감정_어휘", "다중영양제_피로"],
        "cafes": ["dangsamo", "pyurion"],
        "usp": "모나콜린K + Q10 + 은행잎 복합",
    },
    # 트랙: 가족력_효심
    {
        "template": "부모님 콜레스테롤 {수치_콜} 나오셨는데 영양제 {검증어} 효과 있나요",
        "track": "가족력_효심",
        "triggers": ["구체_수치", "검증_어휘", "증상_영양제_다리"],
        "cafes": ["dangsamo", "thyroidcancers"],
        "usp": "6중 복합 USP",
    },
]

_NUMBERS = {
    "수치_콜": ["230", "235", "240", "245", "250", "260"],
    "수치_혈당": ["108", "112", "115", "118", "120", "125"],
    "수치_LDL": ["140", "145", "150", "155", "160", "165"],
    "연령": ["30대인데", "40대인데", "50대인데", "40대 후반인데"],
    "검증어": ["진짜", "정말", "실제로"],
    "감정어": ["너무", "진짜 무서워서", "좀"],
    "개수": ["4~5개", "5~6개", "4개"],
}


def _fill_template(tmpl: str, rising_keywords: dict) -> str:
    """Fill template variables with numbers/words."""
    result = tmpl
    for key, choices in _NUMBERS.items():
        placeholder = "{" + key + "}"
        if placeholder in result:
            # Prefer keywords with high search volume
            if key == "수치_콜" and rising_keywords:
                # Try to pick a number matching a rising keyword
                for kw in rising_keywords:
                    import re
                    m = re.search(r"\d{3}", kw)
                    if m and "콜레스테롤" in kw:
                        result = result.replace(placeholder, m.group())
                        break
                else:
                    result = result.replace(placeholder, random.choice(choices))
            else:
                result = result.replace(placeholder, random.choice(choices))
    return result


def _rule_based_titles(
    analysis: dict,
    trends: dict,
    videos: list,
    seasonal_signals: list,
) -> dict:
    """
    Generate titles using golden formula templates.
    Used when ANTHROPIC_API_KEY is not set.
    """
    top_keywords = {item["keyword"]: item["count"] for item in analysis.get("top_keywords", [])}
    rising = {k: v for k, v in trends.items() if v >= 20}

    # Sort templates by relevance to today's collected keywords
    def relevance(tmpl_def):
        score = 0
        for kw in top_keywords:
            if any(w in kw for w in ["콜레스테롤", "LDL", "혈당", "혈압"]):
                if "검진" in tmpl_def["track"]:
                    score += top_keywords[kw]
        return score

    sorted_templates = sorted(_TEMPLATES, key=relevance, reverse=True)

    # Pick 3 from different tracks
    top3 = []
    used_tracks = set()
    for tmpl_def in sorted_templates:
        if tmpl_def["track"] in used_tracks:
            continue
        if len(top3) >= 3:
            break

        title = _fill_template(tmpl_def["template"], rising)
        trigger_count = len(tmpl_def["triggers"])
        score = trigger_count + (3 if rising else 0) + (2 if seasonal_signals else 0)

        evidence_parts = []
        if rising:
            top_rising = sorted(rising.items(), key=lambda x: -x[1])[:2]
            evidence_parts.append(
                "급상승 키워드: " + ", ".join(f"{k}(+{v:.0f}%)" for k, v in top_rising)
            )
        if analysis.get("pain_posts"):
            evidence_parts.append(f"카페 페인 게시글 {len(analysis['pain_posts'])}건 분석")
        if seasonal_signals:
            evidence_parts.append("시즌: " + seasonal_signals[0])
        if not evidence_parts:
            evidence_parts.append("황금 공식 템플릿 기반 생성 (카페 데이터 없음)")

        top3.append({
            "rank": len(top3) + 1,
            "title": title,
            "total_score": score,
            "track": tmpl_def["track"],
            "triggers": tmpl_def["triggers"],
            "data_evidence": " | ".join(evidence_parts),
            "usp_connection": tmpl_def["usp"],
            "recommended_cafes": tmpl_def["cafes"],
        })
        used_tracks.add(tmpl_def["track"])

    # Series candidates: vary numbers on top template
    series = []
    if top3:
        base_track = [t for t in sorted_templates if t["track"] == top3[0]["track"]]
        for alt_num in _NUMBERS.get("수치_콜", [])[:5]:
            if len(series) >= 5:
                break
            alt_title = _fill_template(
                sorted_templates[0]["template"].replace("{수치_콜}", alt_num),
                {}
            )
            series.append({
                "title": alt_title,
                "pattern": f"수치만 변경 ({alt_num}) — 동일 황금 공식 구조",
            })

    memo = "규칙 기반 생성 (ANTHROPIC_API_KEY 미설정). 카페 데이터 수집 후 Claude API로 실행 시 정밀도 향상."
    if rising:
        top_k = sorted(rising.items(), key=lambda x: -x[1])[0]
        memo = f"오늘 최고 급상승: '{top_k[0]}' (+{top_k[1]:.0f}%). 규칙 기반 생성."
    if seasonal_signals:
        memo += f" 시즌 신호: {seasonal_signals[0]}"

    return {"top3": top3, "series_candidates": series, "analysis_memo": memo}


# ── 포맷 헬퍼 ────────────────────────────────────────────────────────────────

def _fmt_top_keywords(top_kws: list) -> str:
    return "\n".join(f"- {i['keyword']}: {i['count']}회" for i in top_kws[:20]) or "데이터 없음"


def _fmt_pain_posts(pain_posts: list) -> str:
    lines = [
        f"- [{p.get('cafe','?')}] {p.get('title','')} (트랙: {p.get('track','?')})"
        for p in pain_posts[:15]
    ]
    return "\n".join(lines) or "데이터 없음"


def _fmt_rising(trends: dict) -> str:
    rising = {k: v for k, v in trends.items() if v >= 30}
    if not rising:
        return "데이터 없음 (API 키 미설정 또는 수집 실패)"
    return "\n".join(
        f"- {kw}: {chg:+.0f}%"
        for kw, chg in sorted(rising.items(), key=lambda x: -x[1])
    )


def _fmt_videos(videos: list) -> str:
    viral = [v for v in videos if v.get("is_viral")]
    if not viral:
        return "데이터 없음 (API 키 미설정 또는 수집 실패)"
    return "\n".join(
        f"- [{v['channel']}] {v['title']} (조회수: {v['views']:,})"
        for v in viral[:10]
    )


def _fmt_cafe_summary(cafe_summary: dict) -> str:
    lines = []
    for cafe, info in cafe_summary.items():
        top_track = max(info["tracks"], key=info["tracks"].get) if info["tracks"] else "?"
        lines.append(
            f"- **{cafe}**: {info['count']}건, 주요 트랙: {top_track}\n"
            f"  샘플: {info['top_titles'][0] if info['top_titles'] else '-'}"
        )
    return "\n".join(lines) or "데이터 없음"


# ── 메인 함수 ─────────────────────────────────────────────────────────────────

def generate_golden_titles(
    analysis: dict,
    trends: dict,
    videos: list,
    seasonal_signals: list,
) -> dict:
    """
    Generate golden titles. Uses Claude API if ANTHROPIC_API_KEY is set,
    falls back to rule-based generation otherwise.
    """
    api_key = os.getenv("ANTHROPIC_API_KEY", "")

    if not api_key:
        logger.warning(
            "ANTHROPIC_API_KEY 미설정 → 규칙 기반 제목 생성으로 전환.\n"
            "  정밀한 제목 생성을 위해 .env 파일에 ANTHROPIC_API_KEY를 입력하세요.\n"
            "  API 키 발급: https://console.anthropic.com"
        )
        return _rule_based_titles(analysis, trends, videos, seasonal_signals)

    try:
        import anthropic
    except ImportError:
        logger.error("anthropic 패키지 미설치: pip install anthropic")
        return _rule_based_titles(analysis, trends, videos, seasonal_signals)

    client = anthropic.Anthropic(api_key=api_key)
    today = datetime.today().strftime("%Y년 %m월 %d일")

    user_prompt = USER_PROMPT_TEMPLATE.format(
        today=today,
        seasonal_signals="\n".join(f"- {s}" for s in seasonal_signals) or "특이 시즌 없음",
        top_keywords=_fmt_top_keywords(analysis.get("top_keywords", [])),
        pain_posts=_fmt_pain_posts(analysis.get("pain_posts", [])),
        rising_keywords=_fmt_rising(trends),
        viral_videos=_fmt_videos(videos),
        cafe_summary=_fmt_cafe_summary(analysis.get("cafe_summary", {})),
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

        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.strip()

        result = json.loads(raw)
        logger.info(
            "제목 생성 완료: TOP3 %d개, 시리즈 후보 %d개",
            len(result.get("top3", [])),
            len(result.get("series_candidates", [])),
        )
        return result

    except json.JSONDecodeError as e:
        logger.error("Claude 응답 JSON 파싱 실패: %s", e)
        return _rule_based_titles(analysis, trends, videos, seasonal_signals)
    except Exception as e:
        logger.error("Claude API 오류: %s", e)
        return _rule_based_titles(analysis, trends, videos, seasonal_signals)
