#!/usr/bin/env python3
"""Vul de RapportApp met dummydata voor testdoeleinden.

Gebruik (server moet draaien):
    python3 seed_dummy.py --url http://127.0.0.1:5000 --username beheerder --password <wachtwoord>

Draai dit op een lege (of Test-)database; het script controleert niet op bestaande data.
"""

import argparse
import random
import sys

import requests

random.seed(42)

FIRST_NAMES = ["Emma", "Lucas", "Sophie", "Daan", "Julia", "Sem", "Lisa", "Bram",
               "Sara", "Lars", "Noor", "Finn", "Eva", "Milan", "Anna", "Tijmen",
               "Fleur", "Jesse", "Iris", "Ruben", "Nora", "Tijs", "Lotte", "Sven",
               "Zoey", "Koen", "Roos", "Joris", "Maud", "Wout", "Elin", "Bas",
               "Veerle", "Thijs", "Nadia", "Pieter", "Yara", "Stefan", "Lena", "Jelle"]
PREFIXES = ["", "", "", "", "van", "de", "van der", "van den"]
LAST_NAMES = ["Jansen", "Berg", "Dijkstra", "Visser", "Smit", "Meijer", "Mulder",
              "Bos", "Vos", "Peters", "Hendriks", "van Leeuwen", "Bakker", "Kuiper",
              "Blom", "de Groot", "Willems", "Vermeulen", "Schipper", "Kuipers",
              "Dekker", "van Dijk", "Nieuwenhuis", "Hoekstra", "Smulders"]
MENTOR_NAMES = [("Marieke", "de", "Vries"), ("Johan", "", "Bakermans"),
                ("Fatima", "el", "Amrani"), ("Peter", "van", "Dongen"),
                ("Sanne", "", "Verhoeven"), ("Ahmed", "", "Benali")]
DOCENT_NAMES = [("Erik", "", "Jansma"), ("Karin", "van", "Zanten"),
                ("Tom", "", "Willemsen"), ("Bouchra", "", "El Idrissi"),
                ("Wim", "de", "Boer"), ("Nienke", "", "van Vliet"),
                ("Rob", "", "Kuylemans"), ("Dilan", "", "Kaya")]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:5000")
    ap.add_argument("--username", default="beheerder")
    ap.add_argument("--password", required=True)
    args = ap.parse_args()
    B = args.url.rstrip("/")

    s = requests.Session()
    r = s.post(f"{B}/api/auth/login",
               json={"username": args.username, "password": args.password})
    if r.status_code != 200:
        sys.exit(f"Inloggen mislukt: {r.text}")
    print("Ingelogd.")

    # ---------------------------------------------------------------- niveaus
    s.post(f"{B}/api/niveaus", json={"name": "niveau 4"})
    niveaus = {n["name"]: n["id"] for n in s.get(f"{B}/api/niveaus").json()}
    niv = niveaus["niveau 4"]

    # --------------------------------------------------------------- cohorten
    for c in ["23-24", "24-25", "25-26"]:
        s.post(f"{B}/api/cohorts", json={"name": c})
    cohorts = {c["name"]: c["id"] for c in s.get(f"{B}/api/cohorts").json()}
    print("Niveaus en cohorten klaar.")

    # ---------------------------------------------------------------- modules
    # 3 leerjaren x 4 modules; modules tellen door (M1..M12).
    for i in range(1, 13):
        leerjaar = (i - 1) // 4 + 1
        s.post(f"{B}/api/periods", json={"name": f"M{i}", "year": f"Leerjaar {leerjaar}"})
    periods = {p["name"]: p["id"] for p in s.get(f"{B}/api/periods").json()}
    print("Modules klaar.")

    # ----------------------------------------------------------------- vakken
    # (naam, type, [modules])
    subjects = [
        # Leerjaar 1 (M1-4): 5 technisch + 3 niet-technisch per module
        ("Microsoft 1", "cijfer", ["M1", "M2"]),
        ("Netwerken 1", "cijfer", ["M1", "M2", "M3", "M4"]),
        ("Hardware 1", "cijfer", ["M1"]),
        ("Virtualisatie 1", "cijfer", ["M1", "M2"]),
        ("Databases 1", "cijfer", ["M1"]),
        ("Linux 1", "cijfer", ["M2", "M3"]),
        ("Scripting 1", "cijfer", ["M2", "M3"]),
        ("Windows Server 1", "cijfer", ["M3", "M4"]),
        ("Security 1", "cijfer", ["M3"]),
        ("Webontwikkeling 1", "cijfer", ["M4"]),
        ("Cloud 1", "cijfer", ["M4"]),
        ("Mobile Development 1", "cijfer", ["M4"]),
        ("Nederlands 1", "cijfer", ["M1", "M2", "M3", "M4"]),
        ("Rekenen 1", "cijfer", ["M1", "M2"]),
        ("Communicatie 1", "letter", ["M1", "M2", "M3"]),
        ("Projectmanagement 1", "letter", ["M3", "M4"]),
        ("Loopbaan 1", "letter", ["M4"]),
        # Leerjaar 2: stagemodules M5/M6 + M7/M8
        ("Stage 1", "vnv", ["M5"]),
        ("Stage 2", "vnv", ["M6"]),
        ("Microsoft 2", "cijfer", ["M7", "M8"]),
        ("Netwerken 2", "cijfer", ["M7", "M8"]),
        ("Linux 2", "cijfer", ["M7", "M8"]),
        ("Scripting 2", "cijfer", ["M7", "M8"]),
        ("Security 2", "cijfer", ["M7", "M8"]),
        ("Nederlands 2", "cijfer", ["M7", "M8"]),
        ("Rekenen 2", "cijfer", ["M7"]),
        ("Communicatie 2", "letter", ["M8"]),
        ("Projectmanagement 2", "letter", ["M7", "M8"]),
        # Leerjaar 3: M9/M10 + stagemodules M11/M12
        ("Stage 3", "vnv", ["M11"]),
        ("Stage 4", "vnv", ["M12"]),
        ("Microsoft 3", "cijfer", ["M9", "M10"]),
        ("Netwerken 3", "cijfer", ["M9", "M10"]),
        ("Linux 3", "cijfer", ["M9", "M10"]),
        ("Scripting 3", "cijfer", ["M9", "M10"]),
        ("Cloud Security 3", "cijfer", ["M9", "M10"]),
        ("Nederlands 3", "cijfer", ["M9", "M10"]),
        ("Rekenen 3", "cijfer", ["M9"]),
        ("Loopbaan 3", "letter", ["M10"]),
        ("Projectmanagement 3", "letter", ["M9", "M10"]),
    ]
    for name, atype, mods in subjects:
        s.post(f"{B}/api/subjects", json={
            "name": name, "assessment_type": atype,
            "period_ids": [periods[m] for m in mods],
        })
    subj_list = {x["name"]: x for x in s.get(f"{B}/api/subjects").json()}
    print(f"{len(subjects)} vakken klaar.")

    # ---------------------------------------------------------- mentoren/docenten
    for first, prefix, last in MENTOR_NAMES:
        s.post(f"{B}/api/users", json={
            "username": (first + "." + last).lower().replace(" ", ""),
            "password": "welkom", "role": "mentor",
            "first_name": first, "last_name": last,
            "email": f"{first.lower()}@school.nl"})
    for first, prefix, last in DOCENT_NAMES:
        s.post(f"{B}/api/users", json={
            "username": (first + "." + last).lower().replace(" ", ""),
            "password": "welkom", "role": "docent",
            "first_name": first, "last_name": last,
            "email": f"{first.lower()}@school.nl"})
    s.post(f"{B}/api/users", json={
        "username": "administratie", "password": "welkom", "role": "administratie",
        "first_name": "Admin", "last_name": "Medewerker", "email": "administratie@school.nl"})
    users = s.get(f"{B}/api/users").json()
    mentors = [u for u in users if u["role"] == "mentor"]
    print(f"{len(mentors)} mentoren en {len(DOCENT_NAMES)} docenten klaar.")

    # ----------------------------------------------------------------- klassen
    # 2 klassen per leerjaar, unieke klascodes, eigen mentor, cohort per leerjaar.
    class_specs = [
        ("IAO1A", 1, "25-26"), ("IAO1B", 1, "25-26"),
        ("IAO2A", 2, "24-25"), ("IAO2B", 2, "24-25"),
        ("IAO3A", 3, "23-24"), ("IAO3B", 3, "23-24"),
    ]
    class_ids = []
    for i, (name, leerjaar, cohort) in enumerate(class_specs):
        r = s.post(f"{B}/api/classes", json={
            "name": name, "niveau_id": niv, "cohort_id": cohorts[cohort],
            "mentor_id": mentors[i]["id"]})
        class_ids.append((r.json()["id"], leerjaar, name))
    print("Klassen klaar.")

    # --------------------------------------------------------------- studenten
    number = 210001
    students_by_class = []
    for cid, leerjaar, cname in class_ids:
        made = []
        for i in range(25):
            first = random.choice(FIRST_NAMES)
            prefix = random.choice(PREFIXES)
            last = random.choice(LAST_NAMES)
            r = s.post(f"{B}/api/students", json={
                "student_number": str(number),
                "first_name": first, "prefix": prefix, "last_name": last,
                "email": f"s{number}@school.nl", "class_id": cid})
            made.append(r.json()["id"])
            number += 1
        students_by_class.append((cid, leerjaar, made))
    print("150 studenten klaar.")

    # --------------------------------------------- cijfers, aanwezigheid, opmerkingen
    def grade_for(atype):
        if atype == "vnv":
            return random.choice(["V", "V", "V", "NV"])
        if atype == "letter":
            return random.choice(["G", "V", "V", "V", "O"])
        return random.choice(["9", "8,5", "8", "7,5", "7", "7", "6,5", "6",
                              "6", "5,5", "5", "4,5", "VS"])

    modules_by_leerjaar = {1: ["M1", "M2", "M3", "M4"],
                           2: ["M5", "M6", "M7", "M8"],
                           3: ["M9", "M10", "M11", "M12"]}
    grades = atts = notes = 0
    for cid, leerjaar, stids in students_by_class:
        for m in modules_by_leerjaar[leerjaar]:
            pid = periods[m]
            active = [x for x in subjects if m in x[2]]
            for stid in stids:
                for name, atype, mods in active:
                    v = grade_for(atype)
                    s.post(f"{B}/api/grades", json={
                        "student_id": stid, "subject_id": subj_list[name]["id"],
                        "period_id": pid, "value": v})
                    grades += 1
                present = random.randint(80, 100)
                rest = 100 - present
                allowed = random.randint(0, rest)
                s.post(f"{B}/api/attendance", json={
                    "student_id": stid, "period_id": pid,
                    "present": present, "absent_allowed": allowed,
                    "absent_unallowed": rest - allowed})
                atts += 1
                if random.random() < 0.25:
                    s.post(f"{B}/api/notes", json={
                        "student_id": stid, "period_id": pid,
                        "comment": random.choice([
                            "Goede inzet deze module.",
                            "Let op de deadlines voor het volgende project.",
                            "Leuke ontwikkeling gezien deze module."]),
                        "teacher_comment": random.choice([
                            "Taalvaardigheid verdient extra aandacht.",
                            "Vraagt om meer uitdaging.",
                            "Goede samenwerking met medestudenten."])})
                    notes += 1
    print(f"{grades} cijfers, {atts} aanwezigheidsregistraties, {notes} opmerkingen klaar.")

    # ------------------------------------------------- inlogaccounts studenten
    all_ids = [sid for _, _, ids in students_by_class for sid in ids]
    r = s.post(f"{B}/api/students/bulk", json={"ids": all_ids, "action": "login_on"})
    print(f"Studentaccounts: {r.json().get('affected', '?')}")

    print("\nKlaar! Overzicht:")
    print("  Modules: M1 t/m M12 (stage: M5, M6, M11, M12)")
    print("  Klassen: IAO1A/B, IAO2A/B, IAO3A/B (25 studenten elk, eigen mentor)")
    print("  Inloggen: beheerder/docent/mentor-accounts met wachtwoord 'welkom'")
    print("  Studenten loggen in met hun studentnummer, wachtwoord 'welkom'")


if __name__ == "__main__":
    main()
