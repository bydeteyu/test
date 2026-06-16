"""
YouTube channel recent video collection.
Uses YouTube Data API v3 if YOUTUBE_API_KEY is set.
Falls back to scraping yt search page otherwise.
"""

import os
import logging
from datetime import datetime, timedelta
from typing import Optional
import requests

logger = logging.getLogger(__name__)

YT_API_BASE = "https://www.googleapis.com/youtube/v3"


def _search_channel_videos_api(
    channel: dict, api_key: str, days: int = 7
) -> list[dict]:
    """Fetch recent videos via YouTube Data API v3."""
    published_after = (
        datetime.utcnow() - timedelta(days=days)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")

    # First resolve channel ID from handle/name if not provided
    channel_id = channel.get("channel_id", "")
    if not channel_id:
        resp = requests.get(
            f"{YT_API_BASE}/search",
            params={
                "part": "snippet",
                "q": channel["search_query"],
                "type": "channel",
                "maxResults": 1,
                "key": api_key,
            },
            timeout=10,
        )
        resp.raise_for_status()
        items = resp.json().get("items", [])
        if items:
            channel_id = items[0]["id"]["channelId"]
        else:
            logger.warning("채널 ID 조회 실패: %s", channel["name"])
            return []

    # Fetch recent videos
    resp = requests.get(
        f"{YT_API_BASE}/search",
        params={
            "part": "snippet",
            "channelId": channel_id,
            "publishedAfter": published_after,
            "order": "date",
            "maxResults": 10,
            "type": "video",
            "key": api_key,
        },
        timeout=10,
    )
    resp.raise_for_status()
    items = resp.json().get("items", [])

    video_ids = [item["id"]["videoId"] for item in items if "videoId" in item.get("id", {})]
    if not video_ids:
        return []

    # Fetch view counts
    stats_resp = requests.get(
        f"{YT_API_BASE}/videos",
        params={
            "part": "statistics,snippet",
            "id": ",".join(video_ids),
            "key": api_key,
        },
        timeout=10,
    )
    stats_resp.raise_for_status()
    stats_items = stats_resp.json().get("items", [])

    videos = []
    for item in stats_items:
        snippet = item.get("snippet", {})
        stats = item.get("statistics", {})
        videos.append(
            {
                "title": snippet.get("title", ""),
                "channel": channel["name"],
                "views": int(stats.get("viewCount", 0)),
                "published": snippet.get("publishedAt", "")[:10],
                "video_id": item["id"],
                "url": f"https://youtu.be/{item['id']}",
            }
        )

    return videos


def _calc_viral_threshold(videos: list[dict]) -> float:
    """Return view count threshold = channel avg * 1.5."""
    if not videos:
        return 0.0
    views = [v["views"] for v in videos if v["views"] > 0]
    if not views:
        return 0.0
    return (sum(views) / len(views)) * 1.5


def collect_youtube_trends(channels: list[dict]) -> list[dict]:
    """
    Collect viral videos from health YouTube channels.
    Returns list of {title, channel, views, published, is_viral, url}.
    Gracefully skips if API key missing.
    """
    api_key = os.getenv("YOUTUBE_API_KEY", "")
    if not api_key:
        logger.warning("YOUTUBE_API_KEY 미설정 → 유튜브 수집 건너뜀")
        return []

    all_videos: list[dict] = []

    for ch in channels:
        try:
            videos = _search_channel_videos_api(ch, api_key)
            threshold = _calc_viral_threshold(videos)
            for v in videos:
                v["is_viral"] = v["views"] >= threshold if threshold > 0 else False
                v["viral_threshold"] = threshold
            all_videos.extend(videos)
            viral_count = sum(1 for v in videos if v["is_viral"])
            logger.info(
                "유튜브 [%s]: %d개 영상, 바이럴 %d개 (임계값: %.0f)",
                ch["name"], len(videos), viral_count, threshold,
            )
        except requests.RequestException as e:
            logger.warning("유튜브 수집 실패 [%s]: %s", ch["name"], e)

    return all_videos
