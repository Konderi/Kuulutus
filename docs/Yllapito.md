# Ylläpito

Tämä sivu on sovelluksen ylläpitäjälle. Tekniset yksityiskohdat ovat [README:ssä](../README.md).

## Palvelut

| Palvelu | Käyttö |
|---|---|
| **Cloudflare Workers** | Sivusto kuulutus.konderi.fi, salasanasuojaus, äänten välimuisti |
| **GitHub** (Konderi/Kuulutus) | Lähdekoodi. Push `main`-haaraan julkaisee automaattisesti. |
| **ElevenLabs** (Starter) | Pääääni Jarmo/Kaisa |
| **Azure Speech** (Sweden Central) | Varaääni |
| **Leijonien tulospalvelu (TiTu)** | Ottelut, kokoonpanot ja tapahtumat (avoin rajapinta) |

## Salasanan vaihto

1. GitHub → Konderi/Kuulutus → Settings → Secrets and variables → Actions → muokkaa `SITE_PASSWORD`.
2. Actions → **Julkaise Cloudflareen** → Run workflow.

Vaihto kirjaa kaikki käyttäjät ulos.

## Avainten vaihto

Cloudflare → Workers & Pages → **kuulutus** → Settings → Variables and Secrets:

- `ELEVENLABS_API_KEY`: ElevenLabs → Developers → API Keys. Riittävä oikeus on *Text to Speech*.
- `AZURE_SPEECH_KEY`: Azure-portaali → Speech-resurssi → Keys and Endpoint.

Kun olet tallentanut avaimen, aja GitHubin julkaisu uudelleen, koska Cloudflare julkaisee tallennuksen yhteydessä edellisen version.

## Kiintiön seuranta

- **ElevenLabs:** Starter-tilauksessa on noin 40 000 merkkiä kuukaudessa. Yksi kotiottelu on noin 3 000–5 000 merkkiä, eli tilaus riittää noin kymmeneen otteluun kuukaudessa. Kulutus näkyy ElevenLabs → Subscription.
- **Azure:** F0-ilmaistaso (0,5 milj. merkkiä/kk) riittää varaääneksi.

Jos ElevenLabs-kiintiö loppuu, sovellus käyttää automaattisesti Azurea. Tilauksen voi korottaa tai ottaa käyttöön käytön mukaisen lisälaskutuksen ElevenLabsissa.

## Julkaisu ja virheet

- Julkaisujen tila näkyy GitHubissa: Actions → *Julkaise Cloudflareen*.
- Workerin lokit näkyvät Cloudflaressa: Workers & Pages → kuulutus → Logs (observability on päällä).
- Pikatarkistus: https://kuulutus.konderi.fi/api/status vastaa kirjautuneena `{"tts": true, "engine": "elevenlabs"}`.

## Kauden vaihtuminen

Kausi haetaan TiTusta automaattisesti (`SeasonNumber`), joten kauden vaihtuessa ei tarvitse tehdä mitään.

## Kuulutusohjeen päivittyminen

Jos Jääkiekkoliitto julkaisee uuden kuulutusohjeen (finhockey.fi → Joukkueelle → Materiaalipankki → Toimitsijat), sanamuodot päivitetään tiedostoon `static/index.html`. Ne löytyvät funktioista `itemBlock`, `manualBlock`, `welcomeBlock`, `teamBlocks` ja `refsBlock`.
