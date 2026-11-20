# Instructie voor een nieuwe sessie

Ga verder met RapportApp (https://github.com/HELDeuS/RapportApp, direct naar main committen is toegestaan; de app draait op een VM in /opt/RapportApp).

## Context

- Flask 3 + SQLite backend (app.py), vanilla JS frontend (static/app.js, index.html, style.css). Requirements: Flask, openpyxl, fpdf2, pypdf (geen andere externe deps; seed_dummy.py gebruikt alleen stdlib)
- Model: Crebo → Leertraject (met startcohort) → Module → Vak; Klas → Leertraject
- Keuzedelen: apart vaksoort met SBU (doel 720), matrixoverzicht, bulk-koppeling en CSV-import
- Specialisaties (keuzemodules): specialisatie → keuzemodule(s) naast een bestaande module → vakken (kind='keuzemodule'); student-specialisatie-koppeling (bulk + CSV). Cijfers in het cijferoverzicht als extra kolommen in de periode waarin de keuzemodule loopt (API weigert cijfers van niet-gekoppelde studenten); tellen mee voor rapport, tekorten, signalering, 'rapport gereed'
- Rapport: infoblok, ondertekenregels, logo, printvriendelijk; gesorteerd op achternaam. Bulk-PDF: POST /api/report/pdf met mode 'zip' (per student, naam rapport_<studentnummer>_<achternaam>_<voornaam>_<module>.pdf) of 'bundle' (één pdf via pypdf); bulk-mail: POST /api/report/mail mailt ieders rapport als bijlage (SMTP-instellingen, studenten zonder e-mail overgeslagen)
- Statistieken: filters op leerjaar/module/cohort/klas/student, sorteren/filteren/paginering, signalering en rapporten met drill-downs, Excel-export
- Rechten: cumulatief, beheerder ≥ mentor ≥ docent ≥ administratie. Mentor ziet en kan alles wat een docent kan (alle studenten zien, cijfers/aanwezigheid/opmerkingen/keuzedelen/specialisaties/importeren, statistieken, vergaderingen bekijken). Mentor-extra's (studenten/klassen muteren, keuzedelen/specialisaties bulk-koppelen, vergaderingen aanmaken/wijzigen) blijven beperkt tot eigen klas(len); backend handhaaft dit
- E-mailmeldingen: SMTP instelbaar; ontvangers per meldingsoort met rol-vinkjes; student-zelf-mail bij 'rapport gereed' is altijd direct; modus direct of dagelijkse samenvatting; outbox met sorteren/filteren/paginering

## Werkwijze/afspraken

- Vóór elke push: `python3 -c "import quickjs; ctx = quickjs.Context(); ctx.eval('(function(){' + open('static/app.js').read() + '})')"` (en `python3 -m py_compile app.py`)
- API-tests: server starten met `RAPPORTAPP_DB=/tmp/test.db python3 app.py`, seeden met `seed_dummy.py --username beheerder --password rapportapp`; beheerder-wachtwoord 'rapportapp', overige accounts 'welkom'. Let op: als de server HTTPS spreekt (RAPPORTAPP_TLS), gebruik `--url https://127.0.0.1:5000 --insecure` bij seed scripts
- Server stoppen met `pgrep -f "^python3 app.py$" | xargs -r kill`; start seed en tests binnen één bash-aanroep, of gebruik `app.app_context()` voor directe functietests
- Elke nieuwe lijstoverzicht: sorteren, filteren en paginering zijn standaard onderdeel van de vraag
- VM-update: `cd /opt/RapportApp && sudo -u rapportapp git pull && (eventueel pip install -r requirements.txt als requirements wijzigde, als rapportapp) && sudo systemctl restart rapportapp`. VM-commando's altijd met absolute paden; pip draaien als rapportapp (`sudo -u rapportapp /opt/RapportApp/venv/bin/pip ...`)
- Fpdf2 core-fonts zijn latin-1: er is een _pdf_sanitize/fallback voor Unicode (gebruikt DejaVu/Liberation als systeemfont beschikbaar is)

## Open punten (todo)

### Testfase: gemelde issues (echte data, collega-testers)

Werkwijze: gemelde problemen komen hieronder met urgentie (HOOG / MIDDEN / LAAG), worden NIET direct opgelost en later in volgorde van urgentie afgehandeld. Pas bij het daadwerkelijk oplossen van de lijst af.

(leeg — de eerste serie testfase-issues is opgelost, zie "Al afgerond")

### Overig

- Cosmetisch: werkbalkbreedtes op tabblad Klassen vs. de tabellen eronder
- Print-rapport (HTML/printerlay-out in de browser) verder verfijnen (PDF-lay-out is al netjes)
- Toekomst: HTTPS (Caddy/nginx) vóór studentaccounts live gaan

## Al afgerond

Testfase-issues ronde 1: gebruikersnamen hoofdletterongevoelig (login-lookup met COLLATE NOCASE, uniekcheck bij aanmaak en import, migratie met unieke NOCASE-index; bij al bestaande naamvarianten wordt de index overgeslagen en moeten dubbele accounts handmatig samengevoegd), studentenlijst met "alleen eigen klassen"-vinkje (default aan voor mentoren) en Login-kolom om een studentaccount aan te maken/activeren/deactiveren (POST /api/students/<id>/login, standaardwachtwoord 'welkom', mentor alleen eigen klas), logboektab alleen voor beheerders (backend + ROLE_TABS), logboektabel met vaste kolombreedtes en wrappende detailtekst (viel eerder deels uit beeld).
Wachtwoordbeleid (verplicht wijzigen bij eerste login, min. 8 tekens), 720 SBU als instelling per crebo, grafieken en Excel-export in statistieken, e-mailmeldingen aan studenten zelf, specialisaties/keuzemodules, bulk-PDF (zip + bundel) en rapporten mailen per student, mentorrechten gelijkgetrokken met docent (rollen cumulatief), sortering rapporten op achternaam, seed-script met --insecure/HTTPS-ondersteuning.
