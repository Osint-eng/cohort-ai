import { compressToBase64 } from "lz-string"
import { transform } from "sucrase"

export type TaskType = "frontend" | "backend" | "design" | "research" | "general"
export type SandboxTemplateMode = "react" | "vanilla" | "backend" | "design" | "research"
export type SandboxFiles = Record<string, string>

export type SandboxTaskInput = {
  id: string
  title: string
  description?: string
  task_type?: TaskType
  suggested_owner: string
  due_date: string
  status: "todo" | "in_progress" | "blocked" | "done"
}

export type TaskSandboxMeta = {
  type: TaskType
  typeLabel: string
  ctaLabel: string
  supportsLivePreview: boolean
  supportsCodeSandbox: boolean
  defaultTemplate: SandboxTemplateMode
}

const VALID_TASK_TYPES = new Set<TaskType>([
  "frontend",
  "backend",
  "design",
  "research",
  "general",
])

export function normalizeTaskType(value: unknown): TaskType | undefined {
  if (typeof value !== "string") return undefined
  const lower = value.trim().toLowerCase() as TaskType
  return VALID_TASK_TYPES.has(lower) ? lower : undefined
}

const TYPE_KEYWORDS: Record<Exclude<TaskType, "general">, string[]> = {
  frontend: [
    "ui",
    "frontend",
    "front-end",
    "react",
    "next.js",
    "nextjs",
    "component",
    "page",
    "form",
    "navbar",
    "header",
    "sidebar",
    "modal",
    "dialog",
    "dashboard",
    "chart",
    "graph",
    "css",
    "tailwind",
    "html",
    "javascript",
    "jsx",
    "tsx",
    "button",
    "card",
    "table",
    "landing",
    "responsive",
    "animation",
    "dark mode",
    "login screen",
    "signup",
    "client",
    "view",
    "widget",
    "kanban",
    "layout",
    "interactive",
  ],
  backend: [
    "api",
    "backend",
    "back-end",
    "endpoint",
    "route",
    "server",
    "database",
    "db",
    "firestore",
    "sql",
    "postgres",
    "auth",
    "authentication",
    "token",
    "jwt",
    "webhook",
    "schema",
    "migration",
    "rate limit",
    "cron",
    "queue",
    "middleware",
    "validation",
    "query",
    "storage",
    "upload",
    "worker",
    "redis",
    "graphql",
    "rest",
  ],
  design: [
    "wireframe",
    "figma",
    "mockup",
    "prototype",
    "design",
    "palette",
    "typography",
    "brand",
    "ux",
    "user flow",
    "style guide",
    "design system",
    "illustration",
    "icon",
    "sketch",
    "visual",
    "spacing",
    "accessibility",
  ],
  research: [
    "research",
    "benchmark",
    "survey",
    "interview",
    "evaluate",
    "compare",
    "comparison",
    "spec",
    "docs",
    "documentation",
    "report",
    "literature",
    "pitch",
    "deck",
    "slides",
    "competitive",
    "user testing",
    "audit",
    "analysis",
    "study",
    "discover",
    "plan",
    "writeup",
  ],
}

export function detectTaskType(
  title: string,
  description?: string,
  explicitType?: unknown
): TaskType {
  const normalizedExplicit = normalizeTaskType(explicitType)
  if (normalizedExplicit) return normalizedExplicit

  const haystack = `${title} ${description || ""}`.toLowerCase()
  const scores: Record<Exclude<TaskType, "general">, number> = {
    frontend: 0,
    backend: 0,
    design: 0,
    research: 0,
  }

  for (const [category, keywords] of Object.entries(TYPE_KEYWORDS) as Array<
    [Exclude<TaskType, "general">, string[]]
  >) {
    for (const kw of keywords) {
      if (kw.includes(" ")) {
        if (haystack.includes(kw)) scores[category] += 2
      } else {
        const regex = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
        if (regex.test(haystack)) scores[category] += 1
      }
    }
  }

  let best: TaskType = "general"
  let bestScore = 0
  for (const category of ["frontend", "backend", "design", "research"] as const) {
    if (scores[category] > bestScore) {
      bestScore = scores[category]
      best = category
    }
  }
  return best
}

export function getTaskSandboxMeta(task: {
  title: string
  description?: string
  task_type?: TaskType
}): TaskSandboxMeta {
  const type = detectTaskType(task.title, task.description, task.task_type)
  switch (type) {
    case "frontend":
      return {
        type,
        typeLabel: "Frontend",
        ctaLabel: "Live Preview",
        supportsLivePreview: true,
        supportsCodeSandbox: true,
        defaultTemplate: "react",
      }
    case "backend":
      return {
        type,
        typeLabel: "Backend",
        ctaLabel: "Open in Sandbox",
        supportsLivePreview: false,
        supportsCodeSandbox: true,
        defaultTemplate: "backend",
      }
    case "design":
      return {
        type,
        typeLabel: "Design",
        ctaLabel: "Live Preview",
        supportsLivePreview: true,
        supportsCodeSandbox: true,
        defaultTemplate: "design",
      }
    case "research":
      return {
        type,
        typeLabel: "Research",
        ctaLabel: "Starter Brief",
        supportsLivePreview: false,
        supportsCodeSandbox: false,
        defaultTemplate: "research",
      }
    default:
      return {
        type: "general",
        typeLabel: "General",
        ctaLabel: "Open Starter",
        supportsLivePreview: false,
        supportsCodeSandbox: true,
        defaultTemplate: "research",
      }
  }
}

function escapeJsString(value: string): string {
  return JSON.stringify(value)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function buildTaskBriefMarkdown(
  task: SandboxTaskInput,
  roomTitle: string,
  projectSummary: string,
  typeLabel: string
): string {
  return [
    `# ${task.id.toUpperCase()}: ${task.title}`,
    "",
    `- **Project:** ${roomTitle}`,
    `- **Discipline:** ${typeLabel}`,
    `- **Owner:** ${task.suggested_owner}`,
    `- **Due date:** ${task.due_date}`,
    `- **Board status:** ${task.status.replace("_", " ")}`,
    "",
    "## Task Description",
    task.description?.trim() || "Implement and verify this deliverable against the room goal.",
    "",
    "## Project Context",
    projectSummary?.trim() || "Shared student team workspace in Cohort.",
    "",
    "## Acceptance Checklist",
    "- [ ] Core behavior matches the task title and description",
    "- [ ] Responsive and accessible edge cases verified",
    "- [ ] Update status back on the Cohort Kanban board",
  ].join("\n")
}

export function buildStarterFilesForTask(
  task: SandboxTaskInput,
  roomTitle: string,
  projectSummary: string,
  templateOverride?: SandboxTemplateMode
): { templateMode: SandboxTemplateMode; files: SandboxFiles } {
  const meta = getTaskSandboxMeta(task)
  const templateMode = templateOverride || meta.defaultTemplate
  const description =
    task.description?.trim() ||
    `Build and verify "${task.title}" for ${roomTitle}.`
  const briefMd = buildTaskBriefMarkdown(task, roomTitle, projectSummary, meta.typeLabel)

  if (templateMode === "react") {
    const appCode = `import React, { useState } from "react";
import "./styles.css";

const TASK_CONTEXT = {
  id: ${escapeJsString(task.id)},
  title: ${escapeJsString(task.title)},
  description: ${escapeJsString(description)},
  owner: ${escapeJsString(task.suggested_owner)},
  dueDate: ${escapeJsString(task.due_date)},
  project: ${escapeJsString(roomTitle)},
};

export default function App() {
  const [items, setItems] = useState([
    { id: 1, label: "Build core UI for: " + TASK_CONTEXT.title, done: false },
    { id: 2, label: "Wire interactive state & validation", done: false },
    { id: 3, label: "Verify responsive layout & edge cases", done: false },
  ]);
  const [draft, setDraft] = useState("");
  const [statusNote, setStatusNote] = useState("Ready to prototype");

  const toggleItem = (id) => {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, done: !item.done } : item))
    );
  };

  const addItem = (e) => {
    e.preventDefault();
    const clean = draft.trim();
    if (!clean) return;
    setItems((prev) => [...prev, { id: Date.now(), label: clean, done: false }]);
    setDraft("");
    setStatusNote("Added step: " + clean);
  };

  const completed = items.filter((i) => i.done).length;

  return (
    <main className="sandbox-shell">
      <header className="sandbox-header">
        <div className="meta-line">
          <span>{TASK_CONTEXT.id.toUpperCase()}</span>
          <span>·</span>
          <span>{TASK_CONTEXT.owner}</span>
          <span>·</span>
          <span>Due {TASK_CONTEXT.dueDate}</span>
        </div>
        <h1>{TASK_CONTEXT.title}</h1>
        <p className="subtitle">{TASK_CONTEXT.description}</p>
      </header>

      <section className="workspace-card">
        <div className="card-top">
          <strong>Implementation Prototype</strong>
          <span className="progress-text">
            {completed}/{items.length} checks complete
          </span>
        </div>

        <form className="add-row" onSubmit={addItem}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a UI test case or component step..."
          />
          <button type="submit">Add step</button>
        </form>

        <ul className="check-list">
          {items.map((item) => (
            <li key={item.id} className={item.done ? "is-done" : ""}>
              <label>
                <input
                  type="checkbox"
                  checked={item.done}
                  onChange={() => toggleItem(item.id)}
                />
                <span>{item.label}</span>
              </label>
            </li>
          ))}
        </ul>

        <footer className="card-foot">
          <span>{statusNote}</span>
          <button
            type="button"
            className="secondary"
            onClick={() => setStatusNote("Verified on " + new Date().toLocaleTimeString())}
          >
            Run quick check
          </button>
        </footer>
      </section>
    </main>
  );
}
`

    const cssCode = `* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f7f6f3;
  color: #262421;
  padding: 24px;
}

.sandbox-shell {
  max-width: 680px;
  margin: 0 auto;
}

.sandbox-header {
  margin-bottom: 18px;
}

.meta-line {
  display: flex;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: #8a7f73;
  margin-bottom: 6px;
}

.sandbox-header h1 {
  margin: 0 0 8px;
  font-size: 22px;
  line-height: 1.25;
}

.subtitle {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  color: #635d55;
}

.workspace-card {
  background: #ffffff;
  border: 1px solid #e6e2da;
  border-radius: 12px;
  padding: 18px;
}

.card-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
  font-size: 14px;
}

.progress-text {
  font-size: 12px;
  color: #c6530b;
  font-weight: 600;
}

.add-row {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}

.add-row input {
  flex: 1;
  min-width: 0;
  padding: 9px 12px;
  border: 1px solid #dfd9ce;
  border-radius: 8px;
  font-size: 13px;
}

.add-row button,
.secondary {
  border: 0;
  border-radius: 8px;
  padding: 9px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.add-row button {
  background: #f97316;
  color: #ffffff;
}

.check-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.check-list li {
  padding: 10px 12px;
  border: 1px solid #ece8e1;
  border-radius: 8px;
  font-size: 13px;
}

.check-list li.is-done span {
  text-decoration: line-through;
  color: #8f8980;
}

.check-list label {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
}

.card-foot {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid #ece8e1;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: #7c766d;
}

.secondary {
  background: #f4f1ec;
  color: #36322d;
}
`

    const indexHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(task.title)}</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`

    const packageJson = JSON.stringify(
      {
        name: `cohort-${task.id}`,
        version: "1.0.0",
        description: task.title,
        main: "src/index.js",
        dependencies: {
          react: "^18.3.1",
          "react-dom": "^18.3.1",
        },
        scripts: {
          start: "react-scripts start",
        },
      },
      null,
      2
    )

    const indexJs = `import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")).render(<App />);
`

    return {
      templateMode: "react",
      files: {
        "src/App.jsx": appCode,
        "src/styles.css": cssCode,
        "src/index.js": indexJs,
        "index.html": indexHtml,
        "package.json": packageJson,
        "TASK_BRIEF.md": briefMd,
      },
    }
  }

  if (templateMode === "vanilla") {
    const htmlCode = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(task.title)}</title>
  </head>
  <body>
    <main class="container">
      <p class="kicker">${escapeHtml(task.id.toUpperCase())} · ${escapeHtml(task.suggested_owner)} · Due ${escapeHtml(task.due_date)}</p>
      <h1>${escapeHtml(task.title)}</h1>
      <p class="desc">${escapeHtml(description)}</p>
      <section class="panel">
        <div class="row">
          <input id="item-input" type="text" placeholder="Test input or action..." />
          <button id="add-btn" type="button">Run action</button>
        </div>
        <ul id="output-list" class="list"></ul>
      </section>
    </main>
  </body>
</html>
`
    const cssCode = `* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px;
  font-family: system-ui, -apple-system, sans-serif;
  background: #f7f6f3;
  color: #272522;
}
.container { max-width: 640px; margin: 0 auto; }
.kicker { font-size: 12px; color: #8c8276; font-weight: 600; margin: 0 0 6px; }
h1 { font-size: 22px; margin: 0 0 8px; }
.desc { font-size: 14px; color: #5f5950; line-height: 1.5; margin: 0 0 18px; }
.panel {
  background: #fff;
  border: 1px solid #e7e3db;
  border-radius: 12px;
  padding: 16px;
}
.row { display: flex; gap: 8px; }
input {
  flex: 1;
  padding: 9px 12px;
  border: 1px solid #dcd6ca;
  border-radius: 8px;
  font-size: 13px;
}
button {
  border: 0;
  border-radius: 8px;
  padding: 9px 14px;
  background: #f97316;
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}
.list { list-style: none; padding: 0; margin: 14px 0 0; display: grid; gap: 8px; }
.list li {
  padding: 9px 11px;
  border-radius: 8px;
  background: #faf9f6;
  border: 1px solid #ece8e1;
  font-size: 13px;
}
`
    const jsCode = `const input = document.getElementById("item-input");
const button = document.getElementById("add-btn");
const list = document.getElementById("output-list");

const starterItems = [
  "Initialized prototype for ${task.title.replace(/"/g, '\\"')}",
  "Target owner: ${task.suggested_owner.replace(/"/g, '\\"')}",
];

function renderItem(text) {
  const li = document.createElement("li");
  li.textContent = text;
  list.appendChild(li);
}

starterItems.forEach(renderItem);

button.addEventListener("click", () => {
  const val = input.value.trim();
  if (!val) return;
  renderItem(val);
  input.value = "";
  input.focus();
});
`
    return {
      templateMode: "vanilla",
      files: {
        "index.html": htmlCode,
        "styles.css": cssCode,
        "script.js": jsCode,
        "TASK_BRIEF.md": briefMd,
      },
    }
  }

  if (templateMode === "design") {
    const wireframeHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(task.title)} — Wireframe</title>
  </head>
  <body>
    <main class="frame">
      <header class="frame-head">
        <div>
          <span class="kicker">${escapeHtml(task.id.toUpperCase())} · DESIGN SPEC · ${escapeHtml(task.suggested_owner)}</span>
          <h1>${escapeHtml(task.title)}</h1>
          <p>${escapeHtml(description)}</p>
        </div>
        <div class="state-tabs" role="tablist">
          <button class="tab active" data-state="default">Default</button>
          <button class="tab" data-state="empty">Empty</button>
          <button class="tab" data-state="error">Error</button>
        </div>
      </header>
      <section class="canvas" id="canvas">
        <div class="wire-hero">
          <div class="wire-title">Primary View Container</div>
          <div class="wire-copy">Key action hierarchy and spacing grid</div>
        </div>
        <div class="wire-grid">
          <div class="wire-block"><strong>Component A</strong><span>Primary content slot</span></div>
          <div class="wire-block"><strong>Component B</strong><span>Supporting controls</span></div>
        </div>
      </section>
    </main>
  </body>
</html>
`
    const tokensCss = `:root {
  --bg: #f7f6f3;
  --surface: #ffffff;
  --border: #e5e1d8;
  --text: #252320;
  --muted: #7b746b;
  --accent: #f97316;
  --radius: 12px;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px;
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, sans-serif;
}
.frame { max-width: 680px; margin: 0 auto; }
.frame-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.kicker { font-size: 11px; font-weight: 700; color: var(--muted); }
h1 { margin: 4px 0 6px; font-size: 20px; }
.frame-head p { margin: 0; font-size: 13px; color: var(--muted); max-width: 460px; line-height: 1.5; }
.state-tabs { display: flex; gap: 4px; background: #edeae3; padding: 3px; border-radius: 8px; }
.tab {
  border: 0;
  background: transparent;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  cursor: pointer;
}
.tab.active { background: var(--surface); color: var(--accent); }
.canvas {
  background: var(--surface);
  border: 1px dashed #cfc8bc;
  border-radius: var(--radius);
  padding: 18px;
}
.wire-hero {
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: #faf9f6;
  margin-bottom: 12px;
}
.wire-title { font-weight: 700; font-size: 14px; margin-bottom: 4px; }
.wire-copy { font-size: 12px; color: var(--muted); }
.wire-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.wire-block {
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.wire-block span { color: var(--muted); }
`
    const scriptJs = `const canvas = document.getElementById("canvas");
const views = {
  default: canvas.innerHTML,
  empty: '<div class="wire-hero"><div class="wire-title">Empty State</div><div class="wire-copy">Show clear guidance + one primary CTA when no items exist yet.</div></div>',
  error: '<div class="wire-hero" style="border-color:#f0b5b1;background:#fff5f4;"><div class="wire-title" style="color:#b83c32;">Error / Recovery State</div><div class="wire-copy">Plain-language message + non-destructive retry action.</div></div>'
};
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    canvas.innerHTML = views[btn.dataset.state] || views.default;
  });
});
`
    return {
      templateMode: "design",
      files: {
        "index.html": wireframeHtml,
        "styles.css": tokensCss,
        "script.js": scriptJs,
        "TASK_BRIEF.md": briefMd,
      },
    }
  }

  if (templateMode === "backend") {
    const slug = task.id.toLowerCase()
    const handlerTs = `import { NextRequest, NextResponse } from "next/server";

/**
 * ${task.id.toUpperCase()}: ${task.title}
 * Owner: ${task.suggested_owner} | Due: ${task.due_date}
 *
 * Description: ${description}
 */

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    // 1. Validate inputs strictly against schema
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid request payload" }, { status: 400 });
    }

    // 2. Execute core logic for ${slug}
    const result = {
      ok: true,
      taskId: ${escapeJsString(task.id)},
      receivedAt: new Date().toISOString(),
      payload: body,
    };

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
`
    const schemaJson = JSON.stringify(
      {
        taskId: task.id,
        title: task.title,
        endpoint: `/api/${slug}`,
        method: "POST",
        requestExample: {
          project: roomTitle,
          input: "example",
        },
        responseExample: {
          ok: true,
          taskId: task.id,
        },
      },
      null,
      2
    )
    const packageJson = JSON.stringify(
      {
        name: `cohort-${slug}-service`,
        version: "1.0.0",
        description: task.title,
        main: "handler.ts",
        scripts: {
          start: "node handler.ts",
        },
      },
      null,
      2
    )

    return {
      templateMode: "backend",
      files: {
        "handler.ts": handlerTs,
        "schema.json": schemaJson,
        "TASK_BRIEF.md": briefMd,
        "package.json": packageJson,
      },
    }
  }

  const researchMd = [
    briefMd,
    "",
    "## Research Plan & Questions",
    `1. What is the core decision needed for **${task.title}**?`,
    "2. What options or benchmarks should we compare?",
    "3. What recommendation will unblock the rest of the team?",
    "",
    "## Comparison Matrix",
    "| Option | Pros | Trade-offs | Recommendation |",
    "| --- | --- | --- | --- |",
    "| Option A | Fast to implement | Limited customization | Baseline |",
    "| Option B | High flexibility | Extra setup cost | Evaluate |",
    "",
    "## Summary for Team",
    "- Decision:",
    "- Next task unblocked:",
  ].join("\n")

  return {
    templateMode: "research",
    files: {
      "RESEARCH_BRIEF.md": researchMd,
      "TASK_BRIEF.md": briefMd,
    },
  }
}

const MICRO_REACT_IFRAME_RUNTIME = `
const React = (() => {
  const Fragment = Symbol("Fragment");
  let rootComponent = null;
  let rootContainer = null;
  let hookStates = [];
  let hookCursor = 0;
  let pendingEffects = [];
  let effectCleanups = [];
  let renderScheduled = false;

  function flattenChildren(children, out = []) {
    for (const child of children) {
      if (Array.isArray(child)) {
        flattenChildren(child, out);
      } else if (child !== null && child !== undefined && typeof child !== "boolean") {
        out.push(child);
      }
    }
    return out;
  }

  function createElement(type, props, ...children) {
    const normalizedProps = props ? { ...props } : {};
    const flat = flattenChildren(children.length ? children : normalizedProps.children !== undefined ? [normalizedProps.children] : []);
    delete normalizedProps.children;
    return { type, props: normalizedProps, children: flat };
  }

  function useState(initial) {
    const idx = hookCursor++;
    if (!(idx in hookStates)) {
      hookStates[idx] = typeof initial === "function" ? initial() : initial;
    }
    const setState = (next) => {
      const value = typeof next === "function" ? next(hookStates[idx]) : next;
      if (!Object.is(hookStates[idx], value)) {
        hookStates[idx] = value;
        scheduleRender();
      }
    };
    return [hookStates[idx], setState];
  }

  function useRef(initial) {
    const idx = hookCursor++;
    if (!(idx in hookStates)) {
      hookStates[idx] = { current: initial };
    }
    return hookStates[idx];
  }

  function depsChanged(prevDeps, nextDeps) {
    if (!prevDeps || !nextDeps) return true;
    if (prevDeps.length !== nextDeps.length) return true;
    for (let i = 0; i < nextDeps.length; i++) {
      if (!Object.is(prevDeps[i], nextDeps[i])) return true;
    }
    return false;
  }

  function useMemo(factory, deps) {
    const idx = hookCursor++;
    const prev = hookStates[idx];
    if (!prev || depsChanged(prev.deps, deps)) {
      const value = factory();
      hookStates[idx] = { value, deps };
      return value;
    }
    return prev.value;
  }

  function useCallback(fn, deps) {
    return useMemo(() => fn, deps);
  }

  function useEffect(effect, deps) {
    const idx = hookCursor++;
    const prev = hookStates[idx];
    if (!prev || depsChanged(prev.deps, deps)) {
      hookStates[idx] = { deps };
      pendingEffects.push({ idx, effect });
    }
  }

  function renderNode(vnode) {
    if (vnode === null || vnode === undefined || typeof vnode === "boolean") {
      return document.createTextNode("");
    }
    if (typeof vnode === "string" || typeof vnode === "number") {
      return document.createTextNode(String(vnode));
    }
    if (Array.isArray(vnode)) {
      const frag = document.createDocumentFragment();
      for (const child of vnode) frag.appendChild(renderNode(child));
      return frag;
    }
    if (vnode.type === Fragment) {
      const frag = document.createDocumentFragment();
      for (const child of vnode.children) frag.appendChild(renderNode(child));
      return frag;
    }
    if (typeof vnode.type === "function") {
      const result = vnode.type({ ...vnode.props, children: vnode.children });
      return renderNode(result);
    }

    const svgTags = new Set(["svg", "path", "circle", "rect", "line", "polyline", "polygon", "g"]);
    const el = svgTags.has(vnode.type)
      ? document.createElementNS("http://www.w3.org/2000/svg", vnode.type)
      : document.createElement(vnode.type);

    for (const [key, val] of Object.entries(vnode.props || {})) {
      if (val === undefined || val === null || key === "key" || key === "ref") continue;
      if (key === "className") {
        el.setAttribute("class", String(val));
      } else if (key === "htmlFor") {
        el.setAttribute("for", String(val));
      } else if (key === "style" && typeof val === "object") {
        Object.assign(el.style, val);
      } else if (key === "dangerouslySetInnerHTML" && val.__html !== undefined) {
        el.innerHTML = String(val.__html);
      } else if (key.startsWith("on") && typeof val === "function") {
        const eventName = key.slice(2).toLowerCase();
        if (eventName === "change" && (vnode.type === "input" || vnode.type === "textarea")) {
          el.addEventListener("input", val);
        } else {
          el.addEventListener(eventName, val);
        }
      } else if (key === "value" && ("value" in el)) {
        el.value = String(val);
      } else if (key === "checked" && ("checked" in el)) {
        el.checked = Boolean(val);
      } else if (typeof val === "boolean") {
        if (val) el.setAttribute(key, "");
      } else {
        el.setAttribute(key, String(val));
      }
    }

    for (const child of vnode.children || []) {
      el.appendChild(renderNode(child));
    }
    return el;
  }

  function flushRender() {
    renderScheduled = false;
    if (!rootComponent || !rootContainer) return;

    // Preserve active input/textarea focus and caret across synchronous re-renders
    const active = document.activeElement;
    let focusIndex = -1;
    let selStart = null;
    let selEnd = null;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
      const inputs = Array.from(rootContainer.querySelectorAll("input, textarea"));
      focusIndex = inputs.indexOf(active);
      try {
        selStart = active.selectionStart;
        selEnd = active.selectionEnd;
      } catch {}
    }

    hookCursor = 0;
    pendingEffects = [];
    const tree = createElement(rootComponent, {});
    const dom = renderNode(tree);
    rootContainer.replaceChildren(dom);

    if (focusIndex >= 0) {
      const inputs = Array.from(rootContainer.querySelectorAll("input, textarea"));
      const target = inputs[focusIndex];
      if (target) {
        target.focus();
        if (typeof selStart === "number" && typeof selEnd === "number") {
          try { target.setSelectionRange(selStart, selEnd); } catch {}
        }
      }
    }

    const effectsToRun = pendingEffects.slice();
    pendingEffects = [];
    queueMicrotask(() => {
      for (const { idx, effect } of effectsToRun) {
        if (typeof effectCleanups[idx] === "function") {
          try { effectCleanups[idx](); } catch {}
        }
        const cleanup = effect();
        effectCleanups[idx] = typeof cleanup === "function" ? cleanup : undefined;
      }
    });
  }

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    queueMicrotask(flushRender);
  }

  function render(vnode, container) {
    rootContainer = container;
    if (typeof vnode.type === "function") {
      rootComponent = vnode.type;
    } else {
      rootComponent = () => vnode;
    }
    flushRender();
  }

  return {
    Fragment,
    createElement,
    useState,
    useEffect,
    useRef,
    useMemo,
    useCallback,
    createRoot(container) {
      return {
        render(vnode) {
          render(vnode, container);
        },
      };
    },
  };
})();
`

function sanitizeClosingScript(code: string): string {
  return code.replace(/<\/script/gi, "<\\/script")
}

export function compilePreviewSrcDoc(
  files: SandboxFiles,
  templateMode: SandboxTemplateMode
): { html: string; compileError: string | null } {
  if (templateMode === "react") {
    const appSource = files["src/App.jsx"] || ""
    const cssSource = files["src/styles.css"] || ""
    const baseHtml = files["index.html"] || '<div id="root"></div>'

    let compiledJs = ""
    try {
      compiledJs = transform(appSource, {
        transforms: ["jsx", "imports"],
        jsxPragma: "React.createElement",
        jsxFragmentPragma: "React.Fragment",
      }).code
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Failed to compile JSX"
      return {
        compileError: msg,
        html: `<!DOCTYPE html><html><body style="font-family:system-ui;padding:20px;background:#fff5f4;color:#9f2c24;"><h3 style="margin:0 0 8px;font-size:14px;">JSX Compile Error</h3><pre style="white-space:pre-wrap;font-size:12px;margin:0;">${escapeHtml(msg)}</pre></body></html>`,
      }
    }

    const runnerScript = `
${MICRO_REACT_IFRAME_RUNTIME}
(function() {
  const showErr = (err) => {
    const root = document.getElementById("root") || document.body;
    const msg = err && err.message ? err.message : String(err);
    root.innerHTML = '<div style="margin:16px;padding:14px;border-radius:10px;border:1px solid #f0b5b1;background:#fff5f4;color:#9f2c24;font-family:system-ui,sans-serif;"><strong style="display:block;font-size:13px;margin-bottom:6px;">Preview Runtime Error</strong><pre style="margin:0;white-space:pre-wrap;font-size:12px;">' + msg.replace(/</g, "&lt;") + '</pre></div>';
  };
  window.addEventListener("error", (e) => showErr(e.error || e.message));
  try {
    const exports = {};
    const module = { exports };
    const require = (id) => {
      if (id === "react") return { __esModule: true, default: React, ...React };
      if (id === "react-dom" || id === "react-dom/client") return { __esModule: true, default: React, createRoot: React.createRoot };
      return {};
    };
    const { Fragment, useState, useEffect, useRef, useMemo, useCallback } = React;
    const fn = new Function("require", "exports", "module", "React", "Fragment", "useState", "useEffect", "useRef", "useMemo", "useCallback", ${JSON.stringify(compiledJs)});
    fn(require, exports, module, React, Fragment, useState, useEffect, useRef, useMemo, useCallback);
    const AppComponent = module.exports && module.exports.default ? module.exports.default : exports.default;
    if (typeof AppComponent !== "function") {
      throw new Error("Expected src/App.jsx to have a default exported React component.");
    }
    const mountNode = document.getElementById("root") || document.body;
    React.createRoot(mountNode).render(React.createElement(AppComponent, null));
  } catch (err) {
    showErr(err);
  }
})();
`

    const headInjection = `<style>${cssSource}</style>`
    const bodyInjection = `<script>${sanitizeClosingScript(runnerScript)}</script>`

    let html = baseHtml
    html = html.includes("</head>")
      ? html.replace("</head>", `${headInjection}</head>`)
      : `${headInjection}${html}`
    html = html.includes("</body>")
      ? html.replace("</body>", `${bodyInjection}</body>`)
      : `${html}${bodyInjection}`

    return { html, compileError: null }
  }

  // Vanilla HTML/CSS/JS or Design wireframe
  const htmlSource = files["index.html"] || "<main><h1>Preview</h1></main>"
  const cssSource = files["styles.css"] || ""
  const jsSource = files["script.js"] || ""

  const headInjection = `<style>${cssSource}</style>`
  const errorGuard = `
window.addEventListener("error", function(e) {
  var banner = document.createElement("div");
  banner.style.cssText = "margin:12px;padding:10px 12px;border-radius:8px;border:1px solid #f0b5b1;background:#fff5f4;color:#9f2c24;font:12px system-ui,sans-serif;";
  banner.textContent = "Script error: " + (e.message || "Unknown error");
  document.body.prepend(banner);
});
`
  const bodyInjection = `<script>${sanitizeClosingScript(errorGuard + "\n" + jsSource)}</script>`

  let html = htmlSource
  html = html.includes("</head>")
    ? html.replace("</head>", `${headInjection}</head>`)
    : `${headInjection}${html}`
  html = html.includes("</body>")
    ? html.replace("</body>", `${bodyInjection}</body>`)
    : `${html}${bodyInjection}`

  return { html, compileError: null }
}

export function buildCodeSandboxParameters(files: SandboxFiles): string {
  const normalized: Record<string, { content: string; isBinary: boolean }> = {}

  for (const [path, content] of Object.entries(files)) {
    normalized[path] = { content, isBinary: false }
  }

  if (!normalized["package.json"]) {
    normalized["package.json"] = {
      content: JSON.stringify(
        {
          name: "cohort-task-sandbox",
          version: "1.0.0",
          main: normalized["index.html"] ? "index.html" : "TASK_BRIEF.md",
        },
        null,
        2
      ),
      isBinary: false,
    }
  }

  const compressed = compressToBase64(JSON.stringify({ files: normalized }))
  return compressed.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
