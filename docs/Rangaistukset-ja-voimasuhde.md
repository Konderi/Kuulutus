# Rangaistukset ja voimasuhde

Kuulutusohjeen mukaan rangaistuksen päättyessä kuulutetaan voimasuhde, esim. ”Joukkueet täysilukuiset”. TiTu ei tiedä tarkalleen, milloin pelaaja palaa jäälle, joten tämä tehdään pääosin käsin.

## Voimasuhde-kortti

**Tapahtumat → Ottelu** -näkymän Voimasuhde-kortissa näkyy:

- nykyinen voimasuhde: vihreä *Täysilukuiset 5–5* tai oranssi esim. *5–4*
- jokainen voimassa oleva rangaistus: joukkue, pelaaja, kesto ja **päättymisaika**.

Kun rangaistus päättyy **hallin kellon** mukaan, paina sen kohdalla **Päättyi**. Sovellus laskee uuden voimasuhteen ja kuuluttaa sen ohjeen taulukon mukaan. Jos taulukon mukaan mitään ei kuuluteta, näytölle tulee siitä ilmoitus.

> TiTun kello voi olla hallin kellosta jäljessä. Luota aina hallin kelloon.

## Voimasuhteen pikapainikkeet

Samassa kortissa ovat painikkeet suoraan kuulutettaville lauseille:

- Joukkueet täysilukuiset
- Joukkueet tasalukuiset
- [kotijoukkue] täysilukuinen
- [vierasjoukkue] täysilukuinen

Käytä näitä, kun haluat kuuluttaa tilanteen heti etkä seuraa korttia.

## Laskusäännöt

Sovellus laskee voimasuhteen näillä säännöillä (myös automaattista täysilukuisuutta varten):

- **Pieni rangaistus** (2 min) päättyy vastustajan ylivoimamaaliin.
- **2+2 min**: maali päättää ensimmäisen osan.
- **Iso rangaistus** (5 min) ei pääty maaliin.
- **Käytös-, peli- ja ottelurangaistukset** eivät muuta voimasuhdetta.
- Joukkueesta voi olla vajaana enintään kaksi pelaajaa kerrallaan. Kolmas rangaistus alkaa vasta, kun edellinen päättyy.
- Maalivahdin vaihtoa kenttäpelaajaan ei huomioida.

| Muutos | Kuulutus |
|---|---|
| 5–4 → 5–5 | Joukkueet täysilukuiset |
| 4–4 → 5–4 | Koti/vieras täysilukuinen |
| 4–3 → 4–4 | Joukkueet tasalukuiset |
| 3–3 → 4–3 | Vieras/koti vajaalukuinen |

Automaattinen täysilukuisuus (asetuksissa *Tulospalvelusta jonoon → Täysilukuisuus*) kuuluttaa vasta, kun TiTun peliaika ohittaa päättymisajan. Se voi siis tulla myöhässä.
