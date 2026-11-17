import { GoogleGenAI, Type } from "@google/genai"
import {
  detectTaskType,
  type SandboxFiles,
  type SandboxTemplateMode,
  type TaskType,
} from "./task-sandbox"

const MODEL = "gemini-4-hydrogen"

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured on the server.")
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  })
}

export type ExtractedTask = {
  id: string
  title: string
  description: string
  task_type: TaskType
  suggested_owner: string
  due_date: string
  status: "todo" | "in_progress" | "blocked" | "done"
}

export type ExtractedBoardResult = {
  summary: string
  tasks: ExtractedTask[]
}

const VALID_STATUSES = new Set(["todo", "in_progress", "blocked", "done"])

export async function extractBoardWithGemini(input: {
  brief: string
  members: Array<{ uid: string; displayName: string }>
  existingTitle: string
  todayIso: string
  startTaskNumber?: number
  maxTasks?: number
  existingTasks?: Array<{ id: string; title: string; status: string }>
}): Promise<ExtractedBoardResult> {
  const ai = getGeminiClient()
  const startNumber = Math.max(1, input.startTaskNumber ?? 1)
  const maxTasks = Math.max(1, Math.min(12, input.maxTasks ?? 8))
  const memberHandles =
    input.members.length > 0
      ? input.members.map((m) => `@${m.displayName.split(" ")[0]}`).join(", ")
      : "@Unassigned"

  const existingContext =
    input.existingTasks && input.existingTasks.length > 0
      ? [
          "Existing tasks already on the board (DO NOT duplicate these; extract only genuinely new tasks):",
          ...input.existingTasks.map((t) => `- ${t.id}: ${t.title} [${t.status}]`),
          "",
        ]
      : []

  const prompt = [
    `Today's date: ${input.todayIso}.`,
    `Project room title: ${input.existingTitle}.`,
    `Team members available: ${memberHandles}.`,
    ...existingContext,
    `Project brief:\n${input.brief.trim().slice(0, 6000)}`,
    "",
    `Extract a crisp 1-sentence project summary and 1 to ${maxTasks} concrete, actionable tasks for this student team.`,
    `Use sequential IDs starting at t${startNumber} (t${startNumber}, t${startNumber + 1}...) and distribute suggested_owner across the available team members when reasonable.`,
    "Format due_date concisely like 'Nov 20' or 'Dec 02' (use dates from the brief if mentioned, otherwise realistic milestones after today).",
    "For each task, include a crisp 1-sentence description (acceptance criteria/scope, max 220 chars) and classify task_type as one of: frontend, backend, design, research, general.",
    "Set status to 'todo' unless the brief explicitly says a task is already in progress, blocked, or done.",
  ].join("\n")

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      systemInstruction:
        "You are Cohort, an AI project manager for student group projects. Turn pasted project briefs into clear, balanced, actionable task boards in strict JSON.",
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: {
            type: Type.STRING,
            description: "One concise sentence summarizing the project goal.",
          },
          tasks: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: {
                  type: Type.STRING,
                  description: `Sequential task ID starting from t${startNumber}.`,
                },
                title: {
                  type: Type.STRING,
                  description: "Short, specific, actionable task title.",
                },
                description: {
                  type: Type.STRING,
                  description: "Concise 1-sentence acceptance criteria or implementation detail.",
                },
                task_type: {
                  type: Type.STRING,
                  description: "One of: frontend, backend, design, research, general.",
                },
                suggested_owner: {
                  type: Type.STRING,
                  description: "Owner handle prefixed with @, e.g. @Priya.",
                },
                due_date: {
                  type: Type.STRING,
                  description: "Short due date label such as Nov 20.",
                },
                status: {
                  type: Type.STRING,
                  description: "One of: todo, in_progress, blocked, done.",
                },
              },
              required: ["id", "title", "description", "task_type", "suggested_owner", "due_date", "status"],
            },
          },
        },
        required: ["summary", "tasks"],
      },
    },
  })

  const rawText = (response.text ?? "{}").trim()
  const parsed = JSON.parse(rawText) as {
    summary?: unknown
    tasks?: Array<Partial<ExtractedTask>>
  }

  const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : []
  const tasks: ExtractedTask[] = rawTasks.slice(0, maxTasks).map((t, index) => {
    const id = `t${startNumber + index}`
    const title = String(t.title || `Task ${startNumber + index}`).trim().slice(0, 200) || `Task ${startNumber + index}`
    const description = String(t.description || "").trim().slice(0, 500)
    const task_type = detectTaskType(title, description, t.task_type)
    let owner = String(t.suggested_owner || memberHandles.split(",")[0] || "@Team").trim()
    if (!owner.startsWith("@")) owner = `@${owner}`
    owner = owner.slice(0, 80)
    const dueDate = String(t.due_date || "TBD").trim().slice(0, 40) || "TBD"
    const rawStatus = String(t.status || "todo").trim()
    const status = (VALID_STATUSES.has(rawStatus) ? rawStatus : "todo") as ExtractedTask["status"]
    return {
      id,
      title,
      description,
      task_type,
      suggested_owner: owner,
      due_date: dueDate,
      status,
    }
  })

  if (tasks.length === 0) {
    throw new Error("Gemini did not return any tasks for that brief.")
  }

  const summary =
    String(parsed.summary || "").trim().slice(0, 600) ||
    `Shared plan for ${input.existingTitle}.`

  return { summary, tasks }
}

export async function generateCheckInWithGemini(input: {
  roomTitle: string
  tasks: Array<{
    id: string
    title: string
    suggested_owner: string
    due_date: string
    status: string
  }>
  members: Array<{ displayName: string }>
  todayIso: string
}): Promise<string> {
  const ai = getGeminiClient()

  const prompt = [
    `Today's date: ${input.todayIso}.`,
    `Project: ${input.roomTitle}`,
    `Members: ${input.members.map((m) => m.displayName).join(", ") || "None"}`,
    `Current board tasks (JSON): ${JSON.stringify(input.tasks)}`,
    "",
    "Write a concise, friendly team check-in message (2-4 short sentences or bullets, plain text, no markdown headers) highlighting:",
    "1) Any tasks that are blocked or overdue relative to today's date (mention task IDs and owners).",
    "2) What is currently in progress and one clear next step to unblock or keep momentum.",
    "If the board is empty, suggest pasting a brief with @cohort extract.",
  ].join("\n")

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      systemInstruction:
        "You are @cohort, a helpful, concise teammate in a student project group chat. Be direct, practical, and only cite tasks and dates actually on the board.",
    },
  })

  return (
    response.text?.trim().slice(0, 3000) ||
    "Quick check-in: take a look at your blocked and upcoming tasks on the board!"
  )
}

export async function generateProactiveNudgeWithGemini(input: {
  roomTitle: string
  reason: "stale_blocked" | "deadline_soon" | "room_idle"
  summaryContext: string
  tasks: Array<{
    id: string
    title: string
    suggested_owner: string
    due_date: string
    status: string
  }>
  members: Array<{ displayName: string }>
  todayIso: string
}): Promise<string> {
  const ai = getGeminiClient()

  const prompt = [
    `Today's date: ${input.todayIso}.`,
    `Project: ${input.roomTitle}`,
    `Trigger: ${input.reason}`,
    `Observation: ${input.summaryContext}`,
    `Members: ${input.members.map((m) => m.displayName).join(", ") || "None"}`,
    `Current tasks (JSON): ${JSON.stringify(input.tasks)}`,
    "",
    "You noticed this on your own while watching the room board. Write a helpful, non-nagging proactive teammate message (2 short sentences max, plain text, no markdown headers).",
    "Cite the exact task ID and @owner if applicable, and suggest one concrete next step (e.g., splitting a blocker, updating status with @cohort mark, or picking a quick win).",
  ].join("\n")

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      systemInstruction:
        "You are @cohort, an attentive AI teammate participating alongside students in a project room. Be warm, concise, and factual—only cite tasks, owners, and dates that exist on the board.",
    },
  })

  return (
    response.text?.trim().slice(0, 1500) ||
    `Heads up team — ${input.summaryContext} Drop an update here or run "@cohort check-in" if you want to reprioritize.`
  )
}

export async function generateSandboxStarterWithGemini(input: {
  roomTitle: string
  projectSummary: string
  taskId: string
  taskTitle: string
  taskDescription: string
  taskType: TaskType
  templateMode: SandboxTemplateMode
  owner: string
  dueDate: string
}): Promise<SandboxFiles> {
  const ai = getGeminiClient()

  const modeInstructions =
    input.templateMode === "react"
      ? [
          "Generate a clean, working single-file React prototype tailored specifically to this task.",
          "Return primaryCode as valid JSX for src/App.jsx (must default export `App`, may import React and hooks `useState, useEffect, useRef, useMemo, useCallback` from 'react', and no external third-party packages).",
          "Return secondaryCode as complete, modern CSS for src/styles.css.",
          "Return extraCode as empty string.",
        ].join(" ")
      : input.templateMode === "vanilla" || input.templateMode === "design"
        ? [
            "Generate a crisp, interactive HTML/CSS/JS prototype or wireframe tailored to this task.",
            "Return primaryCode as valid HTML body/document for index.html (without inline <script> or <style> tags).",
            "Return secondaryCode as CSS for styles.css.",
            "Return extraCode as vanilla browser JS for script.js.",
          ].join(" ")
        : input.templateMode === "backend"
          ? [
              "Generate a clean Next.js App Router API route handler (`handler.ts`) and JSON request/response schema (`schema.json`) tailored to this task.",
              "Return primaryCode as TypeScript for handler.ts.",
              "Return secondaryCode as valid JSON for schema.json.",
              "Return extraCode as empty string.",
            ].join(" ")
          : [
              "Generate a practical, structured Markdown research/planning starter brief (`RESEARCH_BRIEF.md`) with real questions, comparison table, and deliverable checklist tailored to this task.",
              "Return primaryCode as Markdown for RESEARCH_BRIEF.md.",
              "Return secondaryCode and extraCode as empty strings.",
            ].join(" ")

  const prompt = [
    `Project: ${input.roomTitle}`,
    `Project Summary: ${input.projectSummary || "Student team project"}`,
    `Task ${input.taskId}: ${input.taskTitle}`,
    `Task Description: ${input.taskDescription || input.taskTitle}`,
    `Task Discipline: ${input.taskType}`,
    `Template Mode: ${input.templateMode}`,
    `Owner: ${input.owner} | Due: ${input.dueDate}`,
    "",
    modeInstructions,
    "Keep code concise, immediately runnable with realistic sample data, and free of placeholder TODO stubs where real interactivity can be shown.",
  ].join("\n")

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      systemInstruction:
        "You are @cohort, helping a student team turn a Kanban task into an immediate runnable starter prototype. Return strict JSON matching the schema.",
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          primaryCode: {
            type: Type.STRING,
            description: "Primary file contents (src/App.jsx, index.html, handler.ts, or RESEARCH_BRIEF.md).",
          },
          secondaryCode: {
            type: Type.STRING,
            description: "Secondary file contents (src/styles.css, styles.css, schema.json, or empty string).",
          },
          extraCode: {
            type: Type.STRING,
            description: "Optional script.js contents for vanilla/design templates, otherwise empty string.",
          },
        },
        required: ["primaryCode", "secondaryCode", "extraCode"],
      },
    },
  })

  const rawText = (response.text ?? "{}").trim()
  const parsed = JSON.parse(rawText) as {
    primaryCode?: unknown
    secondaryCode?: unknown
    extraCode?: unknown
  }

  const primary = String(parsed.primaryCode || "").trim()
  const secondary = String(parsed.secondaryCode || "").trim()
  const extra = String(parsed.extraCode || "").trim()

  if (!primary) {
    throw new Error("Gemini returned an empty starter template.")
  }

  if (input.templateMode === "react") {
    return {
      "src/App.jsx": primary.slice(0, 24000),
      "src/styles.css": secondary.slice(0, 12000),
    }
  }
  if (input.templateMode === "vanilla" || input.templateMode === "design") {
    return {
      "index.html": primary.slice(0, 24000),
      "styles.css": secondary.slice(0, 12000),
      "script.js": extra.slice(0, 12000),
    }
  }
  if (input.templateMode === "backend") {
    return {
      "handler.ts": primary.slice(0, 24000),
      "schema.json": secondary.slice(0, 12000),
    }
  }
  return {
    "RESEARCH_BRIEF.md": primary.slice(0, 24000),
  }
}

