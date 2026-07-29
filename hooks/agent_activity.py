#!/usr/bin/env python3
"""Platform-neutral activity ledger and PR-report helpers for coding agents."""

from __future__ import annotations

import argparse
import collections
import datetime
import hashlib
import json
import os
import pathlib
import re
import shlex
import subprocess
import sys
import tempfile
from typing import Any


MARKER = "<!-- skills-used:v1 -->"
LABELS = {
    "direct": "direct invocation",
    "model": "agent-invoked",
    "model-failed": "agent-invoked (failed)",
    "reference": "reference file",
    "instructions": "instructions",
}
EDITABLE_SUFFIXES = {
    ".c",
    ".cc",
    ".cpp",
    ".cs",
    ".cjs",
    ".go",
    ".h",
    ".hpp",
    ".java",
    ".js",
    ".jsx",
    ".kt",
    ".md",
    ".mdx",
    ".mjs",
    ".php",
    ".py",
    ".rb",
    ".rs",
    ".scala",
    ".swift",
    ".ts",
    ".tsx",
}


def timestamp() -> str:
    return datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def state_path(state_dir: str | pathlib.Path) -> pathlib.Path:
    return pathlib.Path(state_dir).expanduser()


def temporary_path(
    state_dir: str | pathlib.Path, kind: str, session_id: str
) -> pathlib.Path:
    state_key = hashlib.sha256(
        str(state_path(state_dir).resolve()).encode("utf-8")
    ).hexdigest()[:12]
    safe_session_id = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id or "unknown")
    return (
        pathlib.Path(tempfile.gettempdir())
        / f"agent-hooks-{state_key}-{kind}-{safe_session_id}.txt"
    )


def should_track(path: str) -> bool:
    candidate = pathlib.PurePath(path)
    parts = candidate.parts
    if not path or candidate.suffix not in EDITABLE_SUFFIXES:
        return False
    if candidate.name.endswith(".d.ts") or candidate.name.endswith(".min.js"):
        return False
    excluded = {"node_modules", "dist", "generated", "__generated__"}
    if excluded.intersection(parts):
        return False
    return not any(
        segment in {"plans", "projects"}
        and parts[index - 1] in {".agents", ".claude"}
        for index, segment in enumerate(parts)
        if index > 0
    ) and not path.startswith(("/tmp/", "/private/tmp/"))


def record_skill(
    *,
    state_dir: str | pathlib.Path,
    session_id: str,
    mode: str,
    skill: str,
    event: str | None = None,
    platform: str | None = None,
    agent: str | None = None,
    detail: str | None = None,
) -> None:
    ledger_dir = state_path(state_dir) / "skill-ledger"
    ledger_dir.mkdir(parents=True, exist_ok=True)
    row = {
        "ts": timestamp(),
        "mode": mode,
        "skill": skill or "unknown",
        "event": event,
        "session_id": session_id or "unknown",
        "platform": platform,
        "agent": agent,
        "detail": detail,
    }
    with (ledger_dir / f"{row['session_id']}.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\n")


def track_edit(
    *, state_dir: str | pathlib.Path, session_id: str, path: str, line_count: int
) -> bool:
    if not should_track(path):
        return False
    session = session_id or "unknown"
    with temporary_path(state_dir, "simplify-pending", session).open(
        "a", encoding="utf-8"
    ) as handle:
        handle.write(f"{path}\t{max(line_count, 1)}\n")
    with temporary_path(state_dir, "intent-pending", session).open(
        "a", encoding="utf-8"
    ) as handle:
        handle.write(f"{path}\n")
    return True


def pending(
    *, state_dir: str | pathlib.Path, kind: str, session_id: str, consume: bool
) -> dict[str, Any]:
    path = temporary_path(state_dir, f"{kind}-pending", session_id or "unknown")
    result: dict[str, Any] = {"files": [], "total": 0}
    if kind == "intent":
        result["anchor"] = str(
            temporary_path(state_dir, "intent-anchor", session_id or "unknown")
        )
    if not path.exists():
        return result
    lines = [line.rstrip("\n") for line in path.read_text(encoding="utf-8").splitlines() if line]
    if kind == "simplify":
        measurements = [line.rsplit("\t", 1) for line in lines]
        files = sorted({measurement[0] for measurement in measurements})
        total = sum(int(measurement[1]) for measurement in measurements)
    else:
        files = sorted(set(lines))
        total = 0
    if consume:
        path.unlink(missing_ok=True)
    return {**result, "files": files, "total": total}


def render_report(*, state_dir: str | pathlib.Path, session_id: str) -> pathlib.Path | None:
    state = state_path(state_dir)
    ledger = state / "skill-ledger" / f"{session_id or 'unknown'}.jsonl"
    if not ledger.exists():
        return None
    rows = [json.loads(line) for line in ledger.read_text(encoding="utf-8").splitlines() if line]
    skills = [row for row in rows if row["mode"] != "instructions"]
    aggregate: collections.OrderedDict[str, dict[str, Any]] = collections.OrderedDict()
    for row in skills:
        summary = aggregate.setdefault(
            row["skill"],
            {"modes": [], "count": 0, "first": row["ts"], "last": row["ts"], "agents": set()},
        )
        if row["mode"] not in summary["modes"]:
            summary["modes"].append(row["mode"])
        summary["count"] += 1
        summary["first"] = min(summary["first"], row["ts"])
        summary["last"] = max(summary["last"], row["ts"])
        if row.get("agent"):
            summary["agents"].add(row["agent"])
    output = [
        MARKER,
        "",
        "## Skills used",
        "",
        f"{len(aggregate)} skill(s) across {len(skills)} event(s) · session `{session_id}`",
        "",
        "| Skill | Invoked as | Events | First | Last |",
        "|---|---|---|---|---|",
    ]
    for skill, summary in aggregate.items():
        modes = ", ".join(LABELS.get(mode, mode) for mode in summary["modes"])
        if summary["agents"]:
            modes += f" · agent: {', '.join(sorted(summary['agents']))}"
        output.append(
            f"| `{skill}` | {modes} | {summary['count']} | "
            f"{summary['first'][11:16]} | {summary['last'][11:16]} |"
        )
    instructions = [row for row in rows if row["mode"] == "instructions"]
    if instructions:
        names = ", ".join(f"`{row['skill']}`" for row in instructions)
        output.extend(["", f"Instruction files loaded: {names}"])
    output.extend(["", f"<details><summary>Raw ledger ({len(rows)} events)</summary>", "", "```jsonl"])
    output.extend(json.dumps(row, separators=(",", ":")) for row in rows)
    output.extend(["```", "", "</details>", ""])
    artifacts = state / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    report = artifacts / f"skill-report-{session_id}.md"
    report.write_text("\n".join(output), encoding="utf-8")
    return report


def skill_count(*, state_dir: str | pathlib.Path, session_id: str, skill: str) -> int:
    ledger = state_path(state_dir) / "skill-ledger" / f"{session_id or 'unknown'}.jsonl"
    if not ledger.exists():
        return 0
    return sum(
        1
        for line in ledger.read_text(encoding="utf-8").splitlines()
        if line
        and (row := json.loads(line)).get("skill") == skill
        and row.get("mode") in {"direct", "model"}
    )


def command_arguments(command: str) -> list[str] | None:
    try:
        lexer = shlex.shlex(
            command, posix=True, punctuation_chars=";&|\n"
        )
        lexer.whitespace = " \t\r"
        lexer.whitespace_split = True
        lexer.commenters = ""
        return list(lexer)
    except ValueError:
        return None


def shell_segments(arguments: list[str]) -> list[list[str]]:
    segments: list[list[str]] = [[]]
    for argument in arguments:
        if argument and set(argument) <= {";", "&", "|", "\n"}:
            segments.append([])
        else:
            segments[-1].append(argument)
    return segments


def pr_invocations(
    arguments: list[str], *, depth: int = 0
) -> list[tuple[str, list[str]]]:
    if depth > 3:
        return []

    invocations: list[tuple[str, list[str]]] = []
    assignment = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
    for segment in shell_segments(arguments):
        index = 0
        while index < len(segment) and segment[index] in {
            "!",
            "(",
            "{",
            "do",
            "elif",
            "else",
            "if",
            "then",
            "until",
            "while",
        }:
            index += 1
        while index < len(segment) and assignment.match(segment[index]):
            index += 1
        while index < len(segment) and segment[index] in {"command", "nohup"}:
            index += 1
            while index < len(segment) and segment[index].startswith("-"):
                index += 1
        if index < len(segment) and segment[index] == "env":
            index += 1
            while index < len(segment):
                argument = segment[index]
                if assignment.match(argument):
                    index += 1
                elif argument in {"-u", "--unset", "-C", "--chdir", "-S", "--split-string"}:
                    index += 2
                elif argument.startswith("-"):
                    index += 1
                else:
                    break
        if index >= len(segment):
            continue
        executable = pathlib.Path(segment[index].strip("()")).name
        if executable in {"bash", "dash", "sh", "zsh"}:
            shell_arguments = segment[index + 1 :]
            for position, argument in enumerate(shell_arguments[:-1]):
                if argument.startswith("-") and "c" in argument:
                    nested = command_arguments(shell_arguments[position + 1])
                    if nested is not None:
                        invocations.extend(pr_invocations(nested, depth=depth + 1))
                    break
            continue
        if executable != "gh":
            continue
        remainder = segment[index + 1 :]
        for position, argument in enumerate(remainder[:-1]):
            operation = remainder[position + 1]
            if argument == "pr" and operation in {"create", "edit"}:
                invocations.append((operation, segment[index:]))
                break
    return invocations


def pr_operation(arguments: list[str]) -> str | None:
    operations = [operation for operation, _ in pr_invocations(arguments)]
    return "create" if "create" in operations else (operations[0] if operations else None)


def has_pr_body_argument(arguments: list[str]) -> bool:
    return any(
        argument in {"--body", "-b", "--body-file", "-F"}
        or argument.startswith(("--body=", "--body-file="))
        for argument in arguments
    )


def pr_body(arguments: list[str]) -> tuple[str, bool]:
    body = ""
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        next_argument = arguments[index + 1] if index + 1 < len(arguments) else ""
        if argument in {"--body", "-b"}:
            body = next_argument
            index += 2
        elif argument.startswith("--body="):
            body = argument.split("=", 1)[1]
            index += 1
        elif argument in {"--body-file", "-F"}:
            if next_argument == "-":
                return "", False
            try:
                body = pathlib.Path(next_argument).read_text(encoding="utf-8")
            except OSError:
                return "", False
            index += 2
        elif argument.startswith("--body-file="):
            try:
                body = pathlib.Path(argument.split("=", 1)[1]).read_text(encoding="utf-8")
            except OSError:
                return "", False
            index += 1
        else:
            index += 1
    return body, True


def check_pr_body(
    *, state_dir: str | pathlib.Path, session_id: str, command: str
) -> dict[str, str]:
    arguments = command_arguments(command)
    if arguments is None:
        return {
            "status": "unchecked",
            "reason": "Skill report not verified: the PR command could not be parsed.",
        }
    invocations = pr_invocations(arguments)
    if not invocations:
        return {"status": "allow", "reason": ""}
    body_mutations = [
        (operation, invocation)
        for operation, invocation in invocations
        if operation == "create" or has_pr_body_argument(invocation)
    ]
    if not body_mutations:
        return {"status": "allow", "reason": ""}
    render_report(state_dir=state_dir, session_id=session_id)
    state = state_path(state_dir)
    report = state / "artifacts" / f"skill-report-{session_id}.md"
    if not report.exists():
        return {
            "status": "deny",
            "reason": f"No current skill report exists. Generate {report}, append it to the PR body, then retry.",
        }
    current_report = report.read_text(encoding="utf-8").strip()
    for _, invocation in body_mutations:
        text, checkable = pr_body(invocation)
        if not checkable:
            return {
                "status": "deny",
                "reason": "PR body could not be read, so the required skill report cannot be verified.",
            }
        if MARKER not in text:
            return {
                "status": "deny",
                "reason": f"PR body is missing the skill report. Read {report} and append its contents to the PR body, then retry.",
            }
        if current_report not in text:
            return {
                "status": "deny",
                "reason": f"The skill report in the PR body is out of date. Re-read {report} and replace the report section, then retry.",
            }
    return {"status": "allow", "reason": ""}


def command_record_skill(arguments: argparse.Namespace) -> None:
    record_skill(
        state_dir=arguments.state_dir,
        session_id=arguments.session_id,
        mode=arguments.mode,
        skill=arguments.skill,
        event=arguments.event,
        platform=arguments.platform,
        agent=arguments.agent,
        detail=arguments.detail,
    )
    print(json.dumps({"recorded": True}))


def command_track_edit(arguments: argparse.Namespace) -> None:
    tracked = track_edit(
        state_dir=arguments.state_dir,
        session_id=arguments.session_id,
        path=arguments.path,
        line_count=arguments.line_count,
    )
    print(json.dumps({"tracked": tracked}))


def command_pending(arguments: argparse.Namespace) -> None:
    print(
        json.dumps(
            pending(
                state_dir=arguments.state_dir,
                kind=arguments.kind,
                session_id=arguments.session_id,
                consume=arguments.consume,
            )
        )
    )


def command_render(arguments: argparse.Namespace) -> None:
    report = render_report(state_dir=arguments.state_dir, session_id=arguments.session_id)
    print(json.dumps({"report": str(report) if report else None}))


def command_skill_count(arguments: argparse.Namespace) -> None:
    print(
        json.dumps(
            {
                "count": skill_count(
                    state_dir=arguments.state_dir,
                    session_id=arguments.session_id,
                    skill=arguments.skill,
                )
            }
        )
    )


def command_check_pr_body(arguments: argparse.Namespace) -> None:
    print(
        json.dumps(
            check_pr_body(
                state_dir=arguments.state_dir,
                session_id=arguments.session_id,
                command=arguments.command,
            )
        )
    )


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    subcommands = root.add_subparsers(required=True)

    record = subcommands.add_parser("record-skill")
    record.add_argument("--state-dir", required=True)
    record.add_argument("--session-id", required=True)
    record.add_argument("--mode", required=True)
    record.add_argument("--skill", required=True)
    record.add_argument("--event")
    record.add_argument("--platform")
    record.add_argument("--agent")
    record.add_argument("--detail")
    record.set_defaults(handler=command_record_skill)

    edit = subcommands.add_parser("track-edit")
    edit.add_argument("--state-dir", required=True)
    edit.add_argument("--session-id", required=True)
    edit.add_argument("--path", required=True)
    edit.add_argument("--line-count", type=int, default=1)
    edit.set_defaults(handler=command_track_edit)

    pending_parser = subcommands.add_parser("pending")
    pending_parser.add_argument("--state-dir", required=True)
    pending_parser.add_argument("--kind", choices=("simplify", "intent"), required=True)
    pending_parser.add_argument("--session-id", required=True)
    pending_parser.add_argument("--consume", action="store_true")
    pending_parser.set_defaults(handler=command_pending)

    render = subcommands.add_parser("render")
    render.add_argument("--state-dir", required=True)
    render.add_argument("--session-id", required=True)
    render.set_defaults(handler=command_render)

    count = subcommands.add_parser("skill-count")
    count.add_argument("--state-dir", required=True)
    count.add_argument("--session-id", required=True)
    count.add_argument("--skill", required=True)
    count.set_defaults(handler=command_skill_count)

    guard = subcommands.add_parser("check-pr-body")
    guard.add_argument("--state-dir", required=True)
    guard.add_argument("--session-id", required=True)
    guard.add_argument("--command", required=True)
    guard.set_defaults(handler=command_check_pr_body)
    return root


if __name__ == "__main__":
    parsed = parser().parse_args()
    parsed.handler(parsed)
