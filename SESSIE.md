# Instructie voor een nieuwe sessie

Ga verder met RapportApp (https://github.com/HELDeuS/RapportApp, direct naar main committen is toegestaan; de app draait op een VM in /opt/RapportApp).

## Context

- Flask 3 + SQLite backend (app.py), vanilla JS frontend (static/app.js, index.html, style.css)
- Model: Crebo → Leertraject (met startcohort) → Module → Vak; Klas → Leertraject; crebo en cohort van een klas komen uit het leertraject
- Keuzedelen: apart vaksoort met SBU (doel 720), matrixoverzicht, bulk-koppeling en CSV-import van resultaten
- Specialisaties (keuzemodules): specialisatie → keuzemodule(s) die naast een bestaande module/periode lopen → vakken; studenten worden aan een specialisatie gekoppeld (bulk + CSV). Cijfers worden op het cijferoverzicht ingevoerd als extra kolommen in de periode waarin de keuzemodule loopt (alleen gekoppelde studenten kunnen een resultaat krijgen); ze tellen mee voor rapport, tekorten, signalering en 'rapport gereed'. Rapport toont per student de specialisatie(s) en de keuzemodule-vakken
- Statistieken: leerjaar/module/cohort/klas/student-filters, sorteerbaar, gepagineerd, rapporten (signalering, alle resultaten per student, gekoppelde studenten per keuzedeel, onvoldoendes, aanwezigheid, keuzedelen) met drill-downs
- Rapport: nette lay-out met info-blok (SLB'er, cohort, datum), ondertekenregels, logo-placeholder, print/PDF-vriendelijk
- Rechten: 5 rollen (beheerder/mentor/docent/administratie/student), UI toont alleen wat een rol mag
- E-mailmeldingen (Instellingen → E-mailmeldingen): SMTP volledig instelbaar; ontvangers zijn per meldingsoort (vergadering, rapport gereed) vinkjes per rol (beheerder/mentor/docent/administratie) — het systeem mailt alle actieve gebruikers binnen aangevinkte rollen met een e-mailadres (instelling `mail_roles_<event>`). Bij 'Rapport gereed' kan daarnaast een vinkje 'Student zelf' worden aangezet (instelling mail_students_rapport): de student krijgt dan een eigen mail op het e-mailadres uit de studentgegevens, altijd direct (nooit in de dagelijkse samenvatting). Modus direct of dagelijkse samenvatting; outbox-overzicht met sorteren/filteren/paginering; testmail-knop

## Werkwijze/afspraken

- Vóór elke push: `python3 -c "import quickjs; ctx = quickjs.Context(); ctx.eval('(function(){' + open('static/app.js').read() + '})')"` → moet JS_SYNTAX_OK geven
- API-tests: server starten met `RAPPORTAPP_DB=/tmp/test.db` (poort 5000), seeden met `seed_dummy.py --username beheerder --password rapportapp`; beheerder-wachtwoord is 'rapportapp', overige accounts 'welkom'
- Server apart starten (niet met &-achter-de-keten), stoppen met `pgrep -f "^python3 app.py$" | xargs -r kill`
- In de sandbox overleeft een achtergrondserver geen aparte bash-aanroep: start server, seed en tests binnen één aanroep, of gebruik `app.app_context()` voor directe functietests
- Elke nieuwe lijstoverzicht: sorteren, filteren en paginering zijn standaard onderdeel van de vraag
- VM-update: `cd /opt/RapportApp && sudo -u rapportapp git pull && sudo systemctl restart rapportapp`
- Commando's op de VM altijd met absolute paden (bijv. `/opt/RapportApp/venv/bin/python /opt/RapportApp/seed_dummy.py ...`); relatieve venv-paden geven buiten /opt/RapportApp "command not found"

## Open punten (todo)

- Cosmetisch: werkbalkbreedtes op tabblad Klassen vs. de tabellen eronder
- Bulk-PDF en mailen van rapporten: op het tabblad Rapport kun je met één klik PDF-rapporten genereren van de selectie (modus zip met aparte bestanden per student, of één bundel-PDF via pypdf) en de rapporten per student mailen als bijlage (fpdf2; gebruikt de SMTP-instellingen; studenten zonder e-mailadres worden overgeslagen en gerapporteerd). Rapporten (HTML en PDF) zijn gesorteerd op achternaam
- Toekomst: HTTPS (Caddy/nginx) vóór studentaccounts live gaan

Al afgerond (was eerder op deze lijst): wachtwoordbeleid (verplicht wijzigen bij eerste
login, min. 8 tekens), 720 SBU als instelling per crebo, grafieken en Excel-export in
statistieken, e-mailmeldingen aan studenten zelf.
