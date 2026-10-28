"""Backup export/restore for the gateway's portable data.

One .zip holds everything a user needs to move an install or recover from a
crash: config.yaml, the accounts/ snapshots, generator-data (options, relays,
mail config, results), model-caps.json and the SQLite usage DB. Logs are
skipped — they are diagnostic, not state.

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

BACKUP_VERSION = 1
MANIFEST = "backup-manifest.json"

# top-level entries captured from the base dir
FILE_ENTRIES = ("config.yaml", "model-caps.json")
DIR_ENTRIES = ("accounts", "generator-data")


def _base_dir():
    from .paths import base_dir
    return base_dir()


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
        for name in FILE_ENTRIES:
            p = base / name
            if p.is_file():
                zf.write(p, name)
                manifest["entries"].append(name)
        for name in DIR_ENTRIES:
            d = base / name
            if not d.is_dir():
                continue
            for f in sorted(d.rglob("*")):
                if f.is_file() and not f.is_symlink():
                    zf.write(f, str(f.relative_to(base)))
            manifest["entries"].append(name + "/")
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

        restored = {"files": 0, "dirs": [], "db": False, "config": False}
        for name in FILE_ENTRIES:
            if name in names:
                (base / name).parent.mkdir(parents=True, exist_ok=True)
                zf.extract(name, base)
                restored["files"] += 1
                restored["config"] = restored["config"] or name == "config.yaml"
        for name in DIR_ENTRIES:
            members = [n for n in names if n.startswith(name + "/")]
            if not members:
                continue
            d = base / name
            if d.is_dir():
                shutil.rmtree(d)
            d.mkdir(parents=True, exist_ok=True)
            for m in members:
                zf.extract(m, base)
            restored["dirs"].append(name)
        if "gateway.db" in names:
            # write via a temp + replace: the live DB may be open
            tmp = base / "gateway.db.restore-tmp"
            tmp.write_bytes(zf.read("gateway.db"))
            os.replace(tmp, base / "gateway.db")
            restored["db"] = True
        restored["backup_created"] = manifest.get("created")
        return restored
