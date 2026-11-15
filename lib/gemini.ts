import { GoogleGenAI, Type } from "@google/genai"

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
}): Promise<ExtractedBoardResult> {
  const ai = getGeminiClient()
  const memberHandles =
    input.members.length > 0
      ? input.members.map((m) => `@${m.displayName.split(" ")[0]}`).join(", ")
      : "@Unassigned"

  const prompt = [
    `Today's date: ${input.todayIso}.`,
    `Project room title: ${input.existingTitle}.`,
    `Team members available: ${memberHandles}.`,
    `Project brief:\n${input.brief.trim().slice(0, 6000)}`,
    "",
    "Extract a crisp 1-sentence project summary and 4 to 8 concrete, actionable tasks for this student team.",
    "Use sequential IDs t1, t2, t3... and distribute suggested_owner across the available team members when reasonable.",
    "Format due_date concisely like 'Nov 20' or 'Dec 02' (use dates from the brief if mentioned, otherwise realistic milestones after today).",
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
                  description: "Sequential task ID like t1, t2, t3.",
                },
                title: {
                  type: Type.STRING,
                  description: "Short, specific, actionable task title.",
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
              required: ["id", "title", "suggested_owner", "due_date", "status"],
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
  const tasks: ExtractedTask[] = rawTasks.slice(0, 12).map((t, index) => {
    const id = `t${index + 1}`
    const title = String(t.title || `Task ${index + 1}`).trim().slice(0, 200) || `Task ${index + 1}`
    let owner = String(t.suggested_owner || memberHandles.split(",")[0] || "@Team").trim()
    if (!owner.startsWith("@")) owner = `@${owner}`
    owner = owner.slice(0, 80)
    const dueDate = String(t.due_date || "TBD").trim().slice(0, 40) || "TBD"
    const rawStatus = String(t.status || "todo").trim()
    const status = (VALID_STATUSES.has(rawStatus) ? rawStatus : "todo") as ExtractedTask["status"]
    return {
      id,
      title,
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
