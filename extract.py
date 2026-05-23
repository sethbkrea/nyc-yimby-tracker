"""Parse a YIMBY article (HTML or RSS item) into structured fields."""
from __future__ import annotations

import html
import re
from dataclasses import dataclass

from bs4 import BeautifulSoup

BOROUGHS = ("Manhattan", "Brooklyn", "Queens", "Staten Island", "The Bronx")
_BOROUGH_RE = "|".join(re.escape(b) for b in BOROUGHS)


@dataclass
class Article:
    url: str
    address: str
    developer: str
    neighborhood: str
    borough: str
    notes: str
    body: str

    def as_row(self) -> list[str]:
        # Column order in the sheet: Address | Developer | Link | Neighborhood | Borough | Notes | Complete Article
        return [
            self.address,
            self.developer,
            self.url,
            self.neighborhood,
            self.borough,
            self.notes,
            self.body,
        ]


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _title_from_soup(soup: BeautifulSoup) -> str:
    og = soup.find("meta", attrs={"property": "og:title"})
    if og and og.get("content"):
        title = og["content"]
    else:
        h1 = soup.find("h1")
        title = h1.get_text(" ", strip=True) if h1 else (soup.title.string if soup.title else "")
    # Strip trailing " - New York YIMBY" suffix.
    return re.sub(r"\s*[-–|]\s*New York YIMBY\s*$", "", _clean(title))


def _body_from_soup(soup: BeautifulSoup) -> str:
    container = soup.select_one(".entry-content") or soup.find("article")
    if not container:
        return ""
    # Drop the trailing social-promo block and "Subscribe to YIMBY's..." links.
    text = container.get_text(" ", strip=True)
    text = re.sub(
        r"Subscribe to YIMBY.+",
        "",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    return _clean(text)


_BOROUGH_SLUG = {
    "manhattan": "Manhattan",
    "brooklyn": "Brooklyn",
    "queens": "Queens",
    "staten-island": "Staten Island",
    "the-bronx": "The Bronx",
}


def _parse_location_from_url(url: str) -> tuple[str, str]:
    """Best-effort: extract (neighborhood, borough) from URL slug ".../<slug>.html"."""
    slug = url.rstrip("/").rsplit("/", 1)[-1].removesuffix(".html")
    for slug_boro, canonical in _BOROUGH_SLUG.items():
        suffix = f"-{slug_boro}"
        if slug.endswith(suffix):
            head = slug[: -len(suffix)]
            m = re.search(r"-in-([a-z0-9-]+)$", head)
            if m:
                nbh = m.group(1).replace("-", " ").title()
                return nbh, canonical
            return "", canonical
    return "", ""


def _parse_location(title: str, body: str, url: str) -> tuple[str, str, str]:
    """Return (address, neighborhood, borough). Any may be empty."""
    address = neighborhood = borough = ""

    # Pattern A: "...at|for <ADDRESS> in <NEIGHBORHOOD>, <BOROUGH>"
    m = re.search(
        rf"\b(?:at|for)\s+(.+?)\s+in\s+(.+?),\s+({_BOROUGH_RE})\b",
        title,
    )
    if m:
        address, neighborhood, borough = m.group(1), m.group(2), m.group(3)
    else:
        # Pattern B: just "...in <NEIGHBORHOOD>, <BOROUGH>" (no explicit address in title).
        m = re.search(
            rf"\bin\s+(.+?),\s+({_BOROUGH_RE})\b",
            title,
        )
        if m:
            neighborhood, borough = m.group(1), m.group(2)

    # If still no address, try the body's first sentence.
    if not address and body:
        m = re.search(
            rf"\b(?:at|for)\s+([0-9][^\.]+?)\s+in\s+(?:[^\.]+?),\s+(?:{_BOROUGH_RE})\b",
            body,
        )
        if m:
            address = m.group(1)

    # URL-slug fallback for neighborhood/borough.
    if not borough or not neighborhood:
        url_nbh, url_boro = _parse_location_from_url(url)
        if not borough:
            borough = url_boro
        if not neighborhood:
            neighborhood = url_nbh

    return _clean(address), _clean(neighborhood), _clean(borough)


def _parse_developer(body: str) -> str:
    if not body:
        return ""
    patterns = [
        # "X of Y is listed as the (owner|developer|applicant)..."
        r"(?:^|\.\s+)([A-Z][^.]{2,120}?)\s+is\s+listed\s+as\s+the\s+(?:owner|developer|applicant)\b",
        # "developer X" / "developed by X"
        r"(?:developed\s+by|developer)\s+([A-Z][A-Za-z0-9&\.,'\- ]{2,120}?)(?:\.|,|\sis\b|\swill\b|\splans\b|\shas\b)",
        # "X is the developer"
        r"([A-Z][A-Za-z0-9&\.,'\- ]{2,120}?)\s+is\s+the\s+developer\b",
    ]
    for pat in patterns:
        m = re.search(pat, body)
        if m:
            return _clean(m.group(1))
    return ""


def _parse_notes(body: str) -> str:
    """Pick out the key project facts: floors, units, sqft, architect."""
    if not body:
        return ""
    bits: list[str] = []

    m = re.search(r"\b(\d{1,3})-story\b", body)
    if m:
        bits.append(f"{m.group(1)} stories")

    m = re.search(r"\b(\d{1,4})-foot-tall\b", body)
    if m:
        bits.append(f"{m.group(1)} ft tall")

    m = re.search(r"\b([\d,]{3,})\s+square\s+feet\b", body)
    if m:
        bits.append(f"{m.group(1)} sq ft")

    m = re.search(r"\b(\d{1,4})\s+(?:residences|residential\s+units|units|apartments)\b", body)
    if m:
        bits.append(f"{m.group(1)} units")

    m = re.search(
        r"(?:^|(?<=\.\s))([A-Z][A-Za-z0-9&'\.\- ]{2,80}(?:\s+(?:Architect|Architects|Architecture|Studio|Group|Design|PLLC|LLC|PC|P\.C\.))[A-Za-z0-9&\.,'\- ]{0,40}?)\s+is\s+listed\s+as\s+the\s+architect(?:\s+of\s+record)?",
        body,
    )
    if m:
        bits.append(f"Architect: {_clean(m.group(1))}")

    return "; ".join(bits)


def _strip_html(s: str) -> str:
    """Strip HTML tags + decode entities + collapse whitespace."""
    if not s:
        return ""
    text = re.sub(r"<[^>]+>", " ", s)
    text = html.unescape(text)
    return _clean(text)


def _parse_developer_rss(text: str) -> str:
    """RSS excerpts use 'project from X' phrasing more than 'X is listed as'."""
    if not text:
        return ""
    m = re.search(
        r"\bproject\s+from\s+([A-Z][A-Za-z0-9&'\.\- ]{2,100}?)(?=\s+at\b|\s+in\b|\.|,)",
        text,
    )
    if m:
        return _clean(m.group(1))
    m = re.search(
        r"\b(?:by|from)\s+([A-Z][A-Za-z0-9&'\.\- ]{2,100}?)(?:\s+(?:Architecture|Architects|Design|Studio|Group|Development|Construction|Real\s+Estate|Holdings|Partners|Capital))",
        text,
    )
    if m:
        # include the trailing company-type word
        full = m.group(0)
        prefix = re.match(r"^(?:by|from)\s+", full).group(0)
        return _clean(full[len(prefix):])
    return ""


def _parse_notes_rss(text: str) -> str:
    """Variant of _parse_notes that handles hyphenated 'X-story', 'X-unit' RSS phrasing."""
    if not text:
        return ""
    bits: list[str] = []

    m = re.search(r"\b(\d{1,3})-story\b", text)
    if m:
        bits.append(f"{m.group(1)} stories")

    m = re.search(r"\b(\d{1,4})-foot-tall\b", text)
    if m:
        bits.append(f"{m.group(1)} ft tall")

    m = re.search(r"\b([\d,]{3,})\s+square\s+feet\b", text)
    if m:
        bits.append(f"{m.group(1)} sq ft")

    # "137-unit", "1,700-unit", "99-residence", "137 units" / "99 residences"
    m = re.search(r"\b([\d,]{1,7})[-\s](?:unit|units|residence|residences|apartments?)\b", text)
    if m:
        bits.append(f"{m.group(1)} units")

    m = re.search(
        r"\bfrom\s+([A-Z][A-Za-z0-9&'\.\- ]{2,80}?\s+(?:Architecture|Architects|Design|Studio))\b",
        text,
    )
    if m:
        bits.append(f"Architect: {_clean(m.group(1))}")

    return "; ".join(bits)


def parse_rss_item(item) -> Article:
    """Build an Article from a FeedItem — no per-article HTML fetch.

    Loses the full article body (we only have the RSS excerpt) but avoids
    Cloudflare entirely. The excerpts are surprisingly informative.
    """
    title = _clean(item.title)
    desc = _strip_html(item.description)
    blob = f"{title}. {desc}"

    address, neighborhood, borough = _parse_location(title, desc, item.url)

    # Try the HTML-style "X is listed as" patterns first (rarely match RSS),
    # then fall back to RSS-style "project from X" phrasing.
    developer = _parse_developer(blob) or _parse_developer_rss(blob)
    notes = _parse_notes(blob) or _parse_notes_rss(blob)

    return Article(
        url=item.url,
        address=address,
        developer=developer,
        neighborhood=neighborhood,
        borough=borough,
        notes=notes,
        body=desc,
    )


def parse_article(html: str, url: str) -> Article:
    soup = BeautifulSoup(html, "lxml")
    title = _title_from_soup(soup)
    body = _body_from_soup(soup)
    address, neighborhood, borough = _parse_location(title, body, url)
    developer = _parse_developer(body)
    notes = _parse_notes(body)
    return Article(
        url=url,
        address=address,
        developer=developer,
        neighborhood=neighborhood,
        borough=borough,
        notes=notes,
        body=body,
    )
