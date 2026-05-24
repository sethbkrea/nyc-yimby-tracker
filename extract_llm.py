"""LLM-based extraction. One Claude call per article, structured output.

Works on whatever text we have — excerpt from RSS now, full body once RSS.app's
Full Content Extraction is enabled. Same code either way.
"""
from __future__ import annotations

import html
import json
import os
import re
import sys
from dataclasses import dataclass, field, asdict
from typing import Any

from anthropic import Anthropic

DEFAULT_MODEL = os.environ.get("CLAUDE_MODEL", "claude-haiku-4-5")

_TOOL = {
    "name": "save_article",
    "description": "Save the structured fields extracted from a YIMBY real-estate article.",
    "input_schema": {
        "type": "object",
        "properties": {
            "address": {
                "type": "string",
                "description": "Primary address mentioned (with building name if present). Empty string if not mentioned.",
            },
            "street_address": {
                "type": "string",
                "description": "Just the street address portion (numbers + street), no building name.",
            },
            "neighborhood": {
                "type": "string",
                "description": "NYC neighborhood, e.g. 'Murray Hill', 'Bedford-Stuyvesant', 'Hunts Point'. Empty if not in NYC.",
            },
            "borough": {
                "type": "string",
                "enum": ["Manhattan", "Brooklyn", "Queens", "Staten Island", "The Bronx", ""],
                "description": "NYC borough. Use empty string for projects outside NYC.",
            },
            "type": {
                "type": "string",
                "description": "Project type — e.g. 'residential', 'mixed-use', 'commercial', 'hotel', 'office', 'retail', 'industrial', 'institutional', 'park'. Empty if unclear.",
            },
            "developer": {
                "type": "string",
                "description": "Developer / owner / applicant company name. Empty if not mentioned.",
            },
            "architect": {
                "type": "string",
                "description": "Architect of record. Empty if not mentioned.",
            },
            "number_of_units": {
                "type": ["integer", "null"],
                "description": "Total residential units. Null if not mentioned.",
            },
            "square_footage": {
                "type": ["integer", "null"],
                "description": "Total project square footage. Null if not mentioned.",
            },
            "stories": {
                "type": ["integer", "null"],
                "description": "Number of stories / floors. Null if not mentioned.",
            },
            "height_ft": {
                "type": ["integer", "null"],
                "description": "Building height in feet. Null if not mentioned.",
            },
            "transaction_amount": {
                "type": ["number", "null"],
                "description": "Sale or financing amount in USD. Null if article is not about a transaction.",
            },
            "price_per_unit": {
                "type": ["number", "null"],
                "description": "Price per unit in USD if mentioned.",
            },
            "price_per_square_foot": {
                "type": ["number", "null"],
                "description": "Price per square foot in USD if mentioned.",
            },
            "buyer": {
                "type": "string",
                "description": "Buyer name. Empty if not a sale.",
            },
            "seller": {
                "type": "string",
                "description": "Seller name. Empty if not a sale.",
            },
            "brokers": {
                "type": "string",
                "description": "Broker(s) on the deal. Empty if not mentioned.",
            },
            "date_of_transaction": {
                "type": "string",
                "description": "ISO date (YYYY-MM-DD) of the transaction if specified. Empty if not a transaction.",
            },
            "notes": {
                "type": "string",
                "description": "Any other notable detail (timeline, status, design notes, etc) in 1-2 short sentences. Empty if nothing to add.",
            },
        },
        "required": [
            "address",
            "street_address",
            "neighborhood",
            "borough",
            "type",
            "developer",
            "architect",
            "number_of_units",
            "square_footage",
            "stories",
            "height_ft",
            "transaction_amount",
            "price_per_unit",
            "price_per_square_foot",
            "buyer",
            "seller",
            "brokers",
            "date_of_transaction",
            "notes",
        ],
    },
}

_SYSTEM = (
    "You extract structured real-estate data from New York YIMBY articles. "
    "Always call the save_article tool exactly once. Use empty string or null when "
    "a field is not mentioned — never fabricate values. Units are integers, money is "
    "numeric (no $ or commas)."
)


@dataclass
class LLMArticle:
    url: str
    scraped_at: str
    title: str
    body: str

    address: str = ""
    street_address: str = ""
    neighborhood: str = ""
    borough: str = ""
    notes: str = ""

    # Development fields
    type: str = ""
    developer: str = ""
    architect: str = ""
    number_of_units: int | None = None
    square_footage: int | None = None
    stories: int | None = None
    height_ft: int | None = None

    # Transaction fields
    transaction_amount: float | None = None
    price_per_unit: float | None = None
    price_per_square_foot: float | None = None
    buyer: str = ""
    seller: str = ""
    brokers: str = ""
    date_of_transaction: str = ""

    def as_record(self) -> dict[str, Any]:
        return asdict(self)


def _strip_html(s: str) -> str:
    if not s:
        return ""
    text = re.sub(r"<[^>]+>", " ", s)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


_client: Anthropic | None = None


def _get_client() -> Anthropic:
    global _client
    if _client is None:
        _client = Anthropic()  # reads ANTHROPIC_API_KEY
    return _client


def extract_with_llm(title: str, body_text: str, model: str = DEFAULT_MODEL) -> dict[str, Any]:
    """Call Claude with the schema, return the tool input as a dict."""
    client = _get_client()
    prompt = (
        f"Article title: {title}\n\n"
        f"Article body:\n{body_text}\n\n"
        "Extract every field you can verify from the text above. Leave the rest blank/null."
    )
    msg = client.messages.create(
        model=model,
        max_tokens=2000,
        system=_SYSTEM,
        tools=[_TOOL],
        tool_choice={"type": "tool", "name": "save_article"},
        messages=[{"role": "user", "content": prompt}],
    )
    for block in msg.content:
        if block.type == "tool_use" and block.name == "save_article":
            return block.input  # type: ignore[return-value]
    raise RuntimeError(f"Claude did not call save_article tool. Response: {msg.content!r}")


def llm_parse_item(item, scraped_at: str) -> LLMArticle:
    """Build an LLMArticle from a FeedItem. Calls Claude once."""
    title = (item.title or "").strip()
    body = _strip_html(item.description)
    fields = extract_with_llm(title, body)

    return LLMArticle(
        url=item.url,
        scraped_at=scraped_at,
        title=title,
        body=body,
        **{k: v for k, v in fields.items() if k in _allowed_fields()},
    )


def _allowed_fields() -> set[str]:
    return {
        "address", "street_address", "neighborhood", "borough", "notes",
        "type", "developer", "architect",
        "number_of_units", "square_footage", "stories", "height_ft",
        "transaction_amount", "price_per_unit", "price_per_square_foot",
        "buyer", "seller", "brokers", "date_of_transaction",
    }
