#!/usr/bin/env python3
"""Kuulutus – paikallinen palvelin jääkiekon kokoonpanojen kuuluttamiseen.

- Tarjoilee käyttöliittymän (static/index.html)
- Välittää Leijonat-tulospalvelun (TITU) kutsut, koska rajapinta ei salli
  suoria selainkutsuja (ei CORS-otsakkeita)

Käynnistys:  python3 server.py   (oletusportti 8000, muuta: PORT=8080)
"""

import base64
import hashlib
import re
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load_dotenv():
    """Lukee .env-tiedoston (AVAIN=arvo) ympäristömuuttujiksi, jos niitä ei ole jo asetettu."""
    f = ROOT / ".env"
    if not f.exists():
        return
    for line in f.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_dotenv()

BASE = "https://tulospalvelu.leijonat.fi"
STATIC = ROOT / "static"
TTS_CACHE = ROOT / "cache" / "tts"
DISTRICTS = [-1, 1, 2, 3, 4, 5, 6, 7, 8]
UA = "Kuulutus/1.0 (+local announcer tool)"

_cache = {}
_cache_lock = threading.Lock()


def fetch_json(path, params, ttl=30):
    url = f"{BASE}/{path}?{urllib.parse.urlencode(params)}"
    now = time.time()
    with _cache_lock:
        hit = _cache.get(url)
        if hit and now - hit[0] < ttl:
            return hit[1]
    req = urllib.request.Request(url, headers={"accept": "application/json", "user-agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.loads(r.read().decode("utf-8") or "null")
    with _cache_lock:
        _cache[url] = (now, data)
    return data


def current_season():
    d = fetch_json("helpers/getdistrict", {"season": 0, "districtId": -1}, ttl=3600)
    return d.get("SeasonNumber") or 0


def games_of_day(date):
    season = current_season()

    def one(dist):
        try:
            return fetch_json("helpers/getgames", {
                "season": season, "subSerieId": 0, "teamid": 0, "districtid": dist,
                "gamedays": -1, "dog": date, "levelid": -1,
            }) or []
        except Exception as e:  # yksittäisen alueen virhe ei kaada koko listaa
            print("getgames", dist, e, file=sys.stderr)
            return []

    seen, out = set(), []
    with ThreadPoolExecutor(max_workers=len(DISTRICTS)) as ex:
        for levels in ex.map(one, DISTRICTS):
            for lv in levels:
                for g in lv.get("Games") or []:
                    if g["GameID"] in seen:
                        continue
                    seen.add(g["GameID"])
                    out.append({
                        "id": g["GameID"],
                        "season": season,
                        "time": (g.get("GameTime") or "")[:5],
                        "home": g.get("HomeTeamAbbrv") or g.get("HomeTeamTempName"),
                        "away": g.get("AwayTeamAbbrv") or g.get("AwayTeamTempName"),
                        "homeClub": g.get("HomeAssociation"),
                        "awayClub": g.get("AwayAssociation"),
                        "level": g.get("LevelName"),
                        "serie": g.get("SubSerieName"),
                        "rink": g.get("RinkName"),
                        "status": g.get("GameStatus"),
                        "score": f'{g.get("HomeGoals", "")}–{g.get("AwayGoals", "")}',
                    })
    out.sort(key=lambda g: (g["time"], g["level"] or ""))
    return {"season": season, "games": out}


def slim_roster(r):
    r = r or {}
    players = []
    for p in r.get("Players") or []:
        players.append({
            "nr": (p.get("JerseyNr") or "").strip(),
            "first": p.get("FirstName") or "",
            "last": p.get("LastName") or "",
            "pos": p.get("RoleAbbrv") or "",
            "role": p.get("RoleName") or "",
            "captain": p.get("Captain") or "",
            "line": p.get("Line") or 0,
        })
    staff = [{"first": s.get("FirstName") or "", "last": s.get("LastName") or "",
              "role": s.get("RoleName") or ""} for s in r.get("Staff") or []]
    return {"players": players, "staff": staff}


def rosters(gameid, season):
    d = fetch_json("game/helpers/getrosters", {"gameid": gameid, "season": season}, ttl=20)
    return {"home": slim_roster(d.get("HomeTeamGameRoster")),
            "away": slim_roster(d.get("AwayTeamGameRoster"))}


def split_name(n):
    """'BLOMBERG Otto' → ('Otto', 'BLOMBERG')"""
    n = (n or "").strip()
    if not n:
        return "", ""
    parts = n.split()
    last = [p for p in parts if p.isupper() and len(p) > 1] or parts[:1]
    first = [p for p in parts if p not in last]
    return " ".join(first), " ".join(last)


def person(jersey, name):
    try:
        nr = int(jersey or 0)
    except (TypeError, ValueError):
        nr = 0
    if not nr and not (name or "").strip():
        return None
    first, last = split_name(name)
    return {"nr": str(nr) if nr else "", "first": first, "last": last}


def game_events(gameid, season):
    d = fetch_json("gamereport/getgamereportdata", {"gameid": gameid, "season": season}, ttl=3)
    g = (d.get("GamesUpdate") or [{}])[0]
    home_id = (g.get("HomeTeam") or {}).get("Id")
    events = []
    for e in d.get("GameLogsUpdate") or []:
        t = e.get("Type")
        side = "home" if e.get("TeamId") == home_id else "away"
        ev = {"type": t, "side": side, "period": e.get("Period"), "time": e.get("GameTime") or 0,
              # LinkID:t vaihtuvat joka haulla, joten avain muodostetaan pysyvistä kentistä
              "key": e.get("Key") or f'{t}_{side}_{e.get("GameTime")}_{e.get("GoalkeeperJersey") or e.get("Jersey") or ""}'}
        if t == "Goal":
            ev.update(scorer=person(e.get("ScorerJersey"), e.get("ScorerName")),
                      assists=[a for a in (person(e.get("FirstAssistJersey"), e.get("FirstAssistName")),
                                           person(e.get("SecondAssistJersey"), e.get("SecondAssistName"))) if a],
                      goalType=e.get("GoalType") or "",
                      specialFI=e.get("GoalSpecialTypeFI") or "", specialEN=e.get("GoalSpecialTypeEN") or "",
                      home=e.get("HomeTeamGoals"), away=e.get("AwayTeamGoals"))
        elif t == "Penalty":
            p = person(e.get("Jersey"), e.get("Name"))
            s = person(e.get("SuffererJersey"), e.get("SuffererNames"))
            ev.update(player=p, server=s if s and p and s["nr"] != p["nr"] else None,
                      minutes=e.get("PenaltyMinutesNumber") or 0,
                      reasonFI=e.get("PenaltyReasonsFI") or "", reasonEN=e.get("PenaltyReasonsEN") or "")
        elif t and t.startswith("GK"):
            ev.update(goalie=person(e.get("GoalkeeperJersey"), e.get("GoalkeeperName")),
                      previous=person(e.get("PreviousGoalkeeperJersey"), e.get("PreviousGoalkeeperName")))
        events.append(ev)
    events.sort(key=lambda x: (x["time"], x["key"]))
    rules = (g.get("GameRules") or "").split(";")
    home_name = (g.get("HomeTeam") or {}).get("Name")
    saves = {"home": [], "away": []}
    for t in d.get("GoalkeeperSummary") or []:
        side = "home" if t.get("TeamName") == home_name else "away"
        for gk in t.get("TeamGoalkeepers") or []:
            p = person(gk.get("GkJersey"), gk.get("GkName")) or {}
            p["saves"] = {str(s.get("Period")): s.get("Saves") or 0 for s in gk.get("GkSaves") or []}
            saves[side].append(p)
    referees = []
    for r in d.get("Referees") or []:
        first, last = split_name(r.get("RefereeName"))
        referees.append({"role": r.get("RefereeRole") or "", "first": first, "last": last})
    return {
        "arena": g.get("Arena") or "", "serie": g.get("SubSerieName") or "", "level": g.get("LevelName") or "",
        "spectators": g.get("Spectators") or 0, "referees": referees, "saves": saves,
        "playedPeriods": (d.get("PeriodSummary") or {}).get("PlayedPeriods") or 0,
        "home": (g.get("HomeTeam") or {}).get("Name"), "away": (g.get("AwayTeam") or {}).get("Name"),
        "homeGoals": (g.get("HomeTeam") or {}).get("Goals"), "awayGoals": (g.get("AwayTeam") or {}).get("Goals"),
        "gameTime": g.get("GameTime") or 0, "status": g.get("GameStatus"),
        "periodLen": int(rules[3]) if len(rules) > 3 and rules[3].isdigit() else 20,
        "events": events,
    }


# ---------------------------------------------------------------- puhesynteesi (Azure Speech)

# Valikoidut, laadukkaimmat äänet. Suomi ensin; englanniksi vain monikieliset äänet,
# jotka osaavat lausua suomalaiset nimet suomeksi (<lang xml:lang="fi-FI">).
VOICES = {
    "fi": [
        {"name": "fi-FI-NooraNeural", "label": "Noora (nainen) – suositus"},
        {"name": "fi-FI-HarriNeural", "label": "Harri (mies)"},
    ],
    "en": [
        {"name": "en-US-AvaMultilingualNeural", "label": "Ava – nimet: Noora"},
        {"name": "en-US-AndrewMultilingualNeural", "label": "Andrew – nimet: Harri"},
    ],
}


def azure_conf():
    key = os.environ.get("AZURE_SPEECH_KEY", "").strip()
    region = os.environ.get("AZURE_SPEECH_REGION", "").strip()
    return (key, region) if key and region else None


def xml_esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&apos;"))


# Englanninkielisessä kuulutuksessa nimet luetaan aina suomalaisella lukijalla
FI_READER = {"en-US-AndrewMultilingualNeural": "fi-FI-HarriNeural", "en-US-AvaMultilingualNeural": "fi-FI-NooraNeural"}


# Azuren suomiäänet kompastelevat tiettyihin sanoihin (mitattu puheentunnistuksella):
#  - ykköseen päättyvät luvut 21–91 ("21" → "20 taiksi") → kirjoitetaan "kaksikymmentä yksi"
#  - "ensimmäinen" ("ensin i nen") → "en-simmäinen"
#  - peliaika "51.31" ("51 piste 31") → "51 31"
#  - yksittäinen kirjain ("K-Espoo V" → "viidenneltä") → kirjaimen nimi ("vee")
FI_TENS = {"2": "kaksikymmentä", "3": "kolmekymmentä", "4": "neljäkymmentä", "5": "viisikymmentä",
           "6": "kuusikymmentä", "7": "seitsemänkymmentä", "8": "kahdeksankymmentä", "9": "yhdeksänkymmentä"}


FI_LETTERS = {"A": "aa", "B": "bee", "C": "see", "D": "dee", "E": "ee", "F": "äf", "G": "gee", "H": "hoo", "I": "ii",
              "J": "jii", "K": "koo", "L": "äl", "M": "äm", "N": "än", "O": "oo", "P": "pee", "Q": "kuu", "R": "är",
              "S": "äs", "T": "tee", "U": "uu", "V": "vee", "W": "kaksoisvee", "X": "äks", "Y": "yy", "Z": "tset",
              "Å": "oo", "Ä": "ää", "Ö": "öö"}


def fi_normalize(text):
    # peliaika "51.31" luetaan muuten "51 piste 31" (yli 23 min ei ole kellonaika) → "51 31"
    text = re.sub(r"(?<![\d.:])(\d{1,2})[.:](\d{2})(?![\d:]|\.\d)", r"\1 \2", text)
    text = re.sub(r"(?<![\d.:])([2-9])1(?![\d:]|\.\d)", lambda m: f"{FI_TENS[m.group(1)]} yksi", text)
    # yksittäinen kirjain joukkueen nimessä ("K-Espoo V" → "…vee", ei "viidenneltä")
    text = re.sub(r"(?<![\w-])([A-ZÅÄÖ])(?![\w-]|\.\w)", lambda m: FI_LETTERS[m.group(1)], text)
    return re.sub(r"\b([Ee])nsimmäi", lambda m: f"{m.group(1)}n-simmäi", text)


def build_ssml(lang, voice, rate, segs):
    """segs: [{"t": teksti, "fi": bool (nimi → suomalainen lukija), "brk": ms}]

    Saman lukijan peräkkäinen teksti yhdistetään yhtenäisiksi lauseiksi: jos lause pilkotaan
    useaan elementtiin, neuroääni katkoo rytmin ja ääntää sanoja ja lukuja väärin
    (esim. "ensimmäinen" → "ensin i nen", "21" → "20 x")."""
    locale = "fi-FI" if lang == "fi" else "en-US"
    fi_voice = voice if lang == "fi" else FI_READER.get(voice, "fi-FI-HarriNeural")
    r = int(round((float(rate) - 1) * 100))
    runs = []  # [(ääni, [osat])], osa = tekstiä tai ("brk", ms)
    for s in segs:
        if s.get("brk"):
            if runs:
                runs[-1][1].append(("brk", int(s["brk"])))
            continue
        text = s.get("t", "")
        if not text.strip() and not (runs and text):
            continue
        v = fi_voice if s.get("fi") else voice
        if runs and runs[-1][0] == v:
            parts = runs[-1][1]
            if parts and isinstance(parts[-1], str):
                parts[-1] += text
            else:
                parts.append(text)
        else:
            runs.append((v, [text]))

    def chunk(text, v):
        text = " ".join(text.split())
        t = xml_esc(fi_normalize(text) if v.startswith("fi-FI") else text)
        return f'<prosody rate="{r:+d}%">{t}</prosody>' if r else t

    body = []
    for v, parts in runs:
        inner = "".join(f'<break time="{p[1]}ms"/>' if isinstance(p, tuple) else chunk(p, v) for p in parts if isinstance(p, tuple) or p.strip())
        body.append(f'<voice name="{xml_esc(v)}">{inner}</voice>')
    return (f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
            f'xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="{locale}">{"".join(body)}</speak>')


def azure_tts(lang, voice, rate, segs):
    conf = azure_conf()
    if not conf:
        raise RuntimeError("Azure Speech ei ole käytössä: aseta AZURE_SPEECH_KEY ja AZURE_SPEECH_REGION.")
    key, region = conf
    allowed = {v["name"] for vs in VOICES.values() for v in vs}
    if voice not in allowed:
        raise RuntimeError(f"Tuntematon ääni: {voice}")
    rate = min(1.5, max(0.6, float(rate or 1)))
    ssml = build_ssml(lang, voice, rate, segs)
    key_hash = __import__("hashlib").sha256(ssml.encode("utf-8")).hexdigest()
    path = TTS_CACHE / f"{key_hash}.mp3"
    if path.exists():
        return path.read_bytes()

    def call(body):
        req = urllib.request.Request(
            f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1",
            data=body.encode("utf-8"), method="POST",
            headers={"Ocp-Apim-Subscription-Key": key, "Content-Type": "application/ssml+xml",
                     "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3", "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read()

    try:
        audio = call(ssml)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise RuntimeError("Azure Speech -avain tai alue ei kelpaa (401/403).")
        elif e.code == 429:
            raise RuntimeError("Azure Speech -käyttöraja täynnä, yritä hetken päästä.")
        else:
            raise RuntimeError(f"Azure Speech -virhe {e.code}: {e.read()[:200].decode('utf-8', 'replace')}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Yhteys Azure Speechiin epäonnistui: {e.reason}")
    TTS_CACHE.mkdir(parents=True, exist_ok=True)
    path.write_bytes(audio)
    return audio


# ---------------------------------------------------------------- puhesynteesi (Piper, paikallinen)
# Avoin neuroääni, toimii ilman tiliä ja nettiyhteyttä. Mallit kansiossa voices/.
VOICE_DIR = ROOT / "voices"
PIPER_VOICES = {
    "fi": [{"name": "piper:fi_FI-harri-medium", "label": "Harri (Piper)"}],
    "en": [{"name": "piper:en_US-ryan-high", "label": "Ryan (Piper)"}],
}
PIPER_FI = "fi_FI-harri-medium"
_piper = {}
_piper_lock = threading.Lock()


def piper_available():
    try:
        import piper  # noqa: F401
    except ImportError:
        return False
    return (VOICE_DIR / f"{PIPER_FI}.onnx").exists()


def piper_voice(name):
    with _piper_lock:
        if name not in _piper:
            from piper import PiperVoice
            _piper[name] = PiperVoice.load(str(VOICE_DIR / f"{name}.onnx"))
        return _piper[name]


def piper_text(text, finnish):
    if finnish:
        # Piper/espeak lukee "16.34" muodossa "kuusitoista piste …" – kaksoispiste luetaan kellonaikana
        text = re.sub(r"\b(\d{1,2})\.(\d{2})\b", r"\1:\2", text)
        text = text.replace("–", ",")
    return text


def piper_tts(lang, voice, rate, segs):
    import io, wave
    from piper import SynthesisConfig
    if not piper_available():
        raise RuntimeError("Piper-ääntä ei ole asennettu (katso README).")
    main = voice.split(":", 1)[1]
    allowed = {v["name"] for vs in PIPER_VOICES.values() for v in vs}
    if voice not in allowed or not (VOICE_DIR / f"{main}.onnx").exists():
        raise RuntimeError(f"Tuntematon ääni: {voice}")
    rate = min(1.5, max(0.6, float(rate or 1)))
    key = hashlib.sha256(json.dumps([lang, voice, rate, segs], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    path = TTS_CACHE / f"piper-{key}.wav"
    if path.exists():
        return path.read_bytes()
    cfg = SynthesisConfig(length_scale=1 / rate)
    frames, params = [], None
    # Englanniksi nimet (fi) luetaan suomenkielisellä äänellä, jotta ne ääntyvät oikein
    for s in segs:
        if s.get("brk"):
            frames.append(("silence", int(s["brk"])))
            continue
        text = (s.get("t") or "").strip()
        if not re.search(r"\w", text):
            # pelkkä välimerkki (esim. "." nimen perässä) → tauko
            if text:
                frames.append(("silence", 250 if text[-1] in ".!?:" else 120))
            continue
        name = PIPER_FI if (lang == "fi" or s.get("fi")) else main
        chunks = list(piper_voice(name).synthesize(piper_text(text, name == PIPER_FI), syn_config=cfg))
        if not chunks:
            continue
        c = chunks[0]
        params = params or (c.sample_channels, c.sample_width, c.sample_rate)
        frames.append(("audio", b"".join(ch.audio_int16_bytes for ch in chunks)))
        frames.append(("silence", 90))  # lyhyt tauko osien väliin
    if not params:
        raise RuntimeError("Ei luettavaa tekstiä.")
    ch, sw, sr = params
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(ch); w.setsampwidth(sw); w.setframerate(sr)
        for kind, v in frames:
            w.writeframes(v if kind == "audio" else b"\x00" * sw * ch * int(sr * v / 1000))
    audio = out.getvalue()
    TTS_CACHE.mkdir(parents=True, exist_ok=True)
    path.write_bytes(audio)
    return audio


def tts_voices():
    if azure_conf():
        return VOICES
    if piper_available():
        return {k: [v for v in vs if (VOICE_DIR / f'{v["name"].split(":", 1)[1]}.onnx').exists()] for k, vs in PIPER_VOICES.items()}
    return {"fi": [], "en": []}


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        try:
            if u.path in ("/", "/index.html"):
                return self._send(200, (STATIC / "index.html").read_bytes(), "text/html; charset=utf-8")
            types = {".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json"}
            name = u.path.lstrip("/")
            if "/" not in name and Path(name).suffix in types and (STATIC / name).is_file():
                return self._send(200, (STATIC / name).read_bytes(), types[Path(name).suffix])
            if u.path == "/api/games":
                return self._send(200, games_of_day(q.get("date") or time.strftime("%Y-%m-%d")))
            if u.path == "/api/rosters":
                return self._send(200, rosters(int(q["gameid"]), int(q.get("season") or current_season())))
            if u.path == "/api/events":
                return self._send(200, game_events(int(q["gameid"]), int(q.get("season") or current_season())))
            if u.path == "/api/status":
                return self._send(200, {"tts": bool(azure_conf() or piper_available()), "engine": "azure" if azure_conf() else ("piper" if piper_available() else "")})
            if u.path == "/api/voices":
                return self._send(200, tts_voices())
            return self._send(404, {"error": "Ei löydy"})
        except Exception as e:
            return self._send(502, {"error": f"Tulospalvelun haku epäonnistui: {e}"})

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api/tts":
            try:
                n = int(self.headers.get("content-length") or 0)
                if n > 200_000:
                    return self._send(413, {"error": "Liian pitkä teksti."})
                p = json.loads(self.rfile.read(n))
                if str(p.get("voice", "")).startswith("piper:"):
                    return self._send(200, piper_tts(p.get("lang", "fi"), p["voice"], p.get("rate", 1), p["segs"]), "audio/wav")
                audio = azure_tts(p.get("lang", "fi"), p["voice"], p.get("rate", 1), p["segs"])
                return self._send(200, audio, "audio/mpeg")
            except RuntimeError as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:
                return self._send(500, {"error": f"Puhesynteesi epäonnistui: {e}"})
        return self._send(404, {"error": "Ei löydy"})


def main():
    port = int(os.environ.get("PORT", "8000"))
    host = os.environ.get("HOST", "127.0.0.1")
    srv = ThreadingHTTPServer((host, port), Handler)
    print(f"Kuulutus käynnissä: http://{'localhost' if host == '127.0.0.1' else host}:{port}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
