// Kuulutus – Cloudflare Worker
// Sama rajapinta kuin paikallisella server.py:llä:
//   GET  /api/games?date=YYYY-MM-DD   päivän ottelut (Leijonat-tulospalvelu)
//   GET  /api/rosters?gameid=&season= ottelun kokoonpanot
//   GET  /api/events?gameid=&season=  tapahtumat, tuomarit, torjunnat
//   GET  /api/status, /api/voices
//   POST /api/tts                     Azure Speech (mp3), välimuistissa
//   POST /api/ocr                     pöytäkirjan kuva → kokoonpanot (Claude)
// Staattinen käyttöliittymä (static/) tarjoillaan Workers Static Assets -toiminnolla.

import Anthropic from "@anthropic-ai/sdk";

const BASE = "https://tulospalvelu.leijonat.fi";
const DISTRICTS = [-1, 1, 2, 3, 4, 5, 6, 7, 8];
const UA = "Kuulutus/1.0 (+announcer tool)";

const VOICES = {
  fi: [
    { name: "fi-FI-HarriNeural", label: "Harri (mies)" },
    { name: "fi-FI-NooraNeural", label: "Noora (nainen)" },
    { name: "fi-FI-SelmaNeural", label: "Selma (nainen)" },
  ],
  en: [
    { name: "en-US-AndrewMultilingualNeural", label: "Andrew – nimet: Harri" },
    { name: "en-US-AvaMultilingualNeural", label: "Ava – nimet: Noora" },
  ],
};
// Englanninkielisessä kuulutuksessa nimet luetaan aina suomalaisella lukijalla
const FI_READER = { "en-US-AndrewMultilingualNeural": "fi-FI-HarriNeural", "en-US-AvaMultilingualNeural": "fi-FI-NooraNeural" };

class UserError extends Error {}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function fetchJson(path, params, ttl = 30) {
  const url = `${BASE}/${path}?${new URLSearchParams(params)}`;
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": UA }, cf: { cacheTtl: ttl, cacheEverything: true } });
  if (!r.ok) throw new Error(`tulospalvelu ${r.status}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function currentSeason() {
  const d = await fetchJson("helpers/getdistrict", { season: 0, districtId: -1 }, 3600);
  return d?.SeasonNumber || 0;
}

// ---------------------------------------------------------------- tulospalvelu

async function gamesOfDay(date) {
  const season = await currentSeason();
  const lists = await Promise.all(DISTRICTS.map(dist =>
    fetchJson("helpers/getgames", { season, subSerieId: 0, teamid: 0, districtid: dist, gamedays: -1, dog: date, levelid: -1 })
      .catch(() => [])));
  const seen = new Set(), out = [];
  for (const levels of lists) for (const lv of levels || []) for (const g of lv.Games || []) {
    if (seen.has(g.GameID)) continue;
    seen.add(g.GameID);
    out.push({
      id: g.GameID, season, time: (g.GameTime || "").slice(0, 5),
      home: g.HomeTeamAbbrv || g.HomeTeamTempName, away: g.AwayTeamAbbrv || g.AwayTeamTempName,
      homeClub: g.HomeAssociation, awayClub: g.AwayAssociation, level: g.LevelName, serie: g.SubSerieName,
      rink: g.RinkName, status: g.GameStatus, score: `${g.HomeGoals ?? ""}–${g.AwayGoals ?? ""}`,
    });
  }
  out.sort((a, b) => a.time.localeCompare(b.time) || (a.level || "").localeCompare(b.level || ""));
  return { season, games: out };
}

function slimRoster(r) {
  r = r || {};
  return {
    players: (r.Players || []).map(p => ({
      nr: (p.JerseyNr || "").trim(), first: p.FirstName || "", last: p.LastName || "",
      pos: p.RoleAbbrv || "", role: p.RoleName || "", captain: p.Captain || "", line: p.Line || 0,
    })),
    staff: (r.Staff || []).map(s => ({ first: s.FirstName || "", last: s.LastName || "", role: s.RoleName || "" })),
  };
}

async function rosters(gameid, season) {
  const d = await fetchJson("game/helpers/getrosters", { gameid, season }, 20);
  return { home: slimRoster(d.HomeTeamGameRoster), away: slimRoster(d.AwayTeamGameRoster) };
}

// "BLOMBERG Otto" → { first: "Otto", last: "BLOMBERG" }
function splitName(n) {
  const parts = (n || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: "", last: "" };
  let last = parts.filter(p => p.length > 1 && p === p.toUpperCase() && p !== p.toLowerCase());
  if (!last.length) last = parts.slice(0, 1);
  return { first: parts.filter(p => !last.includes(p)).join(" "), last: last.join(" ") };
}

function person(jersey, name) {
  const nr = parseInt(jersey, 10) || 0;
  if (!nr && !(name || "").trim()) return null;
  return { nr: nr ? String(nr) : "", ...splitName(name) };
}

async function gameEvents(gameid, season) {
  const d = await fetchJson("gamereport/getgamereportdata", { gameid, season }, 3);
  const g = (d.GamesUpdate || [{}])[0];
  const homeId = g.HomeTeam?.Id, homeName = g.HomeTeam?.Name;
  const events = [];
  for (const e of d.GameLogsUpdate || []) {
    const t = e.Type, side = e.TeamId === homeId ? "home" : "away";
    // LinkID:t vaihtuvat joka haulla, joten avain muodostetaan pysyvistä kentistä
    const ev = { type: t, side, period: e.Period, time: e.GameTime || 0,
      key: e.Key || `${t}_${side}_${e.GameTime}_${e.GoalkeeperJersey || e.Jersey || ""}` };
    if (t === "Goal") {
      Object.assign(ev, {
        scorer: person(e.ScorerJersey, e.ScorerName),
        assists: [person(e.FirstAssistJersey, e.FirstAssistName), person(e.SecondAssistJersey, e.SecondAssistName)].filter(Boolean),
        goalType: e.GoalType || "", specialFI: e.GoalSpecialTypeFI || "", specialEN: e.GoalSpecialTypeEN || "",
        home: e.HomeTeamGoals, away: e.AwayTeamGoals,
      });
    } else if (t === "Penalty") {
      const p = person(e.Jersey, e.Name), s = person(e.SuffererJersey, e.SuffererNames);
      Object.assign(ev, { player: p, server: s && p && s.nr !== p.nr ? s : null, minutes: e.PenaltyMinutesNumber || 0,
        reasonFI: e.PenaltyReasonsFI || "", reasonEN: e.PenaltyReasonsEN || "" });
    } else if (t && t.startsWith("GK")) {
      Object.assign(ev, { goalie: person(e.GoalkeeperJersey, e.GoalkeeperName), previous: person(e.PreviousGoalkeeperJersey, e.PreviousGoalkeeperName) });
    }
    events.push(ev);
  }
  events.sort((a, b) => a.time - b.time || a.key.localeCompare(b.key));
  const rules = (g.GameRules || "").split(";");
  const saves = { home: [], away: [] };
  for (const t of d.GoalkeeperSummary || []) {
    const side = t.TeamName === homeName ? "home" : "away";
    for (const gk of t.TeamGoalkeepers || []) {
      const p = person(gk.GkJersey, gk.GkName) || {};
      p.saves = Object.fromEntries((gk.GkSaves || []).map(s => [String(s.Period), s.Saves || 0]));
      saves[side].push(p);
    }
  }
  return {
    arena: g.Arena || "", serie: g.SubSerieName || "", level: g.LevelName || "",
    spectators: g.Spectators || 0,
    referees: (d.Referees || []).map(r => ({ role: r.RefereeRole || "", ...splitName(r.RefereeName) })),
    saves, playedPeriods: d.PeriodSummary?.PlayedPeriods || 0,
    home: homeName, away: g.AwayTeam?.Name, homeGoals: g.HomeTeam?.Goals, awayGoals: g.AwayTeam?.Goals,
    gameTime: g.GameTime || 0, status: g.GameStatus, periodLen: /^\d+$/.test(rules[3] || "") ? +rules[3] : 20,
    events,
  };
}

// ---------------------------------------------------------------- puhesynteesi (Azure Speech)

const xmlEsc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function buildSsml(lang, voice, rate, segs) {
  const locale = lang === "fi" ? "fi-FI" : "en-US";
  const fiVoice = lang === "fi" ? voice : (FI_READER[voice] || "fi-FI-HarriNeural");
  const r = Math.round((rate - 1) * 100), rateAttr = `${r >= 0 ? "+" : ""}${r}%`;
  const runs = [];   // peräkkäiset saman lukijan osat yhteen <voice>-elementtiin
  for (const s of segs) {
    let part, v;
    if (s.brk) { part = `<break time="${parseInt(s.brk, 10) || 0}ms"/>`; v = runs.length ? runs[runs.length - 1].v : voice; }
    else {
      const text = String(s.t || "");
      if (!text.trim()) continue;
      v = s.fi ? fiVoice : voice;
      part = `<prosody rate="${rateAttr}">${xmlEsc(text)}</prosody>`;
    }
    if (runs.length && runs[runs.length - 1].v === v) runs[runs.length - 1].p.push(part);
    else runs.push({ v, p: [part] });
  }
  const body = runs.map(x => `<voice name="${xmlEsc(x.v)}">${x.p.join("")}</voice>`).join("");
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${locale}">${body}</speak>`;
}

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function azureTts(env, ctx, { lang = "fi", voice, rate = 1, segs }) {
  if (!env.AZURE_SPEECH_KEY || !env.AZURE_SPEECH_REGION) throw new UserError("Azure Speech ei ole käytössä: aseta AZURE_SPEECH_KEY ja AZURE_SPEECH_REGION.");
  const allowed = new Set(Object.values(VOICES).flat().map(v => v.name));
  if (!allowed.has(voice)) throw new UserError(`Tuntematon ääni: ${voice}`);
  if (!Array.isArray(segs) || segs.length > 400) throw new UserError("Virheellinen teksti.");
  rate = Math.min(1.5, Math.max(0.6, Number(rate) || 1));
  const ssml = buildSsml(lang, voice, rate, segs);
  if (ssml.length > 20000) throw new UserError("Liian pitkä teksti.");

  // Valmiit äänet välimuistiin: sama kuulutus ei kuluta Azure-kiintiötä uudelleen
  const cacheKey = new Request(`https://tts-cache.kuulutus/${await sha256(ssml)}.mp3`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const r = await fetch(`https://${env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST", body: ssml,
    headers: { "Ocp-Apim-Subscription-Key": env.AZURE_SPEECH_KEY, "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3", "User-Agent": UA },
  });
  if (r.status === 401 || r.status === 403) throw new UserError("Azure Speech -avain tai alue ei kelpaa (401/403).");
  if (r.status === 429) throw new UserError("Azure Speech -käyttöraja täynnä, yritä hetken päästä.");
  if (!r.ok) throw new UserError(`Azure Speech -virhe ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const resp = new Response(await r.arrayBuffer(), { headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=31536000" } });
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

// ---------------------------------------------------------------- kuvan tulkinta (Claude)

const PLAYER_SCHEMA = {
  type: "object",
  properties: {
    number: { type: "string" }, first_name: { type: "string" }, last_name: { type: "string" },
    position: { type: "string", enum: ["MV", "P", "H", "KP", ""] }, captain: { type: "string", enum: ["C", "A", ""] },
  },
  required: ["number", "first_name", "last_name", "position", "captain"], additionalProperties: false,
};
const TEAM_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    players: { type: "array", items: PLAYER_SCHEMA },
    goalies: { type: "array", items: { type: "string" } },
    lines: { type: "array", items: { type: "object", properties: { defense: { type: "array", items: { type: "string" } }, forwards: { type: "array", items: { type: "string" } } }, required: ["defense", "forwards"], additionalProperties: false } },
  },
  required: ["name", "players", "goalies", "lines"], additionalProperties: false,
};
const OCR_SCHEMA = { type: "object", properties: { home: TEAM_SCHEMA, away: TEAM_SCHEMA, notes: { type: "string" } }, required: ["home", "away", "notes"], additionalProperties: false };

const OCR_PROMPT = `Kuvassa on jääkiekko-ottelun pöytäkirja tai kokoonpanolista (usein suomalainen junioriottelu).
Lue kummankin joukkueen kokoonpano.

- home = kotijoukkue, away = vierasjoukkue. Jos kuvassa on vain yksi joukkue, laita se kohtaan "away" ja jätä "home" tyhjäksi (tyhjä nimi ja tyhjät listat).
- players: jokainen pelaaja pelinumeroineen. position: MV = maalivahti, P = puolustaja, H = hyökkääjä, KP = kenttäpelaaja (jos pelipaikkaa ei voi päätellä), tyhjä jos ei tiedossa. captain: C = kapteeni, A = varakapteeni.
- Kirjoita nimet normaalilla isolla alkukirjaimella (esim. "Häkkinen", ei "HÄKKINEN"). Säilytä ääkköset.
- goalies: maalivahtien numerot, aloittava maalivahti ensin jos se on merkitty.
- lines: kentälliset järjestyksessä (1., 2., 3., 4. kenttä …). defense = puolustajien numerot (vasen ensin), forwards = hyökkääjien numerot (vasen laitahyökkääjä, keskushyökkääjä, oikea laitahyökkääjä). Jos pöytäkirjassa ei ole kenttäjakoa, palauta tyhjä lista.
- Älä keksi pelaajia tai numeroita. Jos jokin merkintä on epäselvä, tee paras arvio ja mainitse se lyhyesti kentässä notes (suomeksi).`;

async function ocrLineup(env, dataUrl) {
  if (!env.ANTHROPIC_API_KEY) throw new UserError("Kuvan lukeminen ei ole käytössä: ANTHROPIC_API_KEY puuttuu.");
  const m = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/s.exec(dataUrl || "");
  if (!m) throw new UserError("Kuvamuotoa ei tueta (käytä JPEG/PNG/WebP).");
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  let response;
  try {
    response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { format: { type: "json_schema", schema: OCR_SCHEMA } },
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } },
        { type: "text", text: OCR_PROMPT },
      ] }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new UserError("Claude-rajapinnan avain ei kelpaa (401).");
    if (e instanceof Anthropic.RateLimitError) throw new UserError("Claude-rajapinnan käyttöraja täynnä, yritä hetken päästä uudelleen.");
    if (e instanceof Anthropic.APIConnectionError) throw new UserError("Yhteys Claude-rajapintaan epäonnistui.");
    if (e instanceof Anthropic.APIError) throw new UserError(`Claude-rajapinnan virhe ${e.status}: ${e.message}`);
    throw e;
  }
  if (response.stop_reason === "refusal") throw new UserError("Kuvan tulkinta hylättiin. Kokeile toista kuvaa.");
  if (response.stop_reason === "max_tokens") throw new UserError("Vastaus katkesi kesken. Kokeile rajatumpaa kuvaa.");
  const text = response.content.find(b => b.type === "text")?.text;
  return JSON.parse(text);
}

// ---------------------------------------------------------------- reititys

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const q = url.searchParams;
    try {
      if (request.method === "GET") {
        if (url.pathname === "/api/games") return json(await gamesOfDay(q.get("date") || new Date().toISOString().slice(0, 10)));
        if (url.pathname === "/api/rosters") return json(await rosters(+q.get("gameid"), +q.get("season") || await currentSeason()));
        if (url.pathname === "/api/events") return json(await gameEvents(+q.get("gameid"), +q.get("season") || await currentSeason()));
        if (url.pathname === "/api/status") {
          const tts = !!(env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION);
          return json({ ocr: !!env.ANTHROPIC_API_KEY, tts, engine: tts ? "azure" : "" });
        }
        if (url.pathname === "/api/voices") return json(env.AZURE_SPEECH_KEY ? VOICES : { fi: [], en: [] });
      }
      if (request.method === "POST" && url.pathname === "/api/tts") {
        const body = await request.json();
        return await azureTts(env, ctx, body);
      }
      if (request.method === "POST" && url.pathname === "/api/ocr") {
        if (+(request.headers.get("content-length") || 0) > 25 * 1024 * 1024) return json({ error: "Kuva on liian suuri." }, 413);
        const body = await request.json();
        return json(await ocrLineup(env, body.image));
      }
      if (url.pathname.startsWith("/api/")) return json({ error: "Ei löydy" }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      if (e instanceof UserError) return json({ error: e.message }, 400);
      return json({ error: `Palvelinvirhe: ${e.message}` }, 502);
    }
  },
};
