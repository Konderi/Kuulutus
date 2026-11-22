# Kuulutus

Apuväline jääkiekon junioriotteluiden kuuluttajalle: hae ottelu Leijonien tulospalvelusta (TITU), tarkista kentälliset ja kuuluta joukkueen kokoonpano. Kuulutuksen voi lukea itse ruudulta tai antaa selaimen lukea sen ääneen.

## Käynnistys

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

```bash
.venv/bin/python server.py
```

Avaa http://localhost:8000. Palvelin tarvitsee vain Pythonin vakiokirjaston. `piper-tts` on tarpeen vain paikalliseen Piper-ääneen.


### Puheääni

Sovellus käyttää parasta saatavilla olevaa ääntä tässä järjestyksessä:

1. **Azure Speech** (jos `.env`-tiedostossa on avain): paras laatu.
2. **Piper** (paikallinen neuroääni): ei vaadi tiliä eikä nettiyhteyttä. Suomeksi ääni on Harri, englanniksi Ryan. Englanninkielisessä kuulutuksessa nimet luetaan suomenkielisellä äänellä. Asennus:

```bash
.venv/bin/pip install piper-tts
```

```bash
mkdir -p voices && cd voices && B=https://huggingface.co/rhasspy/piper-voices/resolve/main && for v in fi/fi_FI/harri/medium/fi_FI-harri-medium en/en_US/ryan/high/en_US-ryan-high; do n=$(basename $v); curl -L -o $n.onnx "$B/$v.onnx"; curl -L -o $n.onnx.json "$B/$v.onnx.json"; done
```

3. **Selaimen oma ääni**: heikoin, käytössä vain jos kumpaakaan edellisistä ei ole.

### Laadukas puheääni (Azure Speech)

Kuulutuksen ääneen lukemiseen käytetään Microsoftin Azure Speech -neuroääniä. Ilman avainta sovellus käyttää selaimen omaa ääntä, jonka laatu on selvästi heikompi.

1. Luo Azure-portaalissa (portal.azure.com) **Speech service** -resurssi. Valitse hintatasoksi **Free F0** (0,5 milj. merkkiä/kk ilmaiseksi; yksi kokoonpanokuulutus on noin 1 000 merkkiä) ja alueeksi esim. **North Europe** tai **West Europe**.
2. Kopioi resurssin *Keys and Endpoint* -sivulta avain ja alue.
3. Luo projektikansioon tiedosto `.env`:

```
AZURE_SPEECH_KEY=avain-tähän
AZURE_SPEECH_REGION=northeurope
```

4. Käynnistä palvelin uudelleen.

- **Suomeksi** käytetään suomalaisia ääniä (Harri, Noora, Selma).
- **Englanniksi** käytetään monikielisiä ääniä (Andrew, Brian, Ava, Emma). Pelaajien ja joukkueiden nimet luetaan suomen ääntämyksellä, ja muu teksti englanniksi.
- Jos ääni lausuu jonkin nimen väärin, kirjoita pelaajalistan **Ääntämys**-sarakkeeseen nimi niin kuin se lausutaan (esim. "Aaron Ramsei").
- Valmiit äänitiedostot tallentuvat kansioon `cache/tts`. Sama kuulutus ei siis maksa toista kertaa, ja **⬇ Valmistele ääni** luo kaikki tiedostot etukäteen, jolloin toisto alkaa heti.

Jos haluat käyttää sovellusta puhelimella samassa verkossa, käynnistä palvelin komennolla `HOST=0.0.0.0 .venv/bin/python server.py` ja avaa koneen IP-osoite (esim. `http://192.168.1.20:8000`). Huom: tällöin kuka tahansa samassa verkossa voi käyttää sovellusta ja Azure-kiintiötäsi.

## Käyttö

1. **Ottelu**: valitse päivä ja hae joukkueen nimellä (esim. `keltainen hyri`). Voit myös luoda tyhjän ottelun käsin.
2. **Kokoonpanot**: pelaajat haetaan tulospalvelusta automaattisesti, kun järjestäjä on syöttänyt ne TiTuun. Junioriotteluissa tulospalvelussa ei ole kenttäjakoa, joten kokoonpano kuulutetaan pelipaikoittain. Jos kentät ovat tiedossa, ne voi merkitä käsin. Pelaajia voi lisätä käsin tai liittää listana.
3. **Kuulutus**: tervetulotoivotus, joukkueiden kokoonpanot (vierasjoukkue ensin: maalivahdit, kenttäpelaajat numerojärjestyksessä, päävalmentaja) ja tuomarit ohjeen mukaisesti. Valitse joukkue (vieras, koti tai molemmat) ja kieli (suomi tai englanti). Teksti näkyy isolla, ja 🔊-painike lukee sen ääneen joko kokonaan tai lohko kerrallaan.

4. **Tapahtumat**: maalit, rangaistukset, aikalisät ja maalivahdin vaihdot luetaan tulospalvelusta (**Seuraa ottelua**, päivitys 10 s välein). Uudet tapahtumat menevät jonoon. Ohjeen mukaan kuulutus tehdään vasta, kun peli jatkuu. **Kuuluta automaattisesti, kun peli jatkuu** odottaa, että tulospalvelun peliaika etenee tapahtuman ajan ohi: kirjaus tehdään katkolla kellon seistessä, joten etenevä aika tarkoittaa, että peli on käynnissä. Peliaika päivittyy tulospalveluun noin 30 sekunnin välein, joten kuulutus tulee yleensä 10–40 sekuntia aloituksen jälkeen. **▶ Kuuluta jono** lukee jonon heti. **Muut kuulutukset** -osiossa ovat Kunnioita peliä -kuulutus, erien viimeiset minuutit, torjunnat, yleisömäärä ja lopputulos.

**Täysilukuisuus**: sovellus laskee rangaistusten päättymisen tapahtumista ja tulospalvelun peliajasta ja kuuluttaa ohjeen taulukon mukaisesti ”Koti täysilukuinen”, ”Joukkueet täysilukuiset”, ”Joukkueet tasalukuiset” tai ”Vieras vajaalukuinen”.
- Pieni rangaistus on 2 min ja päättyy vastustajan ylivoimamaaliin. 2+2 min: maali päättää ensimmäisen osan.
- Iso rangaistus on 5 min, eikä maali päätä sitä.
- Käytös-, peli- ja ottelurangaistukset eivät muuta voimasuhdetta.
- Kerrallaan voi olla vajaana enintään kaksi pelaajaa, ja kolmas rangaistus alkaa vasta edellisen päättyessä.
- Kuulutus syntyy vasta, kun tulospalvelun peliaika ohittaa päättymisajan, joten tarkista tilanne kirjurilta. Maalivahdin vaihtoa kenttäpelaajaan ei huomioida.

Kuulutusten sanamuodot noudattavat Jääkiekkoliiton ohjetta *Kuulutusohjeet – kotimaiset ottelut* (28.08.2023, finhockey.fi → Joukkueelle → Materiaalipankki → Toimitsijat). Esimerkiksi maali kuulutetaan muodossa ”HYRI Yellow, toinen maali, ylivoimalla. Maalintekijä numero 21, Nuutti Mäkinen. Syöttäjät … Aika 16.34.” ja rangaistus muodossa ”K-Espoo V, numero 35, Kai Öyry, 2 minuuttia, syy huitominen, rangaistuksen kärsii numero 64, Akseli Heikel, aika 15.32.”

Tiedot tallentuvat selaimeen, eli sivun voi päivittää ilman että tiedot katoavat.

## Tulospalvelun rajapinta

Avoimet JSON-rajapinnat (ei kirjautumista, ei CORS-otsakkeita – siksi palvelin välittää kutsut):

- `GET https://tulospalvelu.leijonat.fi/helpers/getdistrict?season=0&districtId=-1` → kuluva kausi (`SeasonNumber`)
- `GET https://tulospalvelu.leijonat.fi/helpers/getgames?season=2027&districtid=1&dog=2026-11-22&subSerieId=0&teamid=0&gamedays=-1&levelid=-1` → päivän ottelut alueittain (alueet 1–8 ja -1)
- `GET https://tulospalvelu.leijonat.fi/gamereport/getgamereportdata?gameid=2760612&season=2027` → tulostilanne ja tapahtumat (`GameLogsUpdate`: `Goal`, `Penalty`, `Timeout`, `GK_start` …). Huom: `*LinkID`-kentät vaihtuvat joka haulla, joten tapahtumat tunnistetaan `Key`-kentästä.
- `GET https://tulospalvelu.leijonat.fi/game/helpers/getrosters?gameid=2760612&season=2027` → ottelun kokoonpanot (`HomeTeamGameRoster`, `AwayTeamGameRoster`: pelaajat, numerot, pelipaikat, kapteenit, toimihenkilöt; `Line` on junioreilla 0)

## Julkaisu Cloudflareen (kuulutus.konderi.fi)

Pilviversio on Cloudflare Worker ([worker/index.js](worker/index.js)). Siinä on samat rajapinnat kuin paikallisessa `server.py`:ssä, ja käyttöliittymä ([static/index.html](static/index.html)) tarjoillaan Workers Static Assets -toiminnolla. Piper-ääni ei toimi Cloudflaressa, joten pilvessä käytetään Azure Speechiä ja varalla selaimen ääntä. Valmiit äänitiedostot tallentuvat Cloudflaren välimuistiin.

Julkaisu tapahtuu automaattisesti GitHub Actionsilla ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)) aina, kun `main`-haaraan tulee muutos.

### 1. Cloudflare API -avain
Cloudflare → My Profile → API Tokens → **Create Token** → mallipohja **Edit Cloudflare Workers** → Use template.

- **Account Resources**: Include → oma tilisi
- **Zone Resources**: Include → Specific zone → `konderi.fi`
- Lisää mallipohjan oikeuksiin rivit (**+ Add more**):
  - Zone → **DNS** → Edit (custom domain luo DNS-tietueen `kuulutus.konderi.fi`)
  - Zone → **Zone** → Read
- (valinnainen) Client IP Address Filtering ja TTL (voimassaoloaika)

Edellytykset: `konderi.fi` on aktiivinen zone samalla Cloudflare-tilillä, eikä tietuetta `kuulutus.konderi.fi` ole vielä olemassa.

### 2. GitHub-salaisuudet
Repo → Settings → Secrets and variables → Actions → New repository secret:

| Nimi | Arvo |
|---|---|
| `CLOUDFLARE_API_TOKEN` | kohdan 1 avain |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare → Workers & Pages → Account ID (oikea sivupalkki) |

Tai komentoriviltä (kysyy arvon, eikä se jää komentohistoriaan):

```bash
gh secret set CLOUDFLARE_API_TOKEN -R Konderi/Kuulutus
```

```bash
gh secret set CLOUDFLARE_ACCOUNT_ID -R Konderi/Kuulutus
```

### 3. Julkaisu
Repo → Actions → **Julkaise Cloudflareen** → Run workflow (tai mikä tahansa push `main`-haaraan).

### 4. Workerin salaisuudet
Cloudflare → Workers & Pages → **kuulutus** → Settings → Variables and Secrets → Add (tyyppi *Secret*):

- `AZURE_SPEECH_KEY`: Azure Speech -avain (alue `swedencentral` on jo `wrangler.jsonc`:ssä)

### 5. Pääsynhallinta (suositus)
Sivuston rajapinnat käyttävät Azure-kiintiötäsi, joten rajaa pääsy: Cloudflare Zero Trust → Access → Applications → **Add an application** → Self-hosted → domain `kuulutus.konderi.fi` → Policy: *Allow*, Include → Emails → omat osoitteet. Kirjautuminen tapahtuu sähköpostiin tulevalla kertakoodilla. Ilmainen enintään 50 käyttäjälle.

### Paikallinen Worker-testaus

```bash
npm install
```

```bash
npx wrangler dev
```

Komento lukee salaisuudet `.env`-tiedostosta.
