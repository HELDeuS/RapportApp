#!/usr/bin/env python3
"""Vul de RapportApp met dummydata voor testdoeleinden.

Gebruik (server moet draaien):
    python3 seed_dummy.py --url http://127.0.0.1:5000 --username beheerder --password <wachtwoord>

Draai dit op een lege (of Test-)database; het script controleert niet op bestaande data.
"""

import argparse
import http.cookiejar
import json
import random
import sys
import urllib.request

random.seed(42)


class Client:
    """Minimale HTTP-client met cookies (geen externe dependencies)."""

    def __init__(self, base):
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar))

    def request(self, method, path, json_body=None, form=None):
        url = self.base + path
        headers = {}
        data = None
        if json_body is not None:
            data = json.dumps(json_body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif form is not None:
            data = form
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=30) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8") or "{}")
        except urllib.error.URLError as e:
            if isinstance(e.reason, ConnectionRefusedError):
                sys.exit(f"Kan geen verbinding maken met {self.base}."
                         "\nDraait de server? Controleer met:"
                         "\n  sudo systemctl status rapportapp"
                         "\nZonodig herstarten:"
                         "\n  sudo systemctl restart rapportapp")
            raise

    def get(self, path):
        return self.request("GET", path)

    def put(self, path, json_body=None):
        return self.request("PUT", path, json_body=json_body)

    def post(self, path, json_body=None):
        return self.request("POST", path, json_body=json_body)

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
    ap.add_argument("--reset", action="store_true",
                    help="Leeg de database (alle data en gebruikers behalve jezelf)")
    args = ap.parse_args()
    s = Client(args.url)
    status, body = s.post("/api/auth/login",
                          {"username": args.username, "password": args.password})
    if status != 200:
        sys.exit(f"Inloggen mislukt: {body.get('error', body)}")
    print("Ingelogd.")

    if args.reset:
        status, body = s.post("/api/admin/reset", {})
        if status != 200:
            sys.exit(f"Reset mislukt: {body.get('error', body)}")
        print("Database geleegd: studenten, cijfers, vakken, modules, klassen, "
              "cohorten, crebos en alle andere gebruikers zijn verwijderd.")
        return

    # ---------------------------------------------------------------- crebos
    s.post("/api/crebos", {"name": "niveau 4"})
    _, data = s.get("/api/crebos")
    crebos = {n["name"]: n["id"] for n in data}
    niv = crebos["niveau 4"]

    # --------------------------------------------------------------- cohorten
    for c in ["23-24", "24-25", "25-26"]:
        s.post("/api/cohorts", {"name": c})
    _, data = s.get("/api/cohorts")
    cohorts = {c["name"]: c["id"] for c in data}
    print("Crebos en cohorten klaar.")

    # ---------------------------------------------------------------- modules
    # 3 leerjaren x 4 modules; modules tellen door (M1..M12).
    for i in range(1, 13):
        leerjaar = (i - 1) // 4 + 1
        s.post("/api/periods", {"name": f"M{i}", "year": f"Leerjaar {leerjaar}"})
    _, data = s.get("/api/periods")
    periods = {p["name"]: p["id"] for p in data}
    print("Modules klaar.")

    # ----------------------------------------------------------- leertrajecten
    # 3-jarig traject (M1-M12) en 2-jarig traject (M1-M8) onder hetzelfde crebo.
    trajecten = [
        ("ICT-medewerker 3-jarig 25-26", "25-26", [f"M{i}" for i in range(1, 13)]),
        ("ICT-medewerker 2-jarig 24-25", "24-25", [f"M{i}" for i in range(1, 9)]),
        ("ICT-medewerker 3-jarig 23-24", "23-24", [f"M{i}" for i in range(1, 13)]),
    ]
    leertrajecten = {}
    for name, cohort, mods in trajecten:
        _, body = s.post("/api/leertrajecten",
                         {"name": name, "crebo_id": niv, "cohort_id": cohorts[cohort]})
        s.put(f"/api/leertrajecten/{body['id']}",
              {"period_ids": [periods[m] for m in mods]})
        leertrajecten[name] = body["id"]
    print("Leertrajecten klaar.")

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
        s.post("/api/subjects", {
            "name": name, "assessment_type": atype,
            "period_ids": [periods[m] for m in mods],
        })
    _, data = s.get("/api/subjects")
    subj_list = {x["name"]: x for x in data}
    print(f"{len(subjects)} vakken klaar.")

    # ---------------------------------------------------------- mentoren/docenten
    for first, prefix, last in MENTOR_NAMES:
        s.post("/api/users", {
            "username": (first + "." + last).lower().replace(" ", ""),
            "password": "welkom", "role": "mentor",
            "first_name": first, "last_name": last,
            "email": f"{first.lower()}@school.nl"})
    for first, prefix, last in DOCENT_NAMES:
        s.post("/api/users", {
            "username": (first + "." + last).lower().replace(" ", ""),
            "password": "welkom", "role": "docent",
            "first_name": first, "last_name": last,
            "email": f"{first.lower()}@school.nl"})
    s.post("/api/users", {
        "username": "administratie", "password": "welkom", "role": "administratie",
        "first_name": "Admin", "last_name": "Medewerker", "email": "administratie@school.nl"})
    _, users = s.get("/api/users")
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
        traject = ("ICT-medewerker 2-jarig 24-25" if leerjaar == 2
                   else f"ICT-medewerker 3-jarig {cohort}")
        _, body = s.post("/api/classes", {
            "name": name, "crebo_id": niv,
            "leertraject_id": leertrajecten[traject],
            "mentor_id": mentors[i]["id"]})
        class_ids.append((body["id"], leerjaar, name))
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
            _, body = s.post("/api/students", {
                "student_number": str(number),
                "first_name": first, "prefix": prefix, "last_name": last,
                "email": f"s{number}@school.nl", "class_id": cid})
            made.append(body["id"])
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
                    s.post("/api/grades", {
                        "student_id": stid, "subject_id": subj_list[name]["id"],
                        "period_id": pid, "value": v})
                    grades += 1
                present = random.randint(80, 100)
                rest = 100 - present
                allowed = random.randint(0, rest)
                s.post("/api/attendance", {
                    "student_id": stid, "period_id": pid,
                    "present": present, "absent_allowed": allowed,
                    "absent_unallowed": rest - allowed})
                atts += 1
                if random.random() < 0.25:
                    s.post("/api/notes", {
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
    _, body = s.post("/api/students/bulk", {"ids": all_ids, "action": "login_on"})
    print(f"Studentaccounts: {body.get('affected', '?')}")

    print("\nKlaar! Overzicht:")
    print("  Modules: M1 t/m M12 (stage: M5, M6, M11, M12)")
    print("  Klassen: IAO1A/B, IAO2A/B, IAO3A/B (25 studenten elk, eigen mentor)")
    print("  Inloggen: beheerder/docent/mentor-accounts met wachtwoord 'welkom'")
    print("  Studenten loggen in met hun studentnummer, wachtwoord 'welkom'")


if __name__ == "__main__":
    main()
