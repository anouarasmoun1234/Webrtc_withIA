import httpx, datetime

def local_time(city: str) -> str:
    """
    Renvoie l'heure locale « HH:MM (TZ, UTC±X) » pour la ville demandée.
    Utilise worldtimeapi + geocoding SerpApi lite.
    """
    from tools.search_tool import quick_geo   # ↙︎  fonction à ajouter
    geo = quick_geo(city)          # {'lat':41.1, 'lon':16.9, 'tz':'Europe/Rome'}
    if not geo:
        return "Timezone not found."
    url = f"https://worldtimeapi.org/api/timezone/{geo['tz']}"
    data = httpx.get(url, timeout=5).json()
    t    = datetime.datetime.fromisoformat(data['datetime'][:-6])
    return t.strftime("%H:%M") + f" ({geo['timezone_abbreviation']})"
