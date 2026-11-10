#!/usr/bin/env python3
"""Build data/software.json from the Imperial Research Software Directory.

The directory (https://github.com/ImperialCollegeLondon/research-software-directory)
keeps its list of research software in ``repos.csv``. That list has no notion of
department, so this script:

1. reads ``repos.csv`` (from a local path or the directory's GitHub URL);
2. enriches each GitHub repository with public metadata (description, language,
   topics, stars, last push) from the GitHub REST API, or from a cached JSON
   file when the API is unavailable;
3. attributes each repository to departments using the rules in
   ``data/software-attributions.json``;
4. writes ``data/software.json`` for the map.

Contact names and e-mail addresses in ``repos.csv`` are deliberately dropped.

Usage examples::

    # Live: fetch repos.csv and GitHub metadata (set GITHUB_TOKEN to avoid rate limits)
    python3 scripts/import_research_software.py

    # Offline: use a saved repos.csv and a metadata cache keyed by "owner/name"
    python3 scripts/import_research_software.py --csv repos.csv --metadata-cache meta.json

Only the Python standard library is used.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CSV_URL = (
    "https://raw.githubusercontent.com/ImperialCollegeLondon/"
    "research-software-directory/main/repos.csv"
)
DIRECTORY_URL = "https://github.com/ImperialCollegeLondon/research-software-directory"
GITHUB_API = "https://api.github.com/repos/"
USER_AGENT = "imperial-rse-map-importer"

# A repository with no push for this long is reported as inactive.
INACTIVE_AFTER = dt.timedelta(days=365)


def read_csv(source: str) -> list[dict[str, str]]:
    """Return the rows of repos.csv from a local path or an http(s) URL."""
    if source.startswith(("http://", "https://")):
        request = urllib.request.Request(source, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=30) as response:
            text = response.read().decode("utf-8")
    else:
        text = Path(source).read_text(encoding="utf-8")
    return list(csv.DictReader(io.StringIO(text)))


def github_slug(url: str) -> str | None:
    """Return "owner/name" for a github.com URL, otherwise None."""
    marker = "github.com/"
    if marker not in url:
        return None
    parts = url.split(marker, 1)[1].strip("/").split("/")
    return "/".join(parts[:2]) if len(parts) >= 2 else None


def fetch_github_metadata(slug: str, token: str | None) -> dict[str, Any] | None:
    """Fetch public metadata for one repository; None if it is missing or the call fails.

    GitHub redirects renamed or transferred repositories, which urllib follows,
    so the returned ``full_name`` may differ from the requested slug.
    """
    headers = {"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(GITHUB_API + slug, headers=headers)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = json.load(response)
            return {
                "full_name": data.get("full_name"),
                "description": data.get("description"),
                "language": data.get("language"),
                "topics": data.get("topics") or [],
                "pushed_at": data.get("pushed_at"),
                "created_at": data.get("created_at"),
                "stargazers_count": data.get("stargazers_count"),
                "archived": data.get("archived"),
                "html_url": data.get("html_url"),
                "homepage": data.get("homepage"),
            }
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            if error.code in (403, 429) and attempt < 2:
                # Rate limited: back off and retry.
                time.sleep(10 * (attempt + 1))
                continue
            print(f"warning: GitHub API {error.code} for {slug}", file=sys.stderr)
            return None
        except urllib.error.URLError as error:
            print(f"warning: could not reach GitHub for {slug}: {error.reason}", file=sys.stderr)
            return None
    return None


def load_attributions(path: Path) -> tuple[dict[str, dict], dict[str, dict]]:
    """Return (owner rules, repo rules), both keyed in lower case."""
    rules = json.loads(path.read_text(encoding="utf-8"))
    owners = {key.lower(): value for key, value in rules.get("owners", {}).items()}
    repos = {key.lower(): value for key, value in rules.get("repos", {}).items()}
    return owners, repos


def attribute(slug: str, owners: dict[str, dict], repos: dict[str, dict]) -> dict[str, Any]:
    """Apply the most specific matching attribution rule to a repository."""
    rule = repos.get(slug.lower()) or owners.get(slug.split("/")[0].lower())
    if not rule:
        return {"departments": [], "central": False, "group": None, "confidence": None}
    return {
        "departments": list(rule.get("departments", [])),
        "central": bool(rule.get("central", False)),
        "group": rule.get("group"),
        "confidence": rule.get("confidence"),
    }


def is_inactive(pushed_at: str | None, now: dt.datetime) -> bool | None:
    """True when the last push is older than INACTIVE_AFTER; None when unknown."""
    if not pushed_at:
        return None
    pushed = dt.datetime.fromisoformat(pushed_at.replace("Z", "+00:00"))
    return now - pushed > INACTIVE_AFTER


def build(rows: list[dict[str, str]], metadata: dict[str, dict], attributions_path: Path) -> dict[str, Any]:
    """Combine directory rows, metadata and attribution rules into the software document."""
    owners, repo_rules = load_attributions(attributions_path)
    now = dt.datetime.now(dt.timezone.utc)
    software = []
    seen_ids: set[str] = set()

    for row in rows:
        url = (row.get("url") or "").strip()
        slug = github_slug(url)
        if not slug:
            print(f"warning: skipping non-GitHub entry {url!r}", file=sys.stderr)
            continue

        meta = metadata.get(slug.lower()) or {}
        identifier = slug.lower().replace("/", "--").replace(".", "-")
        if identifier in seen_ids:
            continue
        seen_ids.add(identifier)

        attribution = attribute(slug, owners, repo_rules)
        software.append(
            {
                "id": identifier,
                "name": slug.split("/")[1],
                "repo": meta.get("html_url") or url,
                "owner": slug.split("/")[0],
                "description": meta.get("description"),
                "language": meta.get("language"),
                "topics": meta.get("topics") or [],
                "stars": meta.get("stargazers_count"),
                "lastPush": (meta.get("pushed_at") or "")[:10] or None,
                "archived": meta.get("archived"),
                "inactive": is_inactive(meta.get("pushed_at"), now),
                "doi": (row.get("doi") or "").strip() or None,
                "homepage": (row.get("homepage_url") or "").strip() or meta.get("homepage") or None,
                "featuredMonth": (row.get("rsotm") or "").strip() or None,
                "metadataAvailable": bool(meta),
                "departments": attribution["departments"],
                "central": attribution["central"],
                "attribution": {"group": attribution["group"], "confidence": attribution["confidence"]},
            }
        )

    software.sort(key=lambda item: item["name"].lower())
    return {
        "meta": {
            "description": (
                "Research software developed at Imperial, from the Imperial Research Software "
                "Directory. Inclusion does not imply central RSE team involvement."
            ),
            "source": DIRECTORY_URL,
            "generated": now.date().isoformat(),
            "attributionNote": (
                "Departments are inferred from the owning GitHub account or group using "
                "data/software-attributions.json and should be verified."
            ),
        },
        "software": software,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--csv", default=DEFAULT_CSV_URL, help="Path or URL of repos.csv.")
    parser.add_argument("--metadata-cache", type=Path, help="JSON file of metadata keyed by lower-case 'owner/name'. Skips the GitHub API.")
    parser.add_argument("--attributions", type=Path, default=ROOT / "data" / "software-attributions.json")
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "software.json")
    args = parser.parse_args()

    rows = read_csv(args.csv)

    if args.metadata_cache:
        metadata = {key.lower(): value for key, value in json.loads(args.metadata_cache.read_text(encoding="utf-8")).items()}
    else:
        token = os.environ.get("GITHUB_TOKEN")
        metadata = {}
        for row in rows:
            slug = github_slug(row.get("url", ""))
            if slug:
                result = fetch_github_metadata(slug, token)
                if result:
                    metadata[slug.lower()] = result

    document = build(rows, metadata, args.attributions)
    args.output.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    entries = document["software"]
    unattributed = [item["repo"] for item in entries if not item["departments"] and not item["central"]]
    print(
        f"Wrote {len(entries)} entries to {args.output} "
        f"({sum(item['metadataAvailable'] for item in entries)} with GitHub metadata, "
        f"{len(unattributed)} unattributed)."
    )
    for repo in unattributed:
        print(f"  unattributed: {repo}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
