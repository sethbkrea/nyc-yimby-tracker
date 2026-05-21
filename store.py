"""Append-only JSON file as the database. One record per article."""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from extract import Article

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

    def append(self, articles: list[Article]) -> int:
        if not articles:
            return 0
        records = _read(self.path)
        now = datetime.now(timezone.utc).isoformat()
        for a in articles:
            records.append(
                {
                    "url": a.url,
                    "address": a.address,
                    "developer": a.developer,
                    "neighborhood": a.neighborhood,
                    "borough": a.borough,
                    "notes": a.notes,
                    "body": a.body,
                    "scraped_at": now,
                }
            )
        _write(self.path, records)
        return len(articles)

    def count(self) -> int:
        return len(_read(self.path))
