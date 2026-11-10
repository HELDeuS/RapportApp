# RapportApp — MBO ICT

Webapp voor het bijhouden van rapportcijfers van de opleiding MBO ICT.

## Functies

- **Studenten, vakken en periodes** beheren (CRUD). Niet elk vak hoeft in elke periode cijfers te hebben.
- **Cijfermatrix per periode**: voer per vak een cijfer (1–10) of een beoordelingscode in:
  - `V` = voldoende, `G` = goed, `VS` = vrijstelling — alle drie tellen als voldoende: **0 tekorten**.
  - `O` = onvoldoende — telt als **1 tekort**.
- **Tekortberekening** per student per periode:
  - Een cijfer dat afgerond onder 6 is, geeft `6 − afgerond cijfer` tekorten (5 → 1 tekort, 4 → 2 tekorten, enz.).
  - `V`, `G` en `VS` tellen als een voldoende: 0 tekorten.
  - `O` telt als 1 tekort.
- **Import** van cijfers via CSV- of Excel-bestand (`.csv`, `.tsv`, `.txt`, `.xlsx`), of via **kopiëren en plakken** direct uit Excel.
- **Import van studenten en vakken** via CSV- of Excel-bestand, met automatische herkenning van een kopregel. Bestaande studenten/vakken worden overgeslagen.
- **Rapport** per student per periode, netjes vormgegeven en printklaar (afdrukken als PDF via de browser).

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
- Optie "Ontbrekende vakken/studenten aanmaken" voegt onbekende namen automatisch toe.

### Studenten importeren

CSV met per rij: naam, (optioneel) studentnummer. Een kopregel zoals `Naam,Nummer` wordt automatisch herkend:

```csv
Naam,Nummer
Jan Jansen,1001
Piet Pietersen,1002
```

### Vakken importeren

CSV met per rij één vaknaam. Een kopregel zoals `Vak` wordt automatisch herkend:

```csv
Vak
Nederlands
Rekenen
Engels
```

## API (kort)

- `GET/POST /api/students`, `PUT/DELETE /api/students/<id>`
- `GET/POST /api/subjects`, `PUT/DELETE /api/subjects/<id>`
- `GET/POST /api/periods`, `PUT/DELETE /api/periods/<id>`
- `GET /api/grades?period_id=…`, `POST /api/grades` (één cijfer zetten/wissen)
- `POST /api/import` (bestand of tekst, form-data: `period_id`, `file` of `text`, `create_missing`)
- `POST /api/import/students` (form-data: `file` — CSV/Excel met naam + optioneel studentnummer)
- `POST /api/import/subjects` (form-data: `file` — CSV/Excel met vaknamen)
- `GET /api/report?period_id=…&student_id=…` (rapport met tekorten)
