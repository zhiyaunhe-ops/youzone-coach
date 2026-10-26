"""Behavior-focused tests for the repository skill policy checker."""
from __future__ import annotations

import importlib.util
import tempfile
import unittest
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check-skill-policy.py"
SPEC = importlib.util.spec_from_file_location("skill_policy_checker", SCRIPT)
checker = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = checker
SPEC.loader.exec_module(checker)


class SkillPolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "skills" / "demo").mkdir(parents=True)
        (self.root / "references").mkdir()
        self.entry = self.root / "skills" / "demo" / "SKILL.md"
        self.ref = self.root / "references" / "details.md"
        self.policy = {"schema_version": 1, "description_max_chars": 400, "skills": [{"path": "skills/demo/SKILL.md", "name": "demo", "max_chars": 8000, "reference_docs": ["references/details.md"]}], "excluded_skills": []}
        self._write_valid()

    def tearDown(self):
        self.tmp.cleanup()

    def _write_valid(self, description=None, root_tail="", ref_text=None, crlf=False):
        description = description if description is not None else "Folded 说明 routes readers to focused details."
        entry = ("---\nname: demo\ndescription: >-\n  " + description + "\ncustom_host_key:\n  retained: true\n---\n" "Read [the focused details](../../references/details.md#usage).\n" "Example: `[fake](missing.md)`\n\n```md\n[also ignored](absent.md)\n```\n" + root_tail)
        ref_text = ref_text if ref_text is not None else "# Usage\n\nA valid local reference.\n"
        if crlf:
            entry, ref_text = entry.replace("\n", "\r\n"), ref_text.replace("\n", "\r\n")
        self.entry.write_bytes(entry.encode("utf-8"))
        self.ref.write_bytes(ref_text.encode("utf-8"))

    def _errors(self):
        return checker.validate_policy(self.root, self.policy)

    def test_accepts_custom_metadata_folded_scalar_cjk_crlf_and_ignored_examples(self):
        self._write_valid(crlf=True)
        self.assertEqual([], self._errors())

    def test_rejects_malformed_yaml(self):
        self.entry.write_text("---\nname: [broken\ndescription: x\n---\n", encoding="utf-8")
        self.assertTrue(any("invalid YAML frontmatter" in e for e in self._errors()))

    def test_rejects_identity_mismatch(self):
        self.entry.write_text(self.entry.read_text(encoding="utf-8").replace("name: demo", "name: other"), encoding="utf-8")
        self.assertTrue(any("name must be 'demo'" in e for e in self._errors()))

    def test_rejects_parsed_multiline_description(self):
        self._write_valid(description="first line\n\n  second line")
        self.assertTrue(any("description must be one line" in e for e in self._errors()))

    def test_rejects_oversized_description(self):
        self._write_valid(description="x" * 401)
        self.assertTrue(any("description is 401 characters" in e for e in self._errors()))

    def test_rejects_inline_code_urls_and_absolute_paths(self):
        cases = [("Contains `inline code`.", "inline code"), ("Visit https://example.invalid/docs.", "URLs"), ("Uses C:\\private\\folder.", "absolute local paths"), ("Reads /home/user/private/files.", "absolute local paths"), ("Reads /tmp.", "absolute local paths")]
        for value, expected in cases:
            with self.subTest(value=value):
                self._write_valid(description=value)
                self.assertTrue(any(expected in e for e in self._errors()))

    def test_rejects_broken_local_link_and_anchor(self):
        self._write_valid(root_tail="[missing](not-here.md)\n[bad anchor](../../references/details.md#absent)\n")
        errors = self._errors()
        self.assertTrue(any("target does not exist" in e for e in errors))
        self.assertTrue(any("anchor does not exist" in e for e in errors))

    def test_rejects_link_that_escapes_repository(self):
        self._write_valid(root_tail="[escape](../../../../outside.md)\n")
        self.assertTrue(any("escapes repository root" in e for e in self._errors()))

    def test_requires_declared_route_to_be_reachable(self):
        self._write_valid()
        old = "[the focused details](../../references/details.md#usage)"
        self.entry.write_text(self.entry.read_text(encoding="utf-8").replace(old, "A focused detail is available."), encoding="utf-8")
        self.assertTrue(any("not linked from its entrypoint" in e for e in self._errors()))

    def test_requires_reference_file_to_exist(self):
        self.ref.unlink()
        self.assertTrue(any("declared reference document is missing" in e for e in self._errors()))

    def test_requires_new_skill_entrypoints_to_be_declared(self):
        new_skill = self.root / "skills" / "new" / "SKILL.md"
        new_skill.parent.mkdir()
        new_skill.write_text("---\nname: new\ndescription: new\n---\n", encoding="utf-8")
        self.assertTrue(any("undeclared SKILL.md entrypoint: skills/new/SKILL.md" in e for e in self._errors()))

    def test_excluded_existing_skill_is_accounted_for_without_audit(self):
        excluded = self.root / "legacy" / "SKILL.md"
        excluded.parent.mkdir()
        excluded.write_text("not audited", encoding="utf-8")
        self.policy["excluded_skills"] = ["legacy/SKILL.md"]
        self.assertEqual([], self._errors())

    def test_char_budget_counts_unicode_after_line_ending_normalization(self):
        self._write_valid(root_tail="中文" * 100, crlf=True)
        normalized_len = len(self.entry.read_text(encoding="utf-8").replace("\r\n", "\n"))
        self.policy["skills"][0]["max_chars"] = normalized_len
        self.assertEqual([], self._errors())
        self.policy["skills"][0]["max_chars"] -= 1
        self.assertTrue(any("root SKILL.md is" in e for e in self._errors()))


if __name__ == "__main__":
    unittest.main()