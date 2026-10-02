// Outside context a session touched (Notion, Linear, Slack, pull requests, artifacts), shared by the board's scan and the hook.
// A source is { kind, id, role: "used" | "produced" | "linked" (in a person's prompt), title?, status?, url?, note? }.

const NOTION_HEX_RE = /[0-9a-f]{32}/i;
const NOTION_UUID_RE = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i;
const URL_RE = /https?:\/\/[^\s<>"'`)\]|]+/g;
const PR_URL_RE = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
const ARTIFACT_URL_RE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/([\w-]{8,})/;
const CHANNEL_RE = /#([\w.-]+) \((C[A-Z0-9]{6,})\)/g;
const SLACK_DOMAIN_RE = /https:\/\/([a-z0-9-]+)\.slack\.com\/archives\//;
const LINEAR_WORKSPACE_RE = /https:\/\/linear\.app\/([\w-]+)\/(?:issue|project|document)\//;
// `gh pr` where a shell command starts, so a script that only mentions it does not count.
const GH_PR_RE = /(?:^|[;&|(\n]|\$\()\s*gh pr (\w+)/;

const notionId = (s) => {
  const hex = String(s ?? "").match(NOTION_HEX_RE)?.[0] ?? String(s ?? "").match(NOTION_UUID_RE)?.[0];
  return hex ? hex.replaceAll("-", "").toLowerCase() : null;
};

// A tool result as text: a string, a list of content blocks, or an object.
export function resultText(r) {
  if (typeof r === "string") return r;
  const blocks = Array.isArray(r) ? r : Array.isArray(r?.content) ? r.content : null;
  if (blocks) return blocks.map((b) => (typeof b === "string" ? b : b?.type === "text" ? b.text : "")).join("\n");
  return r == null ? "" : JSON.stringify(r);
}

// A large result is saved to a file with only a preview kept, so fields are also read from the escaped preview.
function fields(text) {
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object") return v;
  } catch {}
  const flat = text.replace(/\\+"/g, '"');
  const field = (k) => flat.match(new RegExp(`"${k}":\\s*"([^"]{1,300})"`))?.[1];
  return { title: field("title"), url: field("url"), status: field("status"), id: field("id"), name: field("name") };
}

const clean = (s, n = 160) => (typeof s === "string" && s.trim() ? s.trim().slice(0, n) : undefined);

function notionSources(tool, input, text) {
  if (tool === "notion-fetch") {
    const id = notionId(input.id);
    if (!id) return [];
    const r = fields(text);
    return [{ kind: "notion", id, role: "used", title: clean(r.title), url: clean(r.url, 300) }];
  }
  if (tool === "notion-create-pages") {
    const pages = fields(text).pages ?? [];
    return pages.flatMap((p) => {
      const id = notionId(p.id);
      return id ? [{ kind: "notion", id, role: "produced", title: clean(p.properties?.title), url: clean(p.url, 300) }] : [];
    });
  }
  const id = notionId(input.page_id ?? input.id);
  if (!id) return [];
  if (/update|create-comment|move|duplicate/.test(tool)) return [{ kind: "notion", id, role: "produced" }];
  if (/get-comments/.test(tool)) return [{ kind: "notion", id, role: "used" }];
  return [];
}

function linearSources(tool, input, text) {
  const meta = (v) => ({ title: clean(v.title ?? v.name), status: clean(v.status ?? v.state?.name, 40), url: clean(v.url, 300) });
  if (tool === "get_issue" || tool === "save_issue") {
    const v = fields(text);
    const id = clean(v.identifier ?? v.id ?? input.id, 20)?.toUpperCase();
    return id && /^[A-Z]+-\d+$/.test(id) ? [{ kind: "linear-issue", id, role: tool === "get_issue" ? "used" : "produced", ...meta(v) }] : [];
  }
  if (tool === "save_comment" || tool === "list_comments") {
    const id = clean(input.issueId, 20)?.toUpperCase();
    return id && /^[A-Z]+-\d+$/.test(id) ? [{ kind: "linear-issue", id, role: tool === "save_comment" ? "produced" : "used" }] : [];
  }
  for (const [kind, name] of [["linear-project", "project"], ["linear-doc", "document"]]) {
    if (tool !== `get_${name}` && tool !== `save_${name}`) continue;
    const v = fields(text);
    const id = clean(v.id ?? input.id ?? input.query, 80);
    return id ? [{ kind, id, role: tool.startsWith("get") ? "used" : "produced", ...meta(v) }] : [];
  }
  return [];
}

function slackSources(tool, input) {
  const ch = clean(input.channel_id, 20);
  if (!ch) return [];
  const role = /send|schedule|draft/.test(tool) ? "produced" : /read/.test(tool) ? "used" : null;
  if (!role) return [];
  const ts = clean(tool === "slack_read_thread" ? input.message_ts : input.thread_ts, 30);
  return [ts ? { kind: "slack-thread", id: `${ch}/${ts}`, role } : { kind: "slack-channel", id: ch, role }];
}

function prSources(command, text) {
  const verb = command.match(GH_PR_RE)?.[1];
  if (!verb) return [];
  const role = ["create", "edit", "merge", "comment", "ready", "close", "review", "reopen"].includes(verb) ? "produced" : "used";
  const r = fields(text);
  const title = clean(command.match(/--title[= ](?:"([^"]*)"|'([^']*)')/)?.slice(1).find(Boolean)) ?? clean(r.title) ?? clean(text.match(/^title:\s+(.+)$/m)?.[1]);
  const status = clean(r.state ?? text.match(/^state:\s+(\w+)/m)?.[1], 20);
  const seen = new Map();
  for (const m of `${command}\n${text}`.matchAll(PR_URL_RE)) seen.set(`${m[1]}#${m[2]}`, m[0]);
  // A title or state belongs to the one pull request a command names; with several, none is attributed.
  const single = seen.size === 1;
  return [...seen].map(([id, url]) => ({ kind: "pr", id, role, url, ...(single ? { title, status } : {}) }));
}

function artifactSources(input, text) {
  const action = input.action ?? "publish";
  if (action === "read") {
    const id = String(input.url ?? "").match(ARTIFACT_URL_RE)?.[1];
    return id ? [{ kind: "artifact", id, role: "used", url: input.url }] : [];
  }
  if (action !== "publish" || input.asset) return [];
  const m = text.match(ARTIFACT_URL_RE) ?? String(input.url ?? "").match(ARTIFACT_URL_RE);
  if (!m) return [];
  const file = String(input.file_path ?? "").split("/").pop()?.replace(/\.(html|md)$/, "");
  return [{ kind: "artifact", id: m[1], role: "produced", url: m[0], title: clean(input.title) ?? clean(file), note: clean(input.description, 300) }];
}

// The calls whose results are worth reading; the logging hook's matcher names the same tools, less Bash.
export const touchesContext = ({ name, input }) => /^mcp__.*(notion|linear|slack)/i.test(name) || name === "Artifact" || (name === "Bash" && GH_PR_RE.test(input?.command ?? ""));

// What a tool call touched, and the facts its result teaches: channel names, the Slack domain, the Linear workspace.
export function extract(name, input = {}, text = "") {
  const [, server = "", tool = ""] = String(name).match(/^mcp__(.+?)__(.+)$/) ?? [];
  const svc = server.toLowerCase();
  const sources = svc.includes("notion") ? notionSources(tool, input, text)
    : svc.includes("linear") ? linearSources(tool, input, text)
    : svc.includes("slack") ? slackSources(tool, input)
    : name === "Artifact" ? artifactSources(input, text)
    : name === "Bash" ? prSources(String(input.command ?? ""), text)
    : [];
  return { sources, learned: learn(text) };
}

function learn(text) {
  if (!text) return null;
  const channels = Object.fromEntries([...text.matchAll(CHANNEL_RE)].map((m) => [m[2], m[1]]));
  const slackDomain = text.match(SLACK_DOMAIN_RE)?.[1];
  const linearWorkspace = text.match(LINEAR_WORKSPACE_RE)?.[1];
  return Object.keys(channels).length || slackDomain || linearWorkspace ? { channels, slackDomain, linearWorkspace } : null;
}

// A link as a source, for links in a person's prompt and for pins; null for a link of no known kind.
export function sourceOfUrl(url, role = "linked") {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname;
  const path = u.pathname;
  if (/(^|\.)notion\.(so|site|com)$/.test(host)) {
    const id = notionId(path);
    return id && { kind: "notion", id, role, url };
  }
  if (host === "linear.app") {
    const issue = path.match(/\/issue\/([A-Za-z]+-\d+)/)?.[1];
    if (issue) return { kind: "linear-issue", id: issue.toUpperCase(), role, url };
    const other = path.match(/\/(project|document)\/([\w-]+)/);
    return other && { kind: other[1] === "project" ? "linear-project" : "linear-doc", id: other[2], role, url };
  }
  const slack = host.endsWith(".slack.com") && path.match(/^\/archives\/(C[A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?/);
  if (slack) return slack[2] ? { kind: "slack-thread", id: `${slack[1]}/${slack[2]}.${slack[3]}`, role, url } : { kind: "slack-channel", id: slack[1], role, url };
  const pr = host === "github.com" && path.match(/^\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  if (pr) return { kind: "pr", id: `${pr[1]}#${pr[2]}`, role, url: `https://github.com/${pr[1]}/pull/${pr[2]}` };
  const art = url.match(ARTIFACT_URL_RE);
  return art ? { kind: "artifact", id: art[1], role, url } : null;
}

export const sourcesInText = (text) => [...new Map((String(text).match(URL_RE) ?? []).map((u) => sourceOfUrl(u.replace(/[.,;:]+$/, ""))).filter(Boolean).map((s) => [`${s.kind}:${s.id}`, s])).values()];

// One session's sources from its events ({ id, at, sources }), oldest first: the latest title, status and link win.
export function collect(events) {
  const out = new Map();
  for (const e of events) {
    for (const s of e.sources) {
      const key = `${s.kind}:${s.id}`;
      const prev = out.get(key) ?? { key, kind: s.kind, id: s.id, used: 0, produced: 0, linked: 0, firstAt: e.at };
      out.set(key, {
        ...prev,
        [s.role]: prev[s.role] + 1,
        title: s.title ?? prev.title,
        url: s.url ?? prev.url,
        note: s.note ?? prev.note,
        ...(s.status ? { status: s.status, statusAt: e.at } : {}),
        lastAt: e.at,
      });
    }
  }
  return [...out.values()];
}
