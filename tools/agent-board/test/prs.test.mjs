import assert from "node:assert/strict";
import { test } from "node:test";
import { prOf, statusOf } from "../src/prs.mjs";

const person = (login) => ({ __typename: "User", login });
const bot = (login) => ({ __typename: "Bot", login });
const thread = (author, isResolved = false) => ({ isResolved, comments: { nodes: [{ author }] } });
// A search result shaped like GitHub's, open for review on main with passing checks unless a test says otherwise.
const node = (over = {}) => ({
  number: 7,
  title: "Add a thing",
  url: "https://github.com/acme/app/pull/7",
  isDraft: false,
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-02T10:00:00Z",
  additions: 10,
  deletions: 2,
  baseRefName: "main",
  headRefName: "feature",
  mergeable: "MERGEABLE",
  reviewDecision: "REVIEW_REQUIRED",
  repository: { nameWithOwner: "acme/app", defaultBranchRef: { name: "main" } },
  mergeQueueEntry: null,
  reviewRequests: { nodes: [{ requestedReviewer: { slug: "core" } }] },
  latestReviews: { nodes: [] },
  reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [] } } } }] },
  timelineItems: { nodes: [] },
  ...over,
});
const status = (over) => statusOf(prOf(node(over), "me"));

test("prOf keeps what the page shows and separates people from bots and the viewer", () => {
  const pr = prOf(
    node({
      baseRefName: "other-branch",
      mergeable: "UNKNOWN",
      reviewRequests: { nodes: [{ requestedReviewer: { login: "ann" } }, { requestedReviewer: { slug: "core" } }] },
      latestReviews: { nodes: [{ state: "COMMENTED", submittedAt: "2026-10-02T09:00:00Z", author: bot("claude") }, { state: "APPROVED", submittedAt: "2026-10-02T09:30:00Z", author: person("bob") }, { state: "COMMENTED", submittedAt: "2026-10-02T09:40:00Z", author: person("me") }] },
      reviewThreads: { nodes: [thread(person("bob")), thread(person("me")), thread(bot("claude")), thread(person("bob"), true)] },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { nodes: [{ name: "Test", conclusion: "FAILURE" }, { name: "Lint", conclusion: "SUCCESS" }, { context: "ci/legacy", state: "ERROR" }, { name: "Old", conclusion: "CANCELLED" }] } } } }] },
      timelineItems: { nodes: [{ createdAt: "2026-10-01T12:00:00Z" }] },
    }),
    "me",
  );
  assert.equal(pr.id, "acme/app#7");
  assert.equal(pr.stacked, true);
  assert.equal(pr.conflicts, false);
  assert.deepEqual(pr.requested, ["ann", "core"]);
  assert.deepEqual(pr.reviews.map((r) => `${r.who}:${r.state}`), ["bob:APPROVED"]);
  assert.equal(pr.replies, 1);
  assert.equal(pr.botThreads, 1);
  assert.equal(pr.checks, "fail");
  assert.deepEqual(pr.failing, ["Test", "ci/legacy"]);
  assert.equal(pr.waitingSince, Date.parse("2026-10-01T12:00:00Z"));
});

test("statusOf puts drafts and queued pull requests first, then what the author must do", () => {
  assert.deepEqual(status({ isDraft: true, mergeable: "CONFLICTING" }), { status: "draft", why: [] });
  assert.deepEqual(status({ mergeQueueEntry: { position: 1 } }), { status: "approved", why: ["In the merge queue"] });
  const failing = (names) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { nodes: names.map((name) => ({ name, conclusion: "FAILURE" })) } } } }] } });
  assert.deepEqual(status({ mergeable: "CONFLICTING", reviewDecision: "CHANGES_REQUESTED", latestReviews: { nodes: [{ state: "CHANGES_REQUESTED", submittedAt: "2026-10-02T09:00:00Z", author: person("bob") }] }, ...failing(["Build, Quality Check, Test", "a", "b", "c"]) }), {
    status: "needs-you",
    why: ["Merge conflicts", "Changes requested by bob", "Failing: Build, Quality Check, Test · a · b and 1 more"],
  });
  assert.deepEqual(status({ reviewThreads: { nodes: [thread(person("bob")), thread(person("ann"))] } }), { status: "needs-you", why: ["2 threads awaiting your reply"] });
});

test("statusOf reads approval from the decision, or from reviews when GitHub gives none", () => {
  const approvedBy = { latestReviews: { nodes: [{ state: "APPROVED", submittedAt: "2026-10-02T09:00:00Z", author: person("bob") }] } };
  assert.deepEqual(status({ reviewDecision: "APPROVED" }), { status: "approved", why: [] });
  assert.deepEqual(status({ reviewDecision: null, ...approvedBy }), { status: "approved", why: [] });
  assert.deepEqual(status({ reviewDecision: "REVIEW_REQUIRED", ...approvedBy }).status, "waiting");
  assert.deepEqual(status({ reviewDecision: "APPROVED", commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING", contexts: { nodes: [] } } } }] } }), { status: "approved", why: ["Checks still running"] });
});

test("statusOf says when nobody is asked to review", () => {
  assert.deepEqual(status({}), { status: "waiting", why: [] });
  assert.deepEqual(status({ reviewRequests: { nodes: [] } }), { status: "waiting", why: ["No reviewer requested"] });
  const commented = { reviewRequests: { nodes: [] }, latestReviews: { nodes: [{ state: "COMMENTED", submittedAt: "2026-10-02T09:00:00Z", author: person("bob") }] } };
  assert.deepEqual(status(commented), { status: "waiting", why: ["No review pending; re-request one"] });
});
