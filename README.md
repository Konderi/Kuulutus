# Kuulutus

HyRin junioriotteluiden kuulutusapuri. Sovellus hakee ottelun, kokoonpanot ja pelitapahtumat Leijonien tulospalvelusta (TITU). Kuulutukset muodostetaan Jääkiekkoliiton ohjeen *Kuulutusohjeet – kotimaiset ottelut* (28.08.2023) mukaisesti ja luetaan ääneen suomalaisella kuuluttajaäänellä.

**Käytössä:** https://kuulutus.konderi.fi (salasanasuojattu)
**Käyttöohje:** [GitHub Wiki](https://github.com/Konderi/Kuulutus/wiki) (lähde: [docs/](docs/Home.md))

## Ominaisuudet

- **Ottelut tulospalvelusta**: päivän ottelut kaikilta alueilta, haku joukkueen, sarjan tai hallin nimellä. Ottelun voi luoda myös käsin.
- **Kokoonpanot**: pelaajat, maalivahdit, kapteenit ja valmentajat haetaan TiTusta. Kentät voi merkitä käsin, ja nimen ääntämystä voi korjata.
- **Kokoonpanokuulutus**: tervetulotoivotus, vierasjoukkue ensin (maalivahdit, kenttäpelaajat numerojärjestyksessä, päävalmentaja) ja tuomarit. Tekstin voi lukea ruudulta tai antaa sovelluksen lukea sen ääneen kokonaan tai lohko kerrallaan.
- **Pelitapahtumat**: maalit, rangaistukset, aikalisät ja maalivahdin vaihdot tulevat TiTusta jonoon 5 sekunnin välein. Ohjeen mukaan ne kuulutetaan, kun peli jatkuu, joko käsin tai automaattisesti.
- **Rangaistukset käynnissä**: päättymisajat ja voimasuhde näkyvät. **Päättyi**-painike kuuluttaa ”täysilukuinen” ohjeen taulukon mukaan.
- **Käsikuulutukset**: voimasuhteet, Kunnioita peliä, erien viimeiset minuutit, hylätty maali syineen, maalin korjaus, jatkoaika, voittomaalikilpailu, parhaat pelaajat, pelikello, torjunnat, yleisömäärä, lopputulos ja vapaa teksti.
- **Puheääni**: ElevenLabsin suomalaiset äänet **Jarmo** (oletus) ja **Kaisa**.
  - Kuuluttaja-tyylissä maalit luetaan innostuneesti ja maalintekijän nimi huutaen.
  - Englanninkielisessä kuulutuksessa nimet luetaan suomalaisittain.
  - Jos ElevenLabs ei vastaa, sovellus käyttää näkymättömänä varana Azure Speechiä.
- **Mobiili ja tabletti edellä**: HyRin ilme, alavalikko puhelimella ja sivupalkki tabletilla. Tiedot säilyvät selaimessa, joten sivun voi päivittää.

## Rakenne

| Tiedosto | Tehtävä |
|---|---|
| [static/index.html](static/index.html) | Koko käyttöliittymä (HTML, CSS ja JS samassa tiedostossa) |
| [worker/index.js](worker/index.js) | Cloudflare Worker: salasanasuojaus, TITU-välitys ja puhesynteesi (tuotanto) |
| [server.py](server.py) | Sama rajapinta paikalliseen kehitykseen (Pythonin vakiokirjasto) |
| [wrangler.jsonc](wrangler.jsonc) | Workerin asetukset ja domain `kuulutus.konderi.fi` |
| [.github/workflows/deploy.yml](.github/workflows/deploy.yml) | Automaattinen julkaisu `main`-haarasta |
| [docs/](docs/) | Käyttöohjeen lähde. Muutokset tehdään täällä ja kopioidaan GitHubin Wikiin. |

Selain ei voi kutsua TiTua suoraan, koska tulospalvelu ei lähetä CORS-otsakkeita. Siksi sekä Worker että `server.py` välittävät kutsut. Puhesynteesin avaimet ovat vain palvelimella.

### Rajapinta

| Polku | Kuvaus |
|---|---|
| `GET /api/games?date=YYYY-MM-DD` | Päivän ottelut |
| `GET /api/rosters?gameid=…` | Ottelun kokoonpanot |
| `GET /api/events?gameid=…` | Tulostilanne, peliaika, tapahtumat, tuomarit, halli, torjunnat |
| `GET /api/voices` | Valittavat äänet |
| `GET /api/status` | Puhemoottorin tila |
| `POST /api/tts` | `{lang, voice, style, mood, segs}` → MP3 |
| `/login`, `/logout` | Kirjautuminen (vain Worker) |

## Paikallinen kehitys

1. Luo `.env` mallista ja täytä avaimet:

   ```bash
   cp .env.example .env
   ```

2. Käynnistä palvelin:

   ```bash
   python3 server.py
   ```

3. Avaa http://localhost:8000. Paikallisessa palvelimessa ei ole salasanaa.

Workerin voi ajaa paikallisesti myös Wranglerilla. Se lukee salaisuudet `.env`-tiedostosta:

```bash
npm install
```

```bash
npx wrangler dev
```

### Ympäristömuuttujat

| Muuttuja | Pakollinen | Kuvaus |
|---|---|---|
| `ELEVENLABS_API_KEY` | suositus | ElevenLabs-avain. Tarvitaan Jarmo- ja Kaisa-äänille, ja tilin on oltava vähintään Starter-tasoa. Avaimelle riittää oikeus *Text to Speech*. |
| `AZURE_SPEECH_KEY` | valinnainen | Azure Speech -varaääni (Noora/Ava), jos ElevenLabs ei vastaa. Ilman ElevenLabs-avainta Azure-äänet näkyvät valikossa. |
| `AZURE_SPEECH_REGION` | Azurelle | `swedencentral` |
| `SITE_PASSWORD` | Workerille | Sivuston salasana |

Ilman kumpaakaan avainta sovellus käyttää selaimen omaa puheääntä, jonka laatu on heikko. Paikallisesti voi kokeilla myös Piper-ääntä (`pip install piper-tts` ja äänimallit kansioon `voices/`), mutta Piper ei toimi Cloudflaressa.

## Julkaisu (Cloudflare)

Jokainen push `main`-haaraan julkaisee Workerin GitHub Actionsilla. Julkaisun voi käynnistää myös käsin: Actions → **Julkaise Cloudflareen** → Run workflow.

### GitHub-salaisuudet

Repo → Settings → Secrets and variables → Actions:

| Nimi | Arvo |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API -avain (ks. alla) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare → Workers & Pages → Account ID |
| `SITE_PASSWORD` | Sivuston salasana. Julkaisu vie sen Workerin salaisuudeksi. |

**API-avain**: Cloudflare → My Profile → API Tokens → Create Token → mallipohja **Edit Cloudflare Workers**. Tee mallipohjaan seuraavat muutokset:

- Account Resources: oma tili.
- Zone Resources: `konderi.fi`.
- Lisää oikeudet Zone → DNS → Edit ja Zone → Zone → Read.

### Workerin salaisuudet

Lisää nämä Cloudflaressa: Workers & Pages → **kuulutus** → Settings → Variables and Secrets → Add. Valitse tyypiksi **Secret**.

- `ELEVENLABS_API_KEY`
- `AZURE_SPEECH_KEY`

`wrangler.jsonc`:n asetus `keep_vars: true` estää julkaisua poistamasta hallinnassa lisättyjä muuttujia.

> **Huom:** Jos lisäät salaisuuden Cloudflaren hallinnassa, Cloudflare julkaisee samalla edellisen version uudelleen. Aja sen jälkeen GitHubin julkaisu uudelleen (Run workflow), jotta uusin koodi on varmasti käytössä.

### Kirjautuminen

Worker pyytää salasanan (`SITE_PASSWORD`) ja asettaa allekirjoitetun evästeen, joka on voimassa 30 päivää. Ilman evästettä rajapinnat vastaavat 401 ja sivut ohjaavat kirjautumiseen. Salasana vaihdetaan päivittämällä GitHub-salaisuus `SITE_PASSWORD` ja ajamalla julkaisu.

## Kustannukset

- **ElevenLabs:** yksi kotiottelu (kokoonpanot ja tapahtumat) on noin 3 000–5 000 merkkiä, eli noin 0,5 $. Starter-tilauksen kiintiö riittää noin kymmeneen otteluun kuukaudessa.
- **Valmiit äänet:** sama kuulutus haetaan Cloudflaren välimuistista, joten se ei kuluta kiintiötä uudelleen.
- **Azure ja Cloudflare:** varaäänenä Azure mahtuu ilmaistasoon (F0), ja Cloudflare Workers mahtuu ilmaistasoon.

## Tulospalvelun rajapinta (TITU)

Avoimia JSON-rajapintoja, ei kirjautumista:

- `helpers/getdistrict?season=0&districtId=-1` → kuluva kausi (`SeasonNumber`)
- `helpers/getgames?season=2027&districtid=1&dog=2026-11-22&subSerieId=0&teamid=0&gamedays=-1&levelid=-1` → päivän ottelut alueittain (alueet 1–8 ja -1)
- `game/helpers/getrosters?gameid=2760612&season=2027` → kokoonpanot. `Line` on junioreilla 0, joten kenttäjakoa ei ole.
- `gamereport/getgamereportdata?gameid=2760612&season=2027` → tilanne ja tapahtumat:
  - `GamesUpdate.GameTime` on peliaika ja `GameStatus` ottelun tila (11–15 = erät ja erätauot, 2 = päättynyt).
  - `GameLogsUpdate`: `Goal`, `Penalty`, `Timeout`, `GK_*`.
  - `*LinkID` vaihtuu joka haulla, joten tapahtumat tunnistetaan `Key`-kentästä.

Peliaika päivittyy TiTuun noin 30 sekunnin välein, ja kello seisoo katkoilla.

## Kuulutusohje

Sanamuodot noudattavat Jääkiekkoliiton ohjetta *Kuulutusohjeet – kotimaiset ottelut* (28.08.2023). Ohje löytyy finhockey.fi:stä: Joukkueelle → Materiaalipankki → Toimitsijat. Esimerkkejä:

> HYRI Yellow, toinen maali, ylivoimalla. Maalintekijä numero 21, Nuutti Mäkinen. Syöttäjä numero 7, … Aika kuusitoista kolmekymmentäneljä.

> K-Espoo V, numero 35, Kai Öyry, 2 minuuttia, syy huitominen. Rangaistuksen kärsii numero 64, Akseli Heikel. Aika viisitoista kolmekymmentäkaksi.
