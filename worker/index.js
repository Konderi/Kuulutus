// Kuulutus – Cloudflare Worker
// Sama rajapinta kuin paikallisella server.py:llä:
//   GET  /api/games?date=YYYY-MM-DD   päivän ottelut (Leijonat-tulospalvelu)
//   GET  /api/rosters?gameid=&season= ottelun kokoonpanot
//   GET  /api/events?gameid=&season=  tapahtumat, tuomarit, torjunnat
//   GET  /api/status, /api/voices
//   POST /api/tts                     Azure Speech (mp3), välimuistissa
// Staattinen käyttöliittymä (static/) tarjoillaan Workers Static Assets -toiminnolla.

const BASE = "https://tulospalvelu.leijonat.fi";
const DISTRICTS = [-1, 1, 2, 3, 4, 5, 6, 7, 8];
const UA = "Kuulutus/1.0 (+announcer tool)";

const VOICES = {
  fi: [
    { name: "fi-FI-NooraNeural", label: "Noora (Azure)" },
    { name: "fi-FI-Grant:MAI-Voice-2.1", label: "Grant (Azure, kokeellinen)" },
    { name: "fi-FI-Harper:MAI-Voice-2.1", label: "Harper (Azure, kokeellinen)" },
  ],
  en: [
    { name: "en-US-AvaMultilingualNeural", label: "Ava – nimet: Noora" },
    { name: "en-US-AndrewMultilingualNeural", label: "Andrew – nimet: Harri" },
  ],
};
// Englanninkielisessä kuulutuksessa nimet luetaan aina suomalaisella lukijalla
const FI_READER = { "en-US-AndrewMultilingualNeural": "fi-FI-HarriNeural", "en-US-AvaMultilingualNeural": "fi-FI-NooraNeural" };
// Klassiset suomiäänet tarvitsevat ääntämiskorjaukset; uudet MAI-äänet lausuvat ne oikein itse
const FI_CLASSIC = new Set(["fi-FI-NooraNeural", "fi-FI-HarriNeural", "fi-FI-SelmaNeural"]);
// Kuuluttajatyyli: rauhallisempi tempo, hieman korkeampi ja voimakkaampi ääni, pidemmät tauot
const ANNOUNCER = { rate: 0.9, pitch: "+6%", volume: "+10%", pause: 1.8 };
const VOICE_STYLE = { "fi-FI-Harper:MAI-Voice-2.1": "narrator" };

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

// Azuren suomiäänet kompastelevat tiettyihin sanoihin (mitattu puheentunnistuksella):
//  - ykköseen päättyvät luvut 21–91 ("21" → "20 taiksi") → "kaksikymmentä yksi"
//  - "ensimmäinen" ("ensin i nen") → "en-simmäinen"
//  - peliaika ("14.35" → "neljästätoista…") → sanoina "neljätoista kolmekymmentäviisi"
//  - yksittäinen kirjain ("K-Espoo V" → "viidenneltä") → kirjaimen nimi ("vee")
const FI_TENS = { 2: "kaksikymmentä", 3: "kolmekymmentä", 4: "neljäkymmentä", 5: "viisikymmentä", 6: "kuusikymmentä", 7: "seitsemänkymmentä", 8: "kahdeksankymmentä", 9: "yhdeksänkymmentä" };
const FI_LETTERS = { A: "aa", B: "bee", C: "see", D: "dee", E: "ee", F: "äf", G: "gee", H: "hoo", I: "ii", J: "jii", K: "koo", L: "äl", M: "äm", N: "än", O: "oo", P: "pee", Q: "kuu", R: "är", S: "äs", T: "tee", U: "uu", V: "vee", W: "kaksoisvee", X: "äks", Y: "yy", Z: "tset", "Å": "oo", "Ä": "ää", "Ö": "öö" };
const FI_ONES = ["nolla", "yksi", "kaksi", "kolme", "neljä", "viisi", "kuusi", "seitsemän", "kahdeksan", "yhdeksän"];
// 0–99 sanoina perusmuodossa: 35 → "kolmekymmentäviisi"
function fiNumber(n) {
  if (n < 10) return FI_ONES[n];
  if (n === 10) return "kymmenen";
  if (n < 20) return FI_ONES[n - 10] + "toista";
  const t = Math.floor(n / 10), o = n % 10;
  return FI_ONES[t] + "kymmentä" + (o ? FI_ONES[o] : "");
}
// Peliaika sanoina: 14.35 → "neljätoista kolmekymmentäviisi", 45.01 → "neljäkymmentäviisi nolla yksi"
const fiTime = (m, s) => `${fiNumber(m)} ${s >= 10 ? fiNumber(s) : "nolla " + FI_ONES[s]}`;

function fiNormalize(text, classic = true) {
  // peliaika sanoina perusmuodossa, muuten ääni taivuttaa luvun ("14.35" → "neljästätoista…")
  text = text.replace(/(?<![\d.:])(\d{1,2})[.:]([0-5]\d)(?![\d:]|\.\d)/g, (_, m, s) => fiTime(+m, +s));
  if (classic) text = text.replace(/(?<![\d.:])([2-9])1(?![\d:]|\.\d)/g, (_, d) => `${FI_TENS[d]} yksi`);
  text = text.replace(/(?<![\p{L}\p{N}_-])([A-ZÅÄÖ])(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}_])/gu, (_, c) => FI_LETTERS[c]);
  return classic ? text.replace(/(^|[^\p{L}])([Ee])nsimmäi/gu, (_, pre, e) => `${pre}${e}n-simmäi`) : text;
}

// Saman lukijan peräkkäinen teksti yhdistetään yhtenäisiksi lauseiksi (pilkottu lause katkoo rytmin)
function buildSsml(lang, voice, rate, segs, style = "neutral") {
  const locale = lang === "fi" ? "fi-FI" : "en-US";
  const fiVoice = lang === "fi" ? voice : (FI_READER[voice] || "fi-FI-NooraNeural");
  const ann = style === "announcer";
  rate = rate * (ann ? ANNOUNCER.rate : 1);
  const r = Math.round((rate - 1) * 100);
  const pause = ann ? ANNOUNCER.pause : 1;
  const runs = [];   // { v, parts: [teksti | { brk }] }
  for (const s of segs) {
    if (s.brk) { if (runs.length) runs[runs.length - 1].parts.push({ brk: Math.trunc((parseInt(s.brk, 10) || 0) * pause) }); continue; }
    const text = String(s.t || "");
    if (!text.trim() && !(runs.length && text)) continue;
    const v = s.fi ? fiVoice : voice;
    const last = runs[runs.length - 1];
    if (last && last.v === v) {
      const p = last.parts;
      if (p.length && typeof p[p.length - 1] === "string") p[p.length - 1] += text; else p.push(text);
    } else runs.push({ v, parts: [text] });
  }
  const chunk = (text, v) => {
    text = text.split(/\s+/).filter(Boolean).join(" ");
    if (v.startsWith("fi-FI")) text = fiNormalize(text, FI_CLASSIC.has(v));
    else text = text.replace(/(?<![\d.:])(\d{1,2}):(\d{2})(?![\d:])/g, "$1 $2");   // "51:31" → "51 31" (ei "colon")
    if (v.includes("MAI-Voice")) text = text.replace(/(\d)\.(?=\s|$)/g, "$1");     // MAI lukee pisteen ääneen
    const t = xmlEsc(text);
    const attrs = (r ? ` rate="${r > 0 ? "+" : ""}${r}%"` : "") + (ann ? ` pitch="${ANNOUNCER.pitch}" volume="${ANNOUNCER.volume}"` : "");
    return attrs ? `<prosody${attrs}>${t}</prosody>` : t;
  };
  const body = runs.map(({ v, parts }) => {
    let inner = parts.filter(p => typeof p !== "string" || p.trim())
      .map(p => typeof p === "string" ? chunk(p, v) : `<break time="${p.brk}ms"/>`).join("");
    if (ann && VOICE_STYLE[v]) inner = `<mstts:express-as style="${VOICE_STYLE[v]}">${inner}</mstts:express-as>`;
    return `<voice name="${xmlEsc(v)}">${inner}</voice>`;
  }).join("");
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${locale}">${body}</speak>`;
}

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function azureTts(env, ctx, { lang = "fi", voice, rate = 1, segs, style = "neutral" }) {
  if (!env.AZURE_SPEECH_KEY || !env.AZURE_SPEECH_REGION) throw new UserError("Azure Speech ei ole käytössä: aseta AZURE_SPEECH_KEY ja AZURE_SPEECH_REGION.");
  const allowed = new Set(Object.values(VOICES).flat().map(v => v.name));
  if (!allowed.has(voice)) throw new UserError(`Tuntematon ääni: ${voice}`);
  if (!Array.isArray(segs) || segs.length > 400) throw new UserError("Virheellinen teksti.");
  rate = Math.min(1.5, Math.max(0.6, Number(rate) || 1));
  const ssml = buildSsml(lang, voice, rate, segs, style === "announcer" ? "announcer" : "neutral");
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

// ---------------------------------------------------------------- puhesynteesi (ElevenLabs)
// Suomalaiset kirjastoäänet lausuvat suomen oikein ilman Azuren ääntämiskorjauksia.
const EL_MODEL = "eleven_v4";
const EL_VOICES = { fi: [{ name: "el:izzHd0lE0tvV3bTEbylP", label: "Jarmo (ElevenLabs) – suositus" }] };
const EL_FALLBACK = "fi-FI-NooraNeural";   // jos ElevenLabsin kiintiö loppuu tai palvelu ei vastaa
const FI_VOWELS = new Set("AEIOUYÄÖ");

class ElevenLabsError extends Error { constructor(status, detail) { super(`ElevenLabs ${status}: ${detail}`); this.status = status; } }

// Kuulutuksen osat yhdeksi tekstiksi: tauot rivinvaihtoina, kuuluttajatyyli [excited]-tagilla
function elText(lang, segs, style, mood = "confident") {
  let text = segs.map(s => s.brk ? "\n" : String(s.t || "")).join("");
  text = text.split("\n").map(l => l.split(/\s+/).filter(Boolean).join(" ")).join("\n").replace(/\n+/g, "\n").trim();
  if (lang === "fi") {
    text = text.replace(/(?<![\d.:])(\d{1,2})[.:]([0-5]\d)(?![\d:]|\.\d)/g, (_, m, s) => fiTime(+m, +s));
    // isoilla kirjoitettu lausuttava nimi luetaan muuten lyhenteenä ("HYRI" → "hoo yy är ii") → "Hyri"
    text = text.replace(/(?<![\p{L}\p{N}_])[A-ZÅÄÖ]{2,}(?![\p{L}\p{N}_])/gu, w => [...w].filter(c => FI_VOWELS.has(c)).length >= 2 ? w[0] + w.slice(1).toLowerCase() : w);
    text = text.replace(/(?<![\p{L}\p{N}_-])([A-ZÅÄÖ])(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}_])/gu, (_, c) => FI_LETTERS[c]);
  } else {
    text = text.replace(/(?<![\d.:])(\d{1,2}):(\d{2})(?![\d:])/g, "$1 $2");
  }
  // "Päävalmentaja: …" rivin alussa tulkitaan puhujamerkinnäksi → kaksoispiste pois
  text = text.replace(/^([^\n:]{1,40}):\s*/gm, "$1 ");
  // [excited] nostaa lyhyissä lauseissa äänen huudahtavan korkeaksi → vain maaleihin
  const tag = mood === "excited" ? "[excited] " : "[confident] ";
  return (style === "announcer" ? tag : "") + text;
}

async function elTts(env, ctx, { lang = "fi", voice, rate = 1, segs, style = "neutral", mood = "confident" }) {
  if (!env.ELEVENLABS_API_KEY) throw new UserError("ElevenLabs ei ole käytössä: aseta ELEVENLABS_API_KEY.");
  if (!EL_VOICES.fi.some(v => v.name === voice)) throw new UserError(`Tuntematon ääni: ${voice}`);
  if (!Array.isArray(segs) || segs.length > 400) throw new UserError("Virheellinen teksti.");
  const speed = Math.round(Math.min(1.2, Math.max(0.7, Number(rate) || 1)) * 100) / 100;
  const body = { language_code: lang === "fi" ? "fi" : "en", model_id: EL_MODEL, text: elText(lang, segs, style === "announcer" ? "announcer" : "neutral", mood === "excited" ? "excited" : "confident"), voice_settings: { speed } };
  if (body.text.length > 5000) throw new UserError("Liian pitkä teksti.");
  const payload = JSON.stringify(body);
  const cacheKey = new Request(`https://tts-cache.kuulutus/el-${await sha256(voice + payload)}.mp3`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  let r;
  try {
    r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice.split(":")[1]}?output_format=mp3_44100_128`, {
      method: "POST", body: payload,
      headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json", "User-Agent": UA },
    });
  } catch (e) { throw new ElevenLabsError(0, e.message); }
  if (!r.ok) throw new ElevenLabsError(r.status, (await r.text()).slice(0, 300));
  const resp = new Response(await r.arrayBuffer(), { headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=31536000" } });
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

// ElevenLabs-äänen virheessä (kiintiö, avain, katko) varalle Azure, jotta kuulutus ei jää tekemättä
async function ttsAny(env, ctx, body) {
  const voice = String(body.voice || "");
  if (voice.startsWith("el:")) {
    try { return await elTts(env, ctx, body); }
    catch (e) {
      if (!(e instanceof ElevenLabsError)) throw e;
      console.log("ElevenLabs-virhe, käytetään Azurea:", e.message);
      if (!env.AZURE_SPEECH_KEY) throw new UserError(`ElevenLabs ei vastannut (${e.status}) eikä Azurea ole asetettu.`);
      return azureTts(env, ctx, { ...body, voice: body.lang === "fi" ? EL_FALLBACK : "en-US-AvaMultilingualNeural" });
    }
  }
  return azureTts(env, ctx, body);
}

// ---------------------------------------------------------------- kirjautuminen (salasana)
// Salasana on Workerin salaisuus SITE_PASSWORD. Onnistuneen kirjautumisen jälkeen selaimeen
// annetaan HMAC-allekirjoitettu eväste (30 vrk). Salasanan vaihto mitätöi vanhat kirjautumiset.
const COOKIE = "kuulutus_auth";
const SESSION_DAYS = 30;
const PUBLIC_PATHS = new Set(["/login", "/logout", "/hyri-logo.png", "/favicon.png", "/apple-touch-icon.png"]);
const enc = new TextEncoder();

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(`kuulutus:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function safeEqual(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
async function makeSession(env) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return `${exp}.${await hmac(env.SITE_PASSWORD, String(exp))}`;
}
async function isAuthed(request, env) {
  if (!env.SITE_PASSWORD) return false;   // ei salasanaa asetettu → kaikki kiinni
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || +exp < Date.now()) return false;
  return safeEqual(sig, await hmac(env.SITE_PASSWORD, exp));
}
const cookieHeader = (value, maxAge) => `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

function loginPage({ error = "", notConfigured = false } = {}) {
  const msg = notConfigured ? "Salasanaa ei ole asetettu palvelimelle (SITE_PASSWORD)." : error;
  const html = `<!doctype html><html lang="fi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#16181b"><meta name="robots" content="noindex">
<title>HYRI Kuulutus – kirjaudu</title><link rel="icon" href="/favicon.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@700;800&family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#eef2f5;--card:#fff;--ink:#121417;--muted:#5f6b76;--line:#dde3e8;--focus:#2f7de1;--bad:#d12f2f;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0c0e11;--card:#15181c;--ink:#eef2f5;--muted:#9aa6b2;--line:#2a3038;--focus:#5aa2f0;--bad:#ff6b6b;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);font:16px/1.5 "Roboto",system-ui,sans-serif}
.top{background:linear-gradient(180deg,#16181b,#26292e);height:38vh;min-height:220px;display:flex;align-items:center;justify-content:center;padding-top:env(safe-area-inset-top)}
.top img{width:120px;height:120px;border-radius:50%;background:#fff;box-shadow:0 10px 30px rgba(0,0,0,.4)}
.card{width:min(420px,calc(100% - 32px));margin:-48px auto 32px;background:var(--card);border-radius:18px;padding:28px 24px;box-shadow:0 10px 40px rgba(16,20,24,.15)}
h1{font:800 26px/1.1 "Roboto Condensed",sans-serif;text-transform:uppercase;letter-spacing:.04em;margin:0 0 4px;text-align:center}
p{margin:0 0 20px;color:var(--muted);text-align:center;font-size:14px}
label{display:block;font-size:13px;font-weight:500;color:var(--muted);margin-bottom:6px}
input{width:100%;min-height:52px;padding:12px 14px;font:inherit;font-size:17px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:12px}
input:focus{outline:none;border-color:var(--focus);box-shadow:0 0 0 3px color-mix(in srgb,var(--focus) 25%,transparent)}
button{width:100%;min-height:54px;margin-top:16px;border:0;border-radius:12px;background:var(--ink);color:var(--card);font:700 17px/1 "Roboto",sans-serif;cursor:pointer}
button:active{transform:scale(.98)}
.err{background:color-mix(in srgb,var(--bad) 12%,transparent);color:var(--bad);border-radius:10px;padding:10px 12px;font-size:14px;margin-bottom:14px;text-align:center}
</style></head><body>
<div class="top"><img src="/hyri-logo.png" alt="HYRI Hockey"></div>
<main class="card">
<h1>HYRI Kuulutus</h1><p>Kirjaudu sisään jatkaaksesi.</p>
${msg ? `<div class="err" role="alert">${msg}</div>` : ""}
<form method="post" action="/login">
<label for="pw">Salasana</label>
<input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Kirjaudu</button>
</form></main></body></html>`;
  return new Response(html, { status: msg ? 401 : 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

async function handleAuth(request, env, url) {
  if (url.pathname === "/logout") {
    return new Response(null, { status: 303, headers: { location: "/login", "set-cookie": cookieHeader("", 0) } });
  }
  if (url.pathname === "/login") {
    if (!env.SITE_PASSWORD) return loginPage({ notConfigured: true });
    if (request.method === "POST") {
      const form = await request.formData();
      if (safeEqual(form.get("password") || "", env.SITE_PASSWORD)) {
        return new Response(null, { status: 303, headers: { location: "/", "set-cookie": cookieHeader(await makeSession(env), SESSION_DAYS * 86400) } });
      }
      await new Promise(r => setTimeout(r, 1200));   // hidastaa arvailua
      return loginPage({ error: "Väärä salasana." });
    }
    if (await isAuthed(request, env)) return Response.redirect(new URL("/", url).toString(), 303);
    return loginPage();
  }
  return null;
}

// ---------------------------------------------------------------- reititys

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const q = url.searchParams;
    try {
      // Kirjautuminen: kaikki muu paitsi kirjautumissivu ja logo vaatii voimassa olevan evästeen
      const auth = await handleAuth(request, env, url);
      if (auth) return auth;
      if (PUBLIC_PATHS.has(url.pathname)) return env.ASSETS.fetch(request);
      if (!(await isAuthed(request, env))) {
        if (url.pathname.startsWith("/api/")) return json({ error: "Kirjautuminen vaaditaan.", login: true }, 401);
        return Response.redirect(new URL("/login", url).toString(), 302);
      }
      if (request.method === "GET") {
        if (url.pathname === "/api/games") return json(await gamesOfDay(q.get("date") || new Date().toISOString().slice(0, 10)));
        if (url.pathname === "/api/rosters") return json(await rosters(+q.get("gameid"), +q.get("season") || await currentSeason()));
        if (url.pathname === "/api/events") return json(await gameEvents(+q.get("gameid"), +q.get("season") || await currentSeason()));
        if (url.pathname === "/api/status") {
          const azure = !!(env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION), el = !!env.ELEVENLABS_API_KEY;
          return json({ tts: azure || el, engine: el ? "elevenlabs" : azure ? "azure" : "", auth: true });
        }
        if (url.pathname === "/api/voices") {
          const azure = !!env.AZURE_SPEECH_KEY;
          return json({ fi: [...(env.ELEVENLABS_API_KEY ? EL_VOICES.fi : []), ...(azure ? VOICES.fi : [])], en: azure ? VOICES.en : [] });
        }
      }
      if (request.method === "POST" && url.pathname === "/api/tts") {
        const body = await request.json();
        return await ttsAny(env, ctx, body);
      }
      if (url.pathname.startsWith("/api/")) return json({ error: "Ei löydy" }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      if (e instanceof UserError) return json({ error: e.message }, 400);
      return json({ error: `Palvelinvirhe: ${e.message}` }, 502);
    }
  },
};
