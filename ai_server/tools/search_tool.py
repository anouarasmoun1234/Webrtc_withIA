# tools/search_tool.py (version SerpApi)
import os, httpx
from serpapi import GoogleSearch

SERPAPI_KEY = os.getenv("SERPAPI_KEY")

def web_search(query: str, k: int = 6) -> str:
    """Renvoie jusqu'à k résultats Web (titre + extrait)."""
    if not SERPAPI_KEY:
        return "SerpApi key not configured."

    params = {
        "engine": "google",          # par défaut
        "q": query,
        "api_key": SERPAPI_KEY,
        "num": k
    }
    data = GoogleSearch(params).get_dict()

    results = data.get("organic_results", [])[:k]
    if not results:
        return "No web result."

    lines = []
    for r in results:
        title   = r.get("title", "—")
        snippet = r.get("snippet") or r.get("snippet_highlighted") or ""
        lines.append(f"- {title}: {snippet}")
    return "\n".join(lines)
