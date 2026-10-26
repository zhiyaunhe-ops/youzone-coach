# Skill authoring policy

## Reading map

| Task | Owner |
|---|---|
| Review or revise a skill | This policy |
| Add a skill or change an approved context budget or reference route | [Machine policy](../.skill-policy.json) |
| Inspect automated enforcement | [Checker](../scripts/check-skill-policy.py) and [workflow](../.github/workflows/skill-policy.yml) |

## Three disclosure layers

1. **Description:** Explain the capability, the task that should select it, and a useful boundary where confusion is likely. Keep it plain and discriminating. Put commands, paths, ports, schemas, benchmark results and historical incidents in supporting material.
2. **Entrypoint:** Keep the shared purpose, essential workflow, non-obvious constraints and conditional reading map in `SKILL.md`. A reader should know what to do and which detail to fetch without loading every resource.
3. **Resources:** Put substantial mode, platform, project, API and troubleshooting detail in focused references. Use scripts for repeated deterministic mechanics and assets for output material. Link each required resource and state when it applies. Preserve one maintenance owner for each rule.

Keep important operating invariants when moving detail. A shorter file is not an improvement if it loses outcome verification, version authority, uncertain-result recovery or the user's authorization boundaries. Do not replace a short self-contained skill with unnecessary routing files.

## Automated guardrails

The workflow runs on pushes, pull requests and manual dispatch. The machine policy declares the reviewed skill entrypoints and conditional references. New `SKILL.md` files must be declared or explicitly excluded; adding an entrypoint must not silently bypass review. Existing out-of-scope entrypoints are listed explicitly rather than being rewritten by this policy.

- YAML must parse and provide the declared `name` and a nonempty, single-line plain `description`. Folded YAML is allowed. Existing host-specific metadata keys remain valid.
- A description is limited to **400 characters** and cannot contain inline code, URLs or absolute local paths. These are discovery metadata; operational detail belongs in the body or references.
- Each approved `SKILL.md` is limited to **8,000 characters**, normalized to LF. This is a regression guardrail with headroom, not a target, token estimate or proof of clarity. Review the reason before changing a budget.
- Local file links and heading fragments must resolve. Declared conditional references must be directly discoverable from their entrypoint. Code examples, remote URLs and output placeholders are distinguished from local document routes.
- The checker tests both accepted examples and failing fixtures, including custom metadata, folded descriptions, CJK text, line endings, missing routes and undisclosed entrypoints.

## Review that CI cannot replace

Review whether the description selects the intended task and excludes likely confusion. Verify that resource links describe a real read-when condition and that ordinary work does not require every reference. Check that detailed migrations preserve necessary constraints, and that examples or project incidents have not become universal requirements. Review positive, negative and overlapping task examples when a trigger changes.

The automated gate reports structural and budget compliance. It does not measure model routing accuracy, validate product claims, or certify business approval. Keep those conclusions separate from a green workflow.

## Run locally

```text
python -m pip install PyYAML==6.0.3
python -m unittest discover -s tests -p test_skill_policy.py
python scripts/check-skill-policy.py --config .skill-policy.json
```

The checker and its tests are mirrored across the four independent skill repositories so each workflow works from its own checkout. When changing the common checker, update those copies together and retain their regression coverage. Each repository owns its own inventory and context budgets in `.skill-policy.json`.

## Related documents

- [Repository overview](../README.md)
- [Machine policy](../.skill-policy.json)
- [Workflow](../.github/workflows/skill-policy.yml)

## Advisory semantic review

The semantic CI workflow calls one local rule owner and runner at `%USERPROFILE%/.skills-manager/semantic-review` through the registered Windows workers. It reviews committed base/head changes and bounded related references, then publishes line-numbered findings as notices, a job summary and JSON/Markdown artifacts. No model score or finding blocks a merge; the existing static policy job remains separate.

Rules, model settings and runtime are maintained in the shared [semantic review repository](https://github.com/zhiyaunhe-ops/skills-manager-semantic-review). The local Windows user session, workers and existing Codex login must be available. Reports distinguish reviewed, partial, skipped and unavailable results. See the [semantic workflow](../.github/workflows/skill-semantic-review.yml) for invocation; no Skill Creator installation is needed in a repository.
