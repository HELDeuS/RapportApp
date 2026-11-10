# RapportApp — Mob ICT

Webapp voor het bijhouden van rapportcijfers van de opleiding Mob ICT.

## Functies

- **Studenten, vakken en periodes** beheren (CRUD). Niet elk vak hoeft in elke periode cijfers te hebben.
- **Cijfermatrix per periode**: voer per vak een cijfer (1–10), een **V** (vrijstelling) of een **O** (onvoldoende) in.
- **Tekortberekening** per student per periode:
  - Een cijfer dat afgerond onder 6 is, geeft `6 − afgerond cijfer` tekorten (5 → 1 tekort, 4 → 2 tekorten, enz.).
  - Een **V** (vrijstelling) telt als een voldoende: 0 tekorten.
  - Een **O** (onvoldoende) telt als 1 tekort.
- **Import** van cijfers via CSV- of Excel-bestand (`.csv`, `.tsv`, `.txt`, `.xlsx`), of via **kopiëren en plakken** direct uit Excel.
- **Rapport** per student per periode, netjes vormgegeven en printklaar (afdrukken als PDF via de browser).

## Draaien

```bash
pip install -r requirements.txt
python app.py
```

Open daarna <http://127.0.0.1:5000>. De SQLite-database `rapportapp.db` wordt automatisch aangemaakt.

## Importformaat

Zowel bestanden als geplakte tekst volgen dezelfde tabelvorm:

| (leeg/Naam) | Nederlands | Rekenen | ... |
|-------------|-----------|---------|-----|
| Jan         | 7,5       | V       |     |
| Piet        | O         | 5,2     |     |

- Eerste kolom: studentnaam of studentnummer.
- Eerste rij: vaknamen (kopregel).
- Cellen: cijfer (punt of komma als decimaalteken), `V`, `O` of leeg.
- Optie "Ontbrekende vakken/studenten aanmaken" voegt onbekende namen automatisch toe.

## API (kort)

- `GET/POST /api/students`, `PUT/DELETE /api/students/<id>`
- `GET/POST /api/subjects`, `PUT/DELETE /api/subjects/<id>`
- `GET/POST /api/periods`, `PUT/DELETE /api/periods/<id>`
- `GET /api/grades?period_id=…`, `POST /api/grades` (één cijfer zetten/wissen)
- `POST /api/import` (bestand of tekst, form-data: `period_id`, `file` of `text`, `create_missing`)
- `GET /api/report?period_id=…&student_id=…` (rapport met tekorten)
