"""Append-only JSON file as the database. One record per article."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

DEFAULT_PATH = Path(os.environ.get("ARTICLES_FILE", "articles.json"))


def _read(path: Path) -> list[dict[str, Any]]:
    if not path.exists() or path.stat().st_size == 0:
        return []
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def _write(path: Path, records: list[dict[str, Any]]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)
        f.write("\n")
    tmp.replace(path)


class Store:
    def __init__(self, path: Path = DEFAULT_PATH):
        self.path = path

    def existing_links(self) -> set[str]:
        return {r.get("url", "") for r in _read(self.path) if r.get("url")}

    def append_records(self, records: list[dict[str, Any]]) -> int:
        if not records:
            return 0
        existing = _read(self.path)
        existing.extend(records)
        _write(self.path, existing)
        return len(records)

    def count(self) -> int:
        return len(_read(self.path))
