// The PRs tab: the person's open pull requests on GitHub, read with one `gh api graphql` search and sorted by who has
// to act next. The last read is kept in memory; an open page asks for a new one every few minutes.
import { execFile } from "node:child_process";

const SEARCH = "is:pr is:open author:@me archived:false sort:updated-desc";
// A read costs about 18 points of GitHub's 5,000-an-hour GraphQL limit; thread comments are most of it.
const QUERY = `query($q: String!) {
  viewer { login }
  search(query: $q, type: ISSUE, first: 40) {
    issueCount
    nodes {
      ... on PullRequest {
        number title url isDraft createdAt updatedAt additions deletions baseRefName headRefName mergeable reviewDecision
        repository { nameWithOwner defaultBranchRef { name } }
        mergeQueueEntry { position }
        reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { slug } ... on Bot { login } } } }
        latestReviews(first: 20) { nodes { state submittedAt author { __typename login } } }
        reviewThreads(first: 40) { nodes { isResolved comments(last: 1) { nodes { author { __typename login } } } } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes { ... on CheckRun { name conclusion } ... on StatusContext { context state } } } } } } }
        timelineItems(last: 1, itemTypes: [REVIEW_REQUESTED_EVENT, READY_FOR_REVIEW_EVENT]) { nodes { ... on ReviewRequestedEvent { createdAt } ... on ReadyForReviewEvent { createdAt } } }
      }
    }
  }
}`;
const MAX_AGE_MS = 3 * 60_000;
const CHECKS = { SUCCESS: "pass", FAILURE: "fail", ERROR: "fail", PENDING: "pending", EXPECTED: "pending" };
const FAILED = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const nodes = (connection) => connection?.nodes ?? [];

// One search result as the page shows it. The viewer's own reviews and replies are left out: they wait on others.
export function prOf(n, viewer) {
  const rollup = nodes(n.commits)[0]?.commit?.statusCheckRollup;
  const person = (a) => a && a.__typename !== "Bot" && a.login !== viewer;
  const unresolved = nodes(n.reviewThreads).filter((t) => !t.isResolved).map((t) => nodes(t.comments)[0]?.author);
  return {
    id: `${n.repository.nameWithOwner}#${n.number}`,
    repo: n.repository.nameWithOwner,
    number: n.number,
    title: n.title,
    url: n.url,
    draft: n.isDraft,
    createdAt: Date.parse(n.createdAt),
    updatedAt: Date.parse(n.updatedAt),
    waitingSince: Date.parse(nodes(n.timelineItems)[0]?.createdAt ?? n.createdAt),
    base: n.baseRefName,
    head: n.headRefName,
    stacked: n.baseRefName !== n.repository.defaultBranchRef?.name,
    additions: n.additions,
    deletions: n.deletions,
    decision: n.reviewDecision ?? null,
    requested: nodes(n.reviewRequests).map((r) => r.requestedReviewer?.login ?? r.requestedReviewer?.slug).filter(Boolean),
    reviews: nodes(n.latestReviews).filter((r) => person(r.author)).map((r) => ({ who: r.author.login, state: r.state, at: Date.parse(r.submittedAt) })),
    checks: CHECKS[rollup?.state] ?? null,
    failing: nodes(rollup?.contexts).filter((c) => FAILED.has(c.conclusion ?? c.state)).map((c) => c.name ?? c.context),
    // GitHub reports UNKNOWN until it has computed mergeability, so only a known conflict counts.
    conflicts: n.mergeable === "CONFLICTING",
    queued: Boolean(n.mergeQueueEntry),
    replies: unresolved.filter(person).length,
    botThreads: unresolved.filter((a) => a?.__typename === "Bot").length,
  };
}

// Who acts next: the author (needs-you), reviewers (waiting), nobody (approved), or nobody yet (draft), with the reasons.
// Without required reviews GitHub gives no decision, so the latest reviews decide.
export function statusOf(pr) {
  if (pr.draft) return { status: "draft", why: [] };
  if (pr.queued) return { status: "approved", why: ["In the merge queue"] };
  const by = (state) => pr.reviews.filter((r) => r.state === state).map((r) => r.who);
  const changesBy = by("CHANGES_REQUESTED");
  // Check names can hold commas ("Build, Quality Check, Test"), so they are set apart with dots.
  const failing = pr.failing.length > 3 ? `${pr.failing.slice(0, 3).join(" · ")} and ${pr.failing.length - 3} more` : pr.failing.join(" · ");
  const why = [
    pr.conflicts && "Merge conflicts",
    (pr.decision === "CHANGES_REQUESTED" || (!pr.decision && changesBy.length)) && `Changes requested${changesBy.length ? ` by ${changesBy.join(", ")}` : ""}`,
    pr.checks === "fail" && (failing ? `Failing: ${failing}` : "Checks failing"),
    pr.replies > 0 && `${pr.replies} thread${pr.replies === 1 ? "" : "s"} awaiting your reply`,
  ].filter(Boolean);
  if (why.length) return { status: "needs-you", why };
  if (pr.decision === "APPROVED" || (!pr.decision && by("APPROVED").length)) return { status: "approved", why: pr.checks === "pending" ? ["Checks still running"] : [] };
  return { status: "waiting", why: pr.requested.length ? [] : [pr.reviews.length ? "No review pending; re-request one" : "No reviewer requested"] };
}

function search() {
  return new Promise((resolve, reject) => {
    execFile("gh", ["api", "graphql", "-f", `query=${QUERY}`, "-f", `q=${SEARCH}`], { timeout: 60_000, maxBuffer: 20 << 20 }, (err, out, errOut) => {
      let body = null;
      try {
        body = JSON.parse(out);
      } catch {}
      // gh exits non-zero on a partial GraphQL error too, which still carries the search.
      if (body?.data?.search) return resolve(body.data);
      reject(new Error(errOut.trim().split("\n")[0] || err?.message || "gh returned no search result"));
    });
  });
}

export function createPrs() {
  let state = { at: null, viewer: null, total: 0, prs: [], error: null, errorAt: null };
  let reading = null;
  const refresh = () =>
    (reading ??= search()
      .then(
        (d) => {
          const prs = d.search.nodes.filter((n) => n.number).map((n) => prOf(n, d.viewer.login)).map((pr) => ({ ...pr, ...statusOf(pr) }));
          state = { at: Date.now(), viewer: d.viewer.login, total: d.search.issueCount, prs, error: null, errorAt: null };
        },
        (e) => {
          state = { ...state, error: e.message, errorAt: Date.now() };
          console.error(`prs FAILED: ${e.message}`);
        },
      )
      .finally(() => (reading = null)));
  return {
    get: () => ({ ...state, reading: Boolean(reading) }),
    // For the tab: how many are open and how many wait on the person, once a read has worked.
    counts: () => (state.at ? { open: state.total, needsYou: state.prs.filter((p) => p.status === "needs-you").length } : null),
    refresh,
    // Reads again when the last attempt, worked or failed, is older than a few minutes.
    fresh() {
      if (!reading && Date.now() - Math.max(state.at ?? 0, state.errorAt ?? 0) > MAX_AGE_MS) refresh();
    },
  };
}
