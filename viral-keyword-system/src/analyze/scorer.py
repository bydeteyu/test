"""
써큐톡스 USP 매칭 점수 산정 및 시즌성 주입.
"""

import json
import logging
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

CONFIG_DIR = Path(__file__).parent.parent.parent / "config"


def load_seasonal_signals(month: int) -> list[str]:
    """Return seasonal keyword signals for given month."""
    try:
        data = json.loads((CONFIG_DIR / "seasonal.json").read_text(encoding="utf-8"))
        signals = data.get("seasonal_signals", {}).get(str(month), [])
        # Add quarter-end signal
        if month in data.get("quarterly_end_months", []):
            signals.append(data.get("quarter_end_signal", ""))
        return [s for s in signals if s]
    except Exception as e:
        logger.warning("시즌성 데이터 로드 실패: %s", e)
        return []


def score_keyword(keyword: str, seeds_config: dict) -> dict:
    """
    Score a keyword against 써큐톡스 USP.
    Returns {score, breakdown}.
    """
    usp = seeds_config.get("usp_keywords", {})
    score = 0
    breakdown = {}

    multi = usp.get("multi_complex", [])
    multi_hits = [w for w in multi if w in keyword]
    if len(multi_hits) >= 2:
        score += 4
        breakdown["6중복합_USP"] = f"+4 ({', '.join(multi_hits)})"

    ingredients = usp.get("ingredients", [])
    ing_hits = [w for w in ingredients if w in keyword]
    if ing_hits:
        score += 3
        breakdown["핵심성분"] = f"+3 ({', '.join(ing_hits)})"

    ages = usp.get("age_targets", [])
    age_hits = [w for w in ages if w in keyword]
    if age_hits:
        score += 2
        breakdown["타겟연령"] = f"+2 ({', '.join(age_hits)})"

    verif = usp.get("verification", [])
    ver_hits = [w for w in verif if w in keyword]
    if ver_hits:
        score += 1
        breakdown["검증욕구"] = f"+1 ({', '.join(ver_hits)})"

    return {"score": min(score, 10), "breakdown": breakdown}


TRIGGERS = {
    "구체_수치": {
        "weight": 5,
        "patterns": [r"\d{2,3}\/\d{2,3}", r"\d{3}", r"공복혈당\s*\d+", r"LDL\s*\d+"],
        "keywords": [],
    },
    "검증_어휘": {
        "weight": 5,
        "patterns": [],
        "keywords": ["진짜", "정말", "실제로", "후기", "효과 본", "솔직히", "효과본"],
    },
    "증상_영양제_다리": {
        "weight": 4,
        "patterns": [],
        "keywords": ["저림", "차가움", "어지러움", "저리", "무기력", "눈침침", "피로", "붓기"],
    },
    "성분명_경쟁제품": {
        "weight": 4,
        "patterns": [],
        "keywords": ["클로렐라", "Q10", "코엔자임", "은행잎", "모나콜린", "바나바", "누트리코어", "동화약품"],
    },
    "다중영양제_피로": {
        "weight": 3,
        "patterns": [],
        "keywords": ["4개", "5개", "6개", "시간차", "합쳐진", "통합", "종류별", "여러개"],
    },
    "연령_세대": {
        "weight": 3,
        "patterns": [r"[3-6]0대"],
        "keywords": ["30대", "40대", "50대", "60대", "직장인", "중년", "갱년기"],
    },
    "감정_어휘": {
        "weight": 3,
        "patterns": [],
        "keywords": ["너무", "무서워", "어떡해", "미치겠", "ㅠ", ";;", "걱정돼", "불안", "무섭"],
    },
}

FORBIDDEN_PATTERNS = [
    "써큐톡스",
    "건강관리 어떻게",
    "알려드립니다",
    "추천드립니다",
    "[정보]",
    "[추천]",
]


def score_title(title: str) -> dict:
    """
    Score a candidate title using trigger system + forbidden patterns.
    Returns {total, triggers_hit, trigger_score, forbidden_hit, forbidden_penalty}.
    """
    import re

    triggers_hit = []
    trigger_score = 0

    for tname, tdef in TRIGGERS.items():
        hit = False
        for pat in tdef.get("patterns", []):
            if re.search(pat, title, re.IGNORECASE):
                hit = True
                break
        if not hit:
            for kw in tdef.get("keywords", []):
                if kw in title:
                    hit = True
                    break
        if hit:
            triggers_hit.append(tname)
            trigger_score += 1

    forbidden_hit = [fp for fp in FORBIDDEN_PATTERNS if fp in title]
    forbidden_penalty = len(forbidden_hit) * 2

    # Length penalty
    length_penalty = 0
    char_count = len(title)
    trigger_count = len(triggers_hit)
    if char_count > 30:
        length_penalty = 2
    elif char_count > 25 and trigger_count < 3:
        length_penalty = 2

    total = trigger_score - forbidden_penalty - length_penalty

    return {
        "total_trigger_score": trigger_score,
        "triggers_hit": triggers_hit,
        "trigger_count": len(triggers_hit),
        "forbidden_hit": forbidden_hit,
        "forbidden_penalty": forbidden_penalty,
        "length_penalty": length_penalty,
        "char_count": char_count,
    }
