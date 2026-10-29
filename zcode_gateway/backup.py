"""Backup export/restore for the gateway's portable data.

One .zip holds everything needed to move an install or recover from a crash:

- config.yaml, model-caps.json            (gateway settings)
- accounts/                                (Zcode login snapshots)
- gateway.db                               (usage history)
- generator-data/                          (packaged-install state: relays.json
                                            incl. deployed worker URLs, mail
                                            config with domains + inbox secret)
- generator state from the generator's
  data dir (source checkouts: output/,
  packaged: generator-data/)               (mail_config.json — email domains +
                                            inbox_url + inbox_secret — pool.json,
                                            proxies*, registered.json,
                                            pending_referral.json,
                                            generator_options.json, results/)

Skipped: chromium browser profiles (regenerated, ~100s of MB), logs,
screenshots — diagnostic, not state.

Restore wipes and replaces the data it knows about, then reports which parts
need a gateway restart to take effect.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import sqlite3
import zipfile
from datetime import datetime
from pathlib import Path

BACKUP_VERSION = 2
MANIFEST = "backup-manifest.json"

# top-level entries captured from the base dir
FILE_ENTRIES = ("config.yaml", "model-caps.json")
DIR_ENTRIES = ("accounts", "generator-data")

# generator data-dir state files: the valuable, hard-to-recreate parts
GEN_FILES = (
    "mail_config.json",          # email domains + inbox_url + INBOX_SECRET
    "generator_options.json",
    "registered.json",
    "pending_referral.json",
    "pool.json",
    "pool.json.bak",
    "proxies.txt",
    "proxies_evergood.txt",
    "proxies_bad.txt",
    "proxies_used.txt",
    "proxies_raw.txt",
    "proxy_sources_stats.json",
    "ip_country.json",
    "recovery_accounts.txt",
)
GEN_DIRS = ("results",)


def _base_dir():
    from .paths import base_dir
    return base_dir()


def _gen_data_dirs() -> list[Path]:
    """Every generator data dir that may hold state (first existing wins per kind).

    A packaged install uses <base>/generator-data; a source checkout the
    generator's output/. Both are scanned — the same file never lands twice
    (later dirs only fill files earlier ones missed).
    """
    from .paths import app_dir
    base = _base_dir()
    here = app_dir()
    candidates = [
        base / "generator-data",
        here / "generator-data",
        here / "generator" / "output",
        here / "output",
    ]
    out: list[Path] = []
    for c in candidates:
        if c.is_dir() and c not in out:
            out.append(c)
    return out


def export_backup(out_dir: Path | None = None) -> Path:
    """Zip the portable state into out_dir (default: the base dir)."""
    base = _base_dir()
    out_dir = out_dir or base
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = out_dir / f"zcode-gateway-backup-{stamp}.zip"

    manifest = {
        "version": BACKUP_VERSION,
        "created": datetime.now().isoformat(timespec="seconds"),
        "entries": [],
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        added: set[str] = set()

        def add_file(src: Path, arcname: str) -> None:
            if arcname in added or not src.is_file() or src.is_symlink():
                return
            zf.write(src, arcname)
            added.add(arcname)
            if arcname not in manifest["entries"]:
                manifest["entries"].append(arcname)

        def add_tree(d: Path, prefix: str) -> None:
            if not d.is_dir():
                return
            for f in sorted(d.rglob("*")):
                if f.is_file() and not f.is_symlink():
                    add_file(f, prefix + str(f.relative_to(d)))

        for name in FILE_ENTRIES:
            add_file(base / name, name)
        for name in DIR_ENTRIES:
            add_tree(base / name, name + "/")

        # generator state: data dirs in priority order, first existing wins
        gen_dirs = _gen_data_dirs()
        for gd in gen_dirs:
            for name in GEN_FILES:
                add_file(gd / name, "generator-data/" + name)
            for name in GEN_DIRS:
                add_tree(gd / name, f"generator-data/{name}/")

        # SQLite: a raw copy mid-write can be torn; serialize via the backup
        # API into a temp file, then zip the bytes
        db = base / "gateway.db"
        if db.is_file():
            import tempfile
            with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tf:
                tmp_path = tf.name
            dst = sqlite3.connect(tmp_path)
            src = sqlite3.connect(str(db))
            with dst:
                src.backup(dst)
            dst.commit()
            src.close()
            dst.close()
            zf.write(tmp_path, "gateway.db")
            os.unlink(tmp_path)
            if "gateway.db" not in manifest["entries"]:
                manifest["entries"].append("gateway.db")

        zf.writestr(MANIFEST, json.dumps(manifest, indent=2))
    dest.write_bytes(buf.getvalue())
    return dest


def restore_backup(zip_path: Path) -> dict:
    """Replace the portable state from a backup zip.

    Returns a summary; config changes need a gateway restart to apply.
    """
    base = _base_dir()
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        if MANIFEST not in names:
            raise ValueError("not a Zcode Gateway backup (manifest missing)")
        manifest = json.loads(zf.read(MANIFEST))
        if manifest.get("version", 0) > BACKUP_VERSION:
            raise ValueError(f"backup from a newer version ({manifest['version']})")

        restored = {"files": 0, "dirs": [], "db": False, "config": False,
                    "mail": False, "relays": False}
        for name in FILE_ENTRIES:
            if name in names:
                (base / name).parent.mkdir(parents=True, exist_ok=True)
                zf.extract(name, base)
                restored["files"] += 1
                restored["config"] = restored["config"] or name == "config.yaml"

        # group members by their top-level dir so each is wiped once, replaced whole
        by_dir: dict[str, list[str]] = {}
        for m in names:
            top = m.split("/", 1)[0]
            if m.endswith("/") or top in ("", MANIFEST.split(".")[0]):
                continue
            if top in DIR_ENTRIES or top == "generator-data":
                by_dir.setdefault(top, []).append(m)
        for top, members in by_dir.items():
            d = base / top
            if d.is_dir():
                shutil.rmtree(d)
            d.mkdir(parents=True, exist_ok=True)
            for m in members:
                zf.extract(m, base)
            restored["files"] += len(members)
            restored["dirs"].append(top)
            if top == "generator-data":
                for m in members:
                    if m.endswith("mail_config.json"):
                        restored["mail"] = True
                    if m.endswith("relays.json"):
                        restored["relays"] = True

        if "gateway.db" in names:
            tmp = base / "gateway.db.restore-tmp"
            tmp.write_bytes(zf.read("gateway.db"))
            os.replace(tmp, base / "gateway.db")
            restored["db"] = True
        restored["backup_created"] = manifest.get("created")
        restored["restart_required"] = bool(restored["config"] or restored["db"])
        return restored
