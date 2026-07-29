from __future__ import annotations

import pathlib
import shlex
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import agent_activity


class AgentActivityTest(unittest.TestCase):
    def test_tracks_source_files_and_aggregates_pending_work(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            self.assertTrue(
                agent_activity.track_edit(
                    state_dir=directory,
                    session_id="session",
                    path="src/example.ts",
                    line_count=4,
                )
            )
            self.assertFalse(
                agent_activity.track_edit(
                    state_dir=directory,
                    session_id="session",
                    path="dist/example.js",
                    line_count=4,
                )
            )
            self.assertEqual(
                agent_activity.pending(
                    state_dir=directory,
                    kind="simplify",
                    session_id="session",
                    consume=True,
                ),
                {"files": ["src/example.ts"], "total": 4},
            )
            intent = agent_activity.pending(
                state_dir=directory,
                kind="intent",
                session_id="session",
                consume=True,
            )
            self.assertEqual(intent["files"], ["src/example.ts"])
            self.assertEqual(intent["total"], 0)
            self.assertIn("intent-anchor", intent["anchor"])

    def test_pending_work_is_isolated_by_state_directory(self) -> None:
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            agent_activity.track_edit(
                state_dir=first,
                session_id="shared-session",
                path="src/example.ts",
                line_count=4,
            )
            self.assertEqual(
                agent_activity.pending(
                    state_dir=second,
                    kind="simplify",
                    session_id="shared-session",
                    consume=True,
                ),
                {"files": [], "total": 0},
            )
            agent_activity.pending(
                state_dir=first,
                kind="simplify",
                session_id="shared-session",
                consume=True,
            )
            agent_activity.pending(
                state_dir=first,
                kind="intent",
                session_id="shared-session",
                consume=True,
            )

    def test_renders_and_requires_current_skill_report(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent_activity.record_skill(
                state_dir=directory,
                session_id="session",
                mode="direct",
                skill="simplify",
                platform="test",
            )
            report = agent_activity.render_report(state_dir=directory, session_id="session")
            self.assertIsNotNone(report)
            report_text = pathlib.Path(report).read_text()
            self.assertIn("skills-used:v1", report_text)
            denied = agent_activity.check_pr_body(
                state_dir=directory,
                session_id="session",
                command="gh pr create --body 'without report'",
            )
            self.assertEqual(denied["status"], "deny")
            allowed = agent_activity.check_pr_body(
                state_dir=directory,
                session_id="session",
                command=f"gh pr create --body {shlex.quote(report_text)}",
            )
            self.assertEqual(allowed["status"], "allow")

            agent_activity.record_skill(
                state_dir=directory,
                session_id="session",
                mode="model",
                skill="intent-check",
            )
            stale = agent_activity.check_pr_body(
                state_dir=directory,
                session_id="session",
                command=f"gh pr create --body {shlex.quote(report_text)}",
            )
            self.assertEqual(stale["status"], "deny")

    def test_allows_pr_edits_that_do_not_change_the_body(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = agent_activity.check_pr_body(
                state_dir=directory,
                session_id="session",
                command="gh pr edit 123 --add-reviewer alice --add-label ready",
            )
            self.assertEqual(result["status"], "allow")

    def test_requires_report_when_pr_edit_changes_the_body(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = agent_activity.check_pr_body(
                state_dir=directory,
                session_id="session",
                command="gh pr edit 123 --body 'replacement body'",
            )
            self.assertEqual(result["status"], "deny")

    def test_counts_only_successful_skill_invocations(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            for mode in ("direct", "model", "model-failed", "reference"):
                agent_activity.record_skill(
                    state_dir=directory,
                    session_id="session",
                    mode=mode,
                    skill="simplify",
                )
            self.assertEqual(
                agent_activity.skill_count(
                    state_dir=directory,
                    session_id="session",
                    skill="simplify",
                ),
                2,
            )

    def test_finds_wrapped_pr_commands_and_ignores_non_pr_commands(self) -> None:
        cases = {
            "cd repo && gh pr create --body missing": "create",
            "GH_PAGER=cat gh -R org/repo pr edit 123 --body missing": "edit",
            "env GH_TOKEN=x gh pr create --body missing": "create",
            "sh -c 'cd repo && gh pr create --body missing'": "create",
            "zsh -lc 'gh -R org/repo pr edit 123 --body missing'": "edit",
            "if true; then gh pr create --body missing; fi": "create",
            "while gh pr edit 123 --body missing; do break; done": "edit",
            "echo 'gh pr create --body missing'": None,
            "git status && gh pr view 123": None,
        }
        for command, expected in cases.items():
            with self.subTest(command=command):
                arguments = agent_activity.command_arguments(command)
                self.assertIsNotNone(arguments)
                self.assertEqual(agent_activity.pr_operation(arguments or []), expected)

    def test_denies_unreadable_pr_body(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = agent_activity.check_pr_body(
                state_dir=directory,
                session_id="session",
                command="gh pr create --body-file -",
            )
            self.assertEqual(result["status"], "deny")

    def test_validates_only_each_pr_invocations_body(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent_activity.record_skill(
                state_dir=directory,
                session_id="session",
                mode="direct",
                skill="simplify",
            )
            report = agent_activity.render_report(
                state_dir=directory, session_id="session"
            )
            report_text = pathlib.Path(report).read_text()
            command = (
                f"echo --body {shlex.quote(report_text)}; "
                "gh pr create --body 'not the report'"
            )
            result = agent_activity.check_pr_body(
                state_dir=directory,
                session_id="session",
                command=command,
            )
            self.assertEqual(result["status"], "deny")

    def test_requires_a_generated_report_not_only_its_marker(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = agent_activity.check_pr_body(
                state_dir=directory,
                session_id="session",
                command="gh pr create --body '<!-- skills-used:v1 -->'",
            )
            self.assertEqual(result["status"], "deny")

    def test_only_last_repeated_body_flag_is_effective(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent_activity.record_skill(
                state_dir=directory,
                session_id="session",
                mode="direct",
                skill="simplify",
            )
            report = agent_activity.render_report(
                state_dir=directory, session_id="session"
            )
            report_text = pathlib.Path(report).read_text()
            denied = agent_activity.check_pr_body(
                state_dir=directory,
                session_id="session",
                command=f"gh pr create --body {shlex.quote(report_text)} --body replacement",
            )
            self.assertEqual(denied["status"], "deny")
            allowed = agent_activity.check_pr_body(
                state_dir=directory,
                session_id="session",
                command=f"gh pr create --body replacement --body {shlex.quote(report_text)}",
            )
            self.assertEqual(allowed["status"], "allow")


if __name__ == "__main__":
    unittest.main()
