# RapportApp — MBO ICT

Webapp voor het bijhouden van rapportcijfers van de opleiding MBO ICT.

> **Disclaimer:** deze applicatie is met behulp van AI gebouwd. De code is niet door mensen gereviewed en is niet geschikt voor productieomgevingen.

## Functies

- **Studenten, vakken, modules en klassen** beheren (CRUD). Klassen hebben een naam, een crebo en een **startcohort** (bijv. 25-26); crebos en cohorten zijn vaste, beheerde lijsten (dropdowns) die je op het tabblad Klassen onderhoudt. Modules (voorheen periodes) hebben een naam en een studiejaar (bijv. M1, 2025-2026). Niet elk vak hoeft in elke module cijfers te hebben.
- **Gemaakt voor meerdere jaren**: met ~120 studenten per startcohort groeit het aantal studenten snel. Daarom heeft het studenten-tabblad een zoekveld en filters op cohort en klas, zijn de klas-dropdowns gegroepeerd per cohort, en kun je in de cijfermatrix en rapporten vooraf op cohort filteren. Modules zijn gekoppeld aan studiejaren, zodat gegevens van oudere cohorten gescheiden blijven.
- **Overzicht per klas**: filter de cijfermatrix en het rapport op klas; het rapport toont klas en crebo per student.
- **Vak-module-koppeling**: per vak geef je met vinkjes aan in welke module(s) het gegeven wordt. De cijfermatrix en het rapport tonen per module alléén de vakken waarvoor die module is aangevinkt. De vakkenlijst heeft een zoekfilter.
- **Vak-klasse-koppeling**: per vak geef je aan aan welke klas(sen) het gegeven wordt (gefilterd per crebo, in uitklapmenu's). Een vak zonder aangevinkte klassen is voor alle klassen zichtbaar; een vak met aangevinkte klassen alleen voor die klassen. Dit geldt voor de cijfermatrix en het rapport.
- **Darkmode**: donker thema (automatisch volgens systeeminstelling, handmatig te wisselen); invoervelden hebben een subtiel contrast met de regel.
- **Cijfermatrix per module**: voer per vak een cijfer (1–10) of een beoordelingscode in:
  - `V` = voldoende, `G` = goed, `VS` = vrijstelling — alle drie tellen als voldoende: **0 tekorten**.
  - `O` = onvoldoende — telt als **1 tekort**.
  - `VS` (vrijstelling) is bij elk beoordelingstype toegestaan en telt altijd als voldoende.
- **Tekortberekening** per student per module:
  - Een cijfer dat afgerond onder 6 is, geeft `6 − afgerond cijfer` tekorten (5 → 1 tekort, 4 → 2 tekorten, enz.).
  - `V`, `G` en `VS` tellen als een voldoende: 0 tekorten.
  - `O` telt als 1 tekort.
- **Import** van cijfers via CSV- of Excel-bestand (`.csv`, `.tsv`, `.txt`, `.xlsx`), of via **kopiëren en plakken** direct uit Excel.
- **Import van studenten en vakken** via CSV- of Excel-bestand, met automatische herkenning van een kopregel. Bestaande studenten/vakken worden overgeslagen.
- **Aanwezigheid** per student per module: aanwezigheid, geoorloofd afwezig en ongeoorloofd afwezig als percentages. Aanwezigheid is groen vanaf 85% (daaronder rood); geoorloofd afwezig is donkergeel en ongeoorloofd afwezig rood. Komt terug in de cijfermatrix en het rapport. De drie percentages moeten samen 100% zijn (lege velden tellen als 0%); de invoer wordt anders geweigerd met een melding.
- **Archiveren**: studenten, klassen, vakken en cohorten kun je archiveren. De gegevens (inclusief cijfers) blijven bewaard, maar verdwijnen uit de actieve overzichten, filters en rapporten. Via het tabblad **Archief** zijn ze weer zichtbaar en kunnen ze met één klik worden teruggezet.
- **Opmerkingen** per student per module: een veld **Opmerkingen** (voor het studentrapport) en een veld **Opmerking docenten** (alleen voor medewerkers).
- **Twee rapportvarianten**: een rapport voor **docenten/medewerkers** (toont beide opmerkingvelden) en een rapport voor **student/ouders** (toont alleen Opmerkingen). Kies het publiek in de rapportbalk; de server stuurt de docentenopmerking bij het studentrapport niet eens mee.
- **Rapport** per student per module, netjes vormgegeven en printklaar (afdrukken als PDF via de browser).

## Inloggen en rollen

De app vereist inloggen. Bij de eerste start wordt automatisch het account **`beheerder`** aangemaakt met wachtwoord **`rapportapp`** — wijzig dit direct na de eerste login via het tabblad Gebruikers.

| Rol | Rechten |
|---|---|
| **Beheerder** | Alles: vakken, klassen, studenten, cohorten, crebos, modules, gebruikers en archiveren |
| **Mentor** | Studenten van zijn eigen klassen toevoegen, aanpassen en archiveren; aanwezigheid en opmerkingen invoeren; rapporten genereren |
| **Docent** | Cijfers (en aanwezigheid/opmerkingen) invoeren en rapporten genereren |
| **Administratie** | Alle overzichten en rapporten raadplegen (straks statistieken), geen mutaties |
| **Student** | Alleen het eigen rapport (studentvariant, zonder opmerking docenten) |

- Elke klas kan een **mentor** gekoppeld krijgen (beheerder, op het tabblad Klassen).
- **Studentaccounts** worden beheerd via het vinkje **"Inlog"** op het tabblad Studenten: aanvinken maakt automatisch een account aan (gebruikersnaam = studentnummer, anders `student<id>`; standaardwachtwoord `welkom`), afvinken blokkeert het account. In de gebruikerslijst op het tabblad Gebruikers kun je studentwachtwoorden resetten.
- Rollen worden server-side afgedwongen op elk API-endpoint; de UI verbergt alleen wat niet mag.
- **Gebruikers importeren** (beheerder, tabblad Gebruikers): CSV met kolommen `Gebruikersnaam,Wachtwoord,Rol,Voornaam,Achternaam,Email` (kopregel wordt herkend; zonder kopregel: die volgorde). Bestaande gebruikersnamen worden overgeslagen.

### Dummydata voor tests

Vul een lege database met een complete testset (12 modules, 39 vakken, 6 klassen met elk 25 studenten, mentoren, docenten, cijfers, aanwezigheid en opmerkingen):

```bash
cd /opt/RapportApp
sudo -u rapportapp venv/bin/python seed_dummy.py --url http://127.0.0.1:5000 --username beheerder --password <jouw-wachtwoord>
```

Opbouw: 3 leerjaren van 4 modules (M1 t/m M12, modules tellen door); M5, M6, M11 en M12 zijn stagemodules met één vak (Stage 1 t/m 4); 8 vakken per gewone module (5 technisch, 3 niet-technisch, sommige vakken starten later of stoppen eerder); 2 klassen per leerjaar met unieke klascodes en eigen mentor; alle dummy-accounts hebben wachtwoord `welkom` (studenten loggen in met hun studentnummer).

Het script gebruikt alleen de Python-standaardbibliotheek; er hoeft niets extra geïnstalleerd te worden in de venv.

Alle dummydata (en alle andere gebruikers dan je eigen account) verwijder je weer met:

```bash
sudo -u rapportapp venv/bin/python seed_dummy.py --reset --url http://127.0.0.1:5000 --username beheerder --password <jouw-wachtwoord>
```

> **Let op:** gebruik voor het live gaan van studentaccounts HTTPS (bijv. via Caddy of nginx), zodat wachtwoorden niet als platte tekst over het netwerk gaan.

## Installatie op een Ubuntu-server (in `/opt/RapportApp`)

De app wordt geïnstalleerd in `/opt/RapportApp` en draait als systemd-service onder een eigen gebruiker.

```bash
# 1. Vereiste pakketten
sudo apt update
sudo apt install -y python3-venv git

# 2. Applicatie-user en map aanmaken
sudo useradd --system --home /opt/RapportApp --shell /usr/sbin/nologin rapportapp
sudo mkdir -p /opt/RapportApp
sudo git clone https://github.com/HELDeuS/RapportApp.git /opt/RapportApp

# 3. Eigendom eerst aan rapportapp geven (anders: Permission denied op venv)
sudo chown -R rapportapp:rapportapp /opt/RapportApp

# 4. Virtuele omgeving en dependencies
cd /opt/RapportApp
sudo -u rapportapp python3 -m venv venv
sudo -u rapportapp venv/bin/pip install -r requirements.txt
sudo -u rapportapp venv/bin/pip install gunicorn

# 5. systemd-service aanmaken
sudo tee /etc/systemd/system/rapportapp.service > /dev/null <<'EOF'
[Unit]
Description=RapportApp (MBO ICT cijferregistratie)
After=network.target

[Service]
User=rapportapp
WorkingDirectory=/opt/RapportApp
ExecStart=/opt/RapportApp/venv/bin/gunicorn -w 2 -b 0.0.0.0:5000 app:app
Restart=always

[Install]
WantedBy=multi-user.target
EOF

# 6. Service starten en activeren bij het opstarten
sudo systemctl daemon-reload
sudo systemctl enable --now rapportapp.service
sudo systemctl status rapportapp.service
```

De app is daarna bereikbaar op `http://<server-ip>:5000` (alle netwerkinterfaces, poort 5000). De SQLite-database `rapportapp.db` wordt automatisch aangemaakt in `/opt/RapportApp`.

### Firewall (optioneel)

```bash
sudo ufw allow 5000/tcp
```

Of beperk de toegang tot je eigen netwerk, bijvoorbeeld `sudo ufw allow from 192.168.1.0/24 to any port 5000 proto tcp`.

### Beheer

```bash
sudo systemctl restart rapportapp   # herstart na een update
sudo systemctl stop rapportapp     # stoppen
journalctl -u rapportapp -f        # logbestanden volgen
sudo -u rapportapp git -C /opt/RapportApp pull   # code bijwerken (daarna herstarten)
```

### Updateprocedure

```bash
cd /opt/RapportApp
sudo -u rapportapp git pull
sudo -u rapportapp venv/bin/pip install -r requirements.txt
sudo systemctl restart rapportapp
```

Maak regelmatig een backup van de database:

```bash
sudo cp /opt/RapportApp/rapportapp.db /backup/rapportapp-$(date +%F).db
```

## Importformaat

Zowel bestanden als geplakte tekst volgen dezelfde tabelvorm:

| (leeg/Naam) | Nederlands | Rekenen | ... |
|-------------|-----------|---------|-----|
| Jan         | 7,5       | VS      |     |
| Piet        | O         | 5,2     |     |

- Eerste kolom: studentnaam of studentnummer.
- Eerste rij: vaknamen (kopregel).
- Cellen: cijfer (punt of komma als decimaalteken), `V`, `G`, `VS`, `O` of leeg.

### Kolom plakken (één vak)

Bij "Plakken uit Excel" kun je ook de modus **Kolom (één vak)** kiezen: selecteer het vak, plak één kolom cijfers en de cijfers worden toegekend aan de studenten van de geselecteerde klas, in dezelfde volgorde als het cijferoverzicht. Je kunt per regel ook een naam of studentnummer voor het cijfer zetten (gescheiden met een tab of `;`), dan is de volgorde niet belangrijk. Onbekende studenten en ongeldige waarden worden als fout gemeld en overgeslagen.

### Studenten invoeren

Handmatig via het tabblad Studenten met de velden **studentnummer, voornaam, tussenvoegsel (optioneel), achternaam en e-mailadres** (met * gemarkeerd = verplicht). De weergavenaam wordt automatisch samengesteld (bijv. "Jan van Jansen") en bijgewijzigd als een naamdeel verandert.

### Studenten importeren

CSV met per rij de nieuwe velden; een kopregel wordt automatisch herkend en de kolommen worden op naam gematched; onbekende klassen worden aangemaakt:

```csv
Studentnummer,Voornaam,Tussenvoegsel,Achternaam,Email,Klas,Niveau
1001,Jan,van,Jansen,jan@school.nl,IAO4A,niveau 4
1002,Piet,,Pietersen,piet@school.nl,IAO3B,niveau 3
```

Het oude formaat met een enkele `Naam`-kolom blijft ook werken:

```csv
Naam,Nummer,Klas
Piet Pietersen,3001,IAO4A
```

### Bulkacties

In het studentenoverzicht kun je rijen aanvinken (of "alles selecteren" bovenaan de tabel) en daarna in bulk: **inloggen aan/uit** (maakt/blokkeert de accounts), **archiveren** en **verwijderen** (alleen beheerder). Bij "inloggen aan" worden voornaam, achternaam en e-mailadres automatisch overgenomen in het account.

### Vakken importeren

CSV met per rij één vaknaam. Een kopregel zoals `Vak` wordt automatisch herkend:

```csv
Vak
Nederlands
Rekenen
Engels
```

## API (kort)

- `GET/POST /api/classes`, `PUT/DELETE /api/classes/<id>` (met `crebo_id` en `cohort_id`); `GET/POST /api/crebos`, `DELETE /api/crebos/<id>`; `GET/POST /api/cohorts`, `DELETE /api/cohorts/<id>`
- `GET/POST /api/students`, `PUT/DELETE /api/students/<id>` (met optioneel `class_id`)
- `GET/POST /api/subjects`, `PUT/DELETE /api/subjects/<id>` (met optioneel `period_ids`: modules en `class_ids`: klassen waarin het vak gegeven wordt)
- `GET/POST /api/periods`, `PUT/DELETE /api/periods/<id>`
- `GET /api/grades?period_id=…`, `POST /api/grades` (één cijfer zetten/wissen)
- `POST /api/import` (bestand of tekst, form-data: `period_id`, `file` of `text`)
- `POST /api/import/students` (form-data: `file` — CSV/Excel met naam + optioneel studentnummer)
- `POST /api/import/subjects` (form-data: `file` — CSV/Excel met vaknamen)
- `GET /api/report?period_id=…&student_id=…&class_id=…&cohort_id=…` (rapport met tekorten, filterbaar op klas en cohort)
- `GET /api/attendance?period_id=…`, `POST /api/attendance` (aanwezigheid per student per module, percentages 0–100)
