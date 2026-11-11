#!/usr/bin/env python3
"""Maak een backup van de RapportApp-database.

Gebruik (standaard, op de server):
    sudo -u rapportapp venv/bin/python backup.py

Opties:
    --db <pad>      database (standaard RAPPORTAPP_DB of /opt/RapportApp/rapportapp.db)
    --dest <map>    bestemming (standaard /opt/RapportApp/backups)
    --keep <n>      aantal dagen dat backups bewaard blijven (standaard 14; 0 = alles bewaren)

De sqlite3-backup-API werkt ook terwijl de server draait; de backup is
altijd een consistent geheel. Draai dit dagelijks via de systemd-timer
uit de README.
"""

import argparse
import glob
import os
import sqlite3
import sys
import time


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.environ.get(
        "RAPPORTAPP_DB", os.path.join(here, "rapportapp.db")))
    ap.add_argument("--dest", default=os.path.join(here, "backups"))
    ap.add_argument("--keep", type=int, default=14)
    args = ap.parse_args()

    if not os.path.exists(args.db):
        sys.exit(f"Database niet gevonden: {args.db}")

    os.makedirs(args.dest, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    path = os.path.join(args.dest, f"rapportapp-{stamp}.db")

    src = sqlite3.connect(args.db)
    dst = sqlite3.connect(path)
    with dst:
        src.backup(dst)
    dst.close()
    src.close()

    if args.keep > 0:
        backups = sorted(glob.glob(os.path.join(args.dest, "rapportapp-*.db")))
        for old in backups[:-args.keep]:
            os.remove(old)
            print(f"Oude backup verwijderd: {old}")

    size = os.path.getsize(path)
    print(f"Backup gemaakt: {path} ({size / 1024:.0f} KiB)")


if __name__ == "__main__":
    main()
