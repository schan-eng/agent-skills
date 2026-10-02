// The Daily tab: a digest of each day's merges into the repository's main branch, edits in Notion, and talk in Slack.
// Yesterday's are written once each morning; any recent day is rewritten on demand.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { callCodex } from "./codex.mjs";
import { runClaude } from "./journal.mjs";
import { cleanEnv, jsonStore } from "./summarize.mjs";

const KINDS = ["repo", "notion", "slack"];
const KEEP_DAYS = 30;
const TIMEOUT_MS = 8 * 60_000;
const BODY_MAX = 900;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HTTP_RE = /^https?:\/\/\S+$/;
const NOTION_TOOLS = ["notion-get-users", "notion-get-tool-access", "notion-ai-search", "notion-search", "notion-fetch", "notion-get-comments"];
const SLACK_TOOLS = ["slack_search_public_and_private", "slack_read_thread", "slack_read_channel", "slack_list_user_channels", "slack_read_user_profile"];
// Notion and Slack are read through Claude's plugins, as the Journal does: Codex has no Slack connection, and its Notion
// one rests on a login of its own.
const TOOLS = {
  notion: NOTION_TOOLS.map((t) => `mcp__plugin_Notion_notion__${t}`),
  slack: SLACK_TOOLS.map((t) => `mcp__plugin_slack_slack__${t}`),
};
// Kinds of files worth a heads-up, so the model need not infer them from titles.
const FLAGS = [
  [/(^|\/)migrations\//, "database migration"],
  [/(^|\/)(charts|helm)\//, "Helm chart"],
  [/^\.github\/workflows\//, "CI workflow"],
  [/(^|\/)(package\.json|yarn\.lock|pyproject\.toml|uv\.lock)$/, "dependencies"],
  [/(^|\/)(env\.ts|\.env[^/]*)$/, "environment variables"],
];

const ITEM = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: { text: { type: "string" }, url: { type: "string" }, where: { type: "string" }, prs: { type: "array", items: { type: "integer" } } },
};
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "sections", "gaps"],
  properties: {
    headline: { type: "string" },
    sections: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "items"], properties: { title: { type: "string" }, items: { type: "array", items: ITEM } } } },
    gaps: { type: "array", items: { type: "string" } },
  },
};

const REPO_SYSTEM = `You write the daily digest of what merged into a repository's main branch on one day, for an engineer on the team who wants to know what changed without reading every pull request.

The input lists the day's merged pull requests: number, title, author, size, the areas of the repository each touched, notable kinds of files, and the start of its description.

Write in plain English. Say what changed and why it matters to the team or to customers, not how the code does it. Put pull request numbers in prs, never in text.
- headline: one sentence on the day's most significant change or changes.
- sections: 2 to 5 sections grouped by theme, such as a product area or a platform concern, most significant first, each titled in 2 to 4 words. Each item is one sentence of at most 35 words about one change, or a few pull requests that are parts of one effort, with their numbers in prs. Every pull request belongs to exactly one item; small chores may share one.
- Last, only when something qualifies, a section titled "Heads-up" for what someone running, deploying or developing in the repository should know: database migrations, new or changed environment variables or configuration, Helm chart changes, behavior or defaults that change, dependency upgrades, and CI or tooling changes that alter how people work. Its items may repeat pull requests from earlier sections.
- gaps: pull requests whose purpose the input does not make clear. Usually empty.`;

const NOTION_SYSTEM = `You write the user's daily Notion digest for one day: what changed in their Notion workspace that day, so they can catch up without opening each page.

Use the read-only Notion tools, at most 20 calls in all:
- Find out who the user is with notion-get-users and user_id "self".
- List the pages edited that day: browse with an empty query, sort "last_edited", page_size 50 and the filter last_edited_date_range, using notion-ai-search when notion-get-tool-access says it is available and notion-search otherwise. The filter counts days in UTC, and one call returns at most 50 results, so browse once for each UTC date the input names, and keep only results whose edit time falls inside the day's UTC range. Browse again with edited_by_user_ids set to the user, to find what they edited.
- Fetch at most 8 of the pages that matter most: specs, decisions, plans, meeting notes and project pages, and pages that mention the user or carry comments for them. Say what changed or what the page now says.
- Treat automated logs and records edited in bulk, such as environment or contact lists, as one item at most.

Paraphrase; never paste page text. Link each page. Name people by display name. State only what you saw.
- headline: one sentence, the most important change of the day.
- sections, in this order and only when they have items: "For you" (pages that mention or assign the user, and comments addressed to them), "Decisions and plans" (specs, decisions, plans, project and meeting pages) and "Other changes" (other notable edits, bulk edits summarized). Each item is one sentence of at most 35 words, with url and where: the page's location, shortened to its last two parts.
- gaps: searches that failed and anything you could not reach.`;

const SLACK_SYSTEM = `You write the user's daily Slack digest for one day, so they can catch up on that day without scrolling through Slack.

Use the read-only Slack tools, at most 20 calls in all. Keep every search inside the day with the filter on:YYYY-MM-DD, and keep results small: set include_context to false and limit to at most 15, and leave response_format at its default so each result carries its permalink. Copy permalinks exactly as given.
- Find messages sent to the user directly or in group DMs, messages that mention them, and threads they posted in.
- Find the most active channels they belong to that day (only_my_channels true), and read the threads that look like decisions, announcements, incidents or requests.
- Read a thread before describing it when a search result alone is unclear.

Paraphrase; never quote a message. Link each item to its message or thread permalink. Name people by display name. State only what you saw.
- headline: one sentence, the most important thing from the day.
- sections, in this order and only when they have items: "Waiting on you" (questions, requests and review asks addressed to the user that look unanswered; say who asked), "Decisions and news" (decisions, announcements, releases, incidents) and "Worth a look" (other discussions the user would want to know about). Each item is one sentence of at most 35 words, with url and where: the channel as #name, or "DM with <name>".
- gaps: searches that failed and anything you could not reach.`;

const pad = (n) => String(n).padStart(2, "0");
export const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOf = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
};
// The day's first instant and the next day's, local time.
const boundsOf = (day) => {
  const start = startOf(day);
  return { start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1) };
};
const longDate = (day) => startOf(day).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
const zone = (day) => `${Intl.DateTimeFormat().resolvedOptions().timeZone}, ${startOf(day).toLocaleTimeString("en-US", { timeZoneName: "longOffset" }).split(" ").at(-1)}`;
const clip = (s, n) => (typeof s === "string" && s.trim() ? s.trim().slice(0, n) : null);
const link = (u) => (typeof u === "string" && HTTP_RE.test(u) ? u : undefined);

// A recent day in this machine's time zone, today included.
export function validDay(day, now = new Date()) {
  if (typeof day !== "string" || !DAY_RE.test(day) || dayOf(startOf(day)) !== day) return false;
  const age = (startOf(dayOf(now)) - startOf(day)) / 86_400_000;
  return age >= 0 && age < KEEP_DAYS;
}

const areaOf = (path) => path.split("/").slice(0, /^(apps|backend|packages|infra|tools)\//.test(path) ? 2 : 1).join("/");
const topAreas = (files) => [...files.reduce((m, f) => m.set(areaOf(f.path), (m.get(areaOf(f.path)) ?? 0) + 1), new Map())].toSorted((a, b) => b[1] - a[1]).slice(0, 4).map(([a]) => a);
const flagsOf = (files) => FLAGS.filter(([re]) => files.some((f) => re.test(f.path))).map(([, name]) => name);
const excerpt = (body) => (body ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\n\s*\n+/g, "\n").trim().slice(0, BODY_MAX);

async function mergedPrs(repo, day) {
  const { start, end } = boundsOf(day);
  const at = (t) => `${new Date(t).toISOString().slice(0, 19)}+00:00`;
  const fields = "number,title,author,mergedAt,url,additions,deletions,changedFiles,body,files";
  const search = `merged:${at(start)}..${at(end - 1000)} base:main`;
  const { stdout } = await promisify(execFile)("gh", ["pr", "list", "--repo", repo, "--state", "merged", "--search", search, "--limit", "200", "--json", fields], { timeout: 90_000, maxBuffer: 64 << 20, env: cleanEnv() });
  return JSON.parse(stdout)
    .map((p) => ({
      number: p.number,
      title: p.title,
      author: (p.author?.login ?? "unknown").replace(/^app\//, ""),
      bot: Boolean(p.author?.is_bot) || p.author?.login?.startsWith("app/"),
      mergedAt: Date.parse(p.mergedAt),
      url: p.url,
      additions: p.additions,
      deletions: p.deletions,
      changedFiles: p.changedFiles,
      areas: topAreas(p.files ?? []),
      flags: flagsOf(p.files ?? []),
      body: excerpt(p.body),
    }))
    .toSorted((a, b) => a.mergedAt - b.mergedAt);
}

const repoInput = (repo, day, prs) =>
  [
    `Repository: ${repo}, main branch`,
    `Day: ${longDate(day)}`,
    `${prs.length} pull requests merged, oldest first:`,
    ...prs.map((p) =>
      [
        `\n#${p.number} ${p.title}`,
        `By ${p.author}${p.bot ? " (a bot)" : ""}, merged ${new Date(p.mergedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}, +${p.additions}/-${p.deletions} in ${p.changedFiles} files`,
        `Areas: ${p.areas.join(", ") || "(none listed)"}${p.flags.length ? `\nTouches: ${p.flags.join(", ")}` : ""}`,
        p.body ? `Description: ${p.body}` : "No description.",
      ].join("\n"),
    ),
  ].join("\n");

// Keeps what a page can render safely; a repository item keeps only numbers of pull requests merged that day.
function cleaned(o, prNumbers) {
  const item = (it) => ({
    text: clip(it.text, 500),
    url: link(it.url),
    where: clip(it.where, 80) ?? undefined,
    prs: prNumbers ? (it.prs ?? []).filter((n) => prNumbers.has(n)) : undefined,
  });
  return {
    headline: clip(o.headline, 300),
    sections: o.sections.slice(0, 7).map((s) => ({ title: clip(s.title, 60) ?? "Other", items: s.items.slice(0, 15).map(item).filter((it) => it.text) })).filter((s) => s.items.length),
    gaps: o.gaps.map((g) => g.slice(0, 200)).slice(0, 8),
  };
}

// `toolsDir` resolves the folder a Claude call with tools runs in: plugins enabled per project load only there.
export function createDigests({ file, repo, engine, model, effort, budgetUsd, codexModel, runDir, toolsDir, autoHour }) {
  const store = jsonStore(file);
  let days = {}; // "YYYY-MM-DD" -> { repo?, notion?, slack? }
  const running = Object.fromEntries(KINDS.map((k) => [k, null]));
  const save = (next) => {
    days = Object.fromEntries(Object.entries(next).toSorted(([a], [b]) => b.localeCompare(a)).slice(0, KEEP_DAYS));
    return store.save(days);
  };
  const call = async (eng, system, input, tools = []) =>
    eng === "codex"
      ? callCodex(`${system}\n\n${input}`, { cwd: runDir, env: cleanEnv(), model: codexModel, effort, schema: SCHEMA, timeoutMs: TIMEOUT_MS })
      : runClaude(input, { system, schema: SCHEMA, tools, cwd: tools.length ? await toolsDir() : runDir, model, effort, budgetUsd, timeoutMs: TIMEOUT_MS });

  async function repoDigest(day, eng) {
    const prs = await mergedPrs(repo, day);
    const list = prs.map(({ number, title, author, url, mergedAt, additions, deletions }) => ({ number, title, author, url, mergedAt, additions, deletions }));
    if (!prs.length) return { headline: "Nothing merged into main.", sections: [], gaps: [], prs: [], costUsd: 0 };
    const r = await call(eng, REPO_SYSTEM, repoInput(repo, day, prs));
    return r.error ? r : { ...cleaned(r.output, new Set(prs.map((p) => p.number))), prs: list, costUsd: r.costUsd };
  }
  // Notion and Slack are read by the model itself, through its read-only tools.
  async function lookedUp(kind, day) {
    const { start, end } = boundsOf(day);
    const utcDates = [...new Set([start, new Date(end - 1)].map((t) => t.toISOString().slice(0, 10)))];
    const input = [
      `Day: ${day} (${longDate(day)}), in the user's time zone (${zone(day)}).`,
      `In UTC the day runs from ${start.toISOString()} to ${end.toISOString()}, across the UTC dates ${utcDates.join(" and ")}.`,
      `Now: ${new Date().toLocaleString()}`,
    ].join("\n");
    const r = await call("claude", kind === "notion" ? NOTION_SYSTEM : SLACK_SYSTEM, input, TOOLS[kind]);
    return r.error ? r : { ...cleaned(r.output, null), costUsd: r.costUsd };
  }

  function run(kind, day) {
    if (running[kind]) return false;
    const eng = kind === "repo" ? engine() : "claude";
    const startedAt = Date.now();
    running[kind] = { day, startedAt, engine: eng };
    (kind === "repo" ? repoDigest(day, eng) : lookedUp(kind, day))
      .catch((e) => ({ error: String(e.message ?? e).slice(0, 300) }))
      .then((d) => {
        const at = Date.now();
        const seconds = Math.round((at - startedAt) / 1000);
        console.log(`digest ${kind} ${day} ${eng} ${d.error ? `FAILED ${d.error}` : "ok"} $${(d.costUsd ?? 0).toFixed(4)} ${seconds}s`);
        // A failure keeps the day's last good digest beside the error.
        const next = d.error ? { ...days[day]?.[kind], error: d.error, errorAt: at } : { ...d, at, seconds, engine: eng, model: eng === "codex" ? codexModel : model };
        return save({ ...days, [day]: { ...days[day], [kind]: next } });
      })
      .finally(() => (running[kind] = null));
    return true;
  }

  return {
    ready: store.load().then((v) => (days = v)),
    get: () => ({ days, running, repo, autoHour }),
    run,
    // From autoHour on, writes each of yesterday's digests that has never been attempted.
    tick(now = new Date()) {
      if (now.getHours() < autoHour) return;
      const yesterday = dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
      for (const kind of KINDS) if (!days[yesterday]?.[kind]) run(kind, yesterday);
    },
  };
}
