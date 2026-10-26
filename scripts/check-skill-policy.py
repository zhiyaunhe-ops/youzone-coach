#!/usr/bin/env python3
"""Validate declared skill entrypoints and their progressive-disclosure routes."""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
from pathlib import Path
from typing import Any, NamedTuple

import yaml

FRONTMATTER = re.compile(r"\A---\n(.*?)\n---(?:\n|\Z)", re.DOTALL)
INLINE_LINK = re.compile(r"!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+[^)]*)?\)")
REFERENCE_LINK = re.compile(r"^\s{0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)")
HTML_LINK = re.compile(r"<a\b[^>]*\bhref\s*=\s*(['\"])(.*?)\1", re.IGNORECASE)
HTML_ID = re.compile(r"\b(?:id|name)\s*=\s*(['\"])(.*?)\1", re.IGNORECASE)
FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
URL = re.compile(r"(?:https?|ftp)://|\bwww\.", re.IGNORECASE)
WINDOWS_ABS = re.compile(r"(?<![\w])[A-Za-z]:[\\/][^\s`]+")
UNC_ABS = re.compile(r"(?<!\S)(?:\\\\|//)[^\s/\\]+[\\/][^\s]+")
POSIX_ABS = re.compile(r"(?<![\w:])/(?:[A-Za-z0-9_.~+-]+/)*[A-Za-z0-9_.~+-]+")
HOME_ABS = re.compile(r"(?<![\w])~[\\/][^\s`]+")


class Link(NamedTuple):
    line: int
    destination: str
    target: Path | None
    fragment: str
    external: bool = False


def _inside(root: Path, path: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _safe_repo_path(root: Path, raw: str) -> Path | None:
    if not isinstance(raw, str) or not raw or "\x00" in raw:
        return None
    rel = Path(raw.replace("\\", "/"))
    if rel.is_absolute() or re.match(r"^[A-Za-z]:", raw) or raw.startswith(("//", "\\\\")):
        return None
    resolved = (root / rel).resolve()
    return resolved if _inside(root, resolved) else None


def _frontmatter(path: Path, errors: list[str]) -> tuple[str, dict[str, Any] | None]:
    try:
        text = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n")
    except (OSError, UnicodeError) as exc:
        errors.append(f"{path}: cannot read UTF-8 file ({exc})")
        return "", None
    match = FRONTMATTER.match(text)
    if not match:
        errors.append(f"{path}: missing or malformed YAML frontmatter")
        return text, None
    try:
        data = yaml.safe_load(match.group(1))
    except yaml.YAMLError as exc:
        errors.append(f"{path}: invalid YAML frontmatter ({exc})")
        return text, None
    if not isinstance(data, dict):
        errors.append(f"{path}: YAML frontmatter must be a mapping")
        return text, None
    return text, data


def _description_errors(description: Any, limit: int, label: str) -> list[str]:
    errors: list[str] = []
    if not isinstance(description, str) or not description.strip():
        return [f"{label}: description must be a non-empty string"]
    if "\n" in description or "\r" in description:
        errors.append(f"{label}: description must be one line")
    if len(description) > limit:
        errors.append(f"{label}: description is {len(description)} characters; maximum is {limit}")
    if "`" in description:
        errors.append(f"{label}: description must not contain inline code")
    if URL.search(description):
        errors.append(f"{label}: description must not contain URLs")
    if WINDOWS_ABS.search(description) or UNC_ABS.search(description) or POSIX_ABS.search(description) or HOME_ABS.search(description):
        errors.append(f"{label}: description must not contain absolute local paths")
    return errors


def _plain_line(line: str) -> str:
    """Remove inline-code spans so example links inside code are ignored."""
    return re.sub(r"(`+).*?\1", "", line)


def _markdown_links(text: str) -> list[tuple[int, str]]:
    links: list[tuple[int, str]] = []
    fence: tuple[str, int] | None = None
    for number, line in enumerate(text.splitlines(), 1):
        opening = FENCE.match(line)
        if opening:
            marker = opening.group(1)
            if fence is None:
                fence = (marker[0], len(marker))
            elif marker[0] == fence[0] and len(marker) >= fence[1]:
                fence = None
            continue
        if fence is not None:
            continue
        line = _plain_line(line)
        for match in INLINE_LINK.finditer(line):
            dest = match.group(1).strip()
            if dest.startswith("<") and dest.endswith(">"):
                dest = dest[1:-1]
            links.append((number, dest))
        ref = REFERENCE_LINK.match(line)
        if ref:
            dest = ref.group(1).strip().strip("<>")
            links.append((number, dest))
        for match in HTML_LINK.finditer(line):
            links.append((number, match.group(2).strip()))
    return links


def _anchor_slug(text: str) -> str:
    text = urllib.parse.unquote(text).strip().lower()
    text = re.sub(r"<[^>]*>", "", text)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    # GitHub-style heading IDs retain letters (including CJK), numbers and hyphens.
    chars = [ch if (ch.isalnum() or ch in "- ") else "" for ch in text]
    return re.sub(r"-+", "-", re.sub(r"\s+", "-", "".join(chars))).strip("-")


def _anchors(path: Path) -> set[str]:
    text = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n")
    found: set[str] = set()
    counts: dict[str, int] = {}
    fence: tuple[str, int] | None = None
    for line in text.splitlines():
        opening = FENCE.match(line)
        if opening:
            marker = opening.group(1)
            if fence is None:
                fence = (marker[0], len(marker))
            elif marker[0] == fence[0] and len(marker) >= fence[1]:
                fence = None
            continue
        if fence is not None:
            continue
        heading = re.match(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$", line)
        if heading:
            base = _anchor_slug(re.sub(r"`([^`]*)`", r"\1", heading.group(1)))
            n = counts.get(base, 0)
            counts[base] = n + 1
            found.add(base if n == 0 else f"{base}-{n}")
        for ident in HTML_ID.finditer(line):
            found.add(urllib.parse.unquote(ident.group(2)))
    return found


def _resolve_link(root: Path, source: Path, line: int, dest: str, errors: list[str]) -> Link:
    parsed = urllib.parse.urlsplit(dest)
    if parsed.scheme or parsed.netloc or dest.startswith(("mailto:", "tel:")):
        return Link(line, dest, None, parsed.fragment, True)
    raw_path = urllib.parse.unquote(parsed.path)
    fragment = urllib.parse.unquote(parsed.fragment)
    if not raw_path:
        target = source.resolve()
    else:
        if re.match(r"^[A-Za-z]:[\\/]", raw_path) or raw_path.startswith(("//", "\\\\", "/")):
            errors.append(f"{source}:{line}: absolute local link is not allowed: {dest}")
            return Link(line, dest, None, fragment)
        target = (source.parent / raw_path.replace("\\", "/")).resolve()
    if not _inside(root, target):
        errors.append(f"{source}:{line}: local link escapes repository root: {dest}")
        return Link(line, dest, None, fragment)
    if not target.exists():
        errors.append(f"{source}:{line}: local link target does not exist: {dest}")
        return Link(line, dest, target, fragment)
    if fragment and target.is_file() and target.suffix.lower() == ".md":
        try:
            anchors = _anchors(target)
        except (OSError, UnicodeError) as exc:
            errors.append(f"{source}:{line}: cannot inspect linked Markdown {dest}: {exc}")
            return Link(line, dest, target, fragment)
        if fragment not in anchors and _anchor_slug(fragment) not in anchors:
            errors.append(f"{source}:{line}: local Markdown anchor does not exist: {dest}")
    return Link(line, dest, target, fragment)


def _discover_skill_paths(root: Path) -> set[str]:
    paths: set[str] = set()
    for path in root.rglob("SKILL.md"):
        rel = path.relative_to(root)
        if ".git" in rel.parts:
            continue
        paths.add(rel.as_posix())
    return paths


def validate_policy(root: Path, config: dict[str, Any]) -> list[str]:
    root = root.resolve()
    errors: list[str] = []
    if config.get("schema_version") != 1:
        errors.append("policy: schema_version must be 1")
    desc_limit = config.get("description_max_chars")
    if not isinstance(desc_limit, int) or isinstance(desc_limit, bool) or desc_limit < 1:
        errors.append("policy: description_max_chars must be a positive integer")
        desc_limit = 400
    skills = config.get("skills")
    excluded = config.get("excluded_skills", [])
    if not isinstance(skills, list) or not skills:
        errors.append("policy: skills must be a non-empty array")
        skills = []
    if not isinstance(excluded, list) or not all(isinstance(x, str) for x in excluded):
        errors.append("policy: excluded_skills must be an array of repository-relative paths")
        excluded = []
    declared: set[str] = set()
    entries: list[tuple[dict[str, Any], Path]] = []
    for item in skills:
        if not isinstance(item, dict):
            errors.append("policy: each skills item must be an object")
            continue
        raw_path = item.get("path")
        if not isinstance(raw_path, str):
            errors.append("policy: each skill needs a repository-relative path")
            continue
        rel = Path(raw_path.replace("\\", "/"))
        norm = rel.as_posix()
        if rel.is_absolute() or ".." in rel.parts or norm in declared:
            errors.append(f"policy: invalid or duplicate skill path: {raw_path}")
            continue
        declared.add(norm)
        path = _safe_repo_path(root, raw_path)
        if path is None:
            errors.append(f"policy: skill path escapes repository: {raw_path}")
            continue
        entries.append((item, path))
    excluded_set: set[str] = set()
    for raw_path in excluded:
        rel = Path(raw_path.replace("\\", "/"))
        norm = rel.as_posix()
        if rel.is_absolute() or ".." in rel.parts or norm in excluded_set:
            errors.append(f"policy: invalid or duplicate excluded skill path: {raw_path}")
        excluded_set.add(norm)
    overlap = declared & excluded_set
    if overlap:
        errors.append(f"policy: paths cannot be both skills and excluded: {', '.join(sorted(overlap))}")
    discovered = _discover_skill_paths(root)
    expected = declared | excluded_set
    for path in sorted(discovered - expected):
        errors.append(f"policy: undeclared SKILL.md entrypoint: {path}")
    for path in sorted(expected - discovered):
        errors.append(f"policy: declared SKILL.md entrypoint is missing: {path}")

    for item, entrypoint in entries:
        label = item.get("path", str(entrypoint))
        expected_name = item.get("name")
        max_chars = item.get("max_chars")
        if not isinstance(expected_name, str) or not expected_name:
            errors.append(f"{label}: policy name must be a non-empty string")
        if not isinstance(max_chars, int) or isinstance(max_chars, bool) or max_chars < 1:
            errors.append(f"{label}: max_chars must be a positive integer")
            max_chars = 8000
        refs = item.get("reference_docs", [])
        if not isinstance(refs, list) or not all(isinstance(x, str) for x in refs):
            errors.append(f"{label}: reference_docs must be an array of repository-relative paths")
            refs = []
        if not entrypoint.is_file():
            errors.append(f"{label}: declared entrypoint does not exist")
            continue
        text, frontmatter = _frontmatter(entrypoint, errors)
        if len(text) > max_chars:
            errors.append(f"{label}: root SKILL.md is {len(text)} characters; maximum is {max_chars}")
        if frontmatter is None:
            continue
        if frontmatter.get("name") != expected_name:
            errors.append(f"{label}: name must be {expected_name!r}, got {frontmatter.get('name')!r}")
        errors.extend(_description_errors(frontmatter.get("description"), desc_limit, label))

        links = [_resolve_link(root, entrypoint, line, dest, errors) for line, dest in _markdown_links(text)]
        linked_targets = {link.target for link in links if link.target is not None}
        ref_paths: set[str] = set()
        for ref in refs:
            ref_path = _safe_repo_path(root, ref)
            if ref_path is None:
                errors.append(f"{label}: reference path escapes repository: {ref}")
                continue
            if not ref_path.is_file():
                errors.append(f"{label}: declared reference document is missing: {ref}")
                continue
            if ref_path.suffix.lower() != ".md":
                errors.append(f"{label}: reference_docs entries must be Markdown files: {ref}")
                continue
            if ref_path not in linked_targets:
                errors.append(f"{label}: reference document is not linked from its entrypoint: {ref}")
            ref_paths.add(str(ref_path.relative_to(root)))
            ref_text, _ = _frontmatter_optional(ref_path, errors)
            for line, dest in _markdown_links(ref_text):
                _resolve_link(root, ref_path, line, dest, errors)
    return errors


def _frontmatter_optional(path: Path, errors: list[str]) -> tuple[str, dict[str, Any] | None]:
    """Read reference Markdown without requiring YAML frontmatter."""
    try:
        return path.read_text(encoding="utf-8-sig").replace("\r\n", "\n"), None
    except (OSError, UnicodeError) as exc:
        errors.append(f"{path}: cannot read UTF-8 file ({exc})")
        return "", None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=".skill-policy.json", help="policy JSON path (default: .skill-policy.json)")
    parser.add_argument("--root", default=".", help="repository root (default: current directory)")
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    config_path = (root / args.config).resolve()
    if not _inside(root, config_path):
        print("error: policy config must be inside repository root", file=sys.stderr)
        return 2
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        print(f"error: cannot load policy JSON {config_path}: {exc}", file=sys.stderr)
        return 2
    if not isinstance(config, dict):
        print("error: policy JSON root must be an object", file=sys.stderr)
        return 2
    errors = validate_policy(root, config)
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1
    print(f"Skill policy passed: {len(config['skills'])} declared skill(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())