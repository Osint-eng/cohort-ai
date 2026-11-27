# Cohort AI

Cohort is a real-time group-chat project manager built for student teams. It pairs team chat with an AI teammate (`@cohort`) that turns pasted project briefs into structured tasks, suggested owners, and deadlines—while tracking contributions fairly across the group.

---

## Features

- **8-Character Project Rooms** — Create rooms with server-generated 8-character codes (`[A-Z0-9]{8}`). Room listing is disabled so rooms cannot be enumerated.
- **Verified Google Authentication** — Requires Google Sign-In with a verified email address (`email_verified === true`), enforced in both Firestore rules and API routes.
- **Member Approval & Expiring Invites** — Joining a room puts new teammates in a `pending` state until the room owner approves them. Owners can also generate expiring, max-use invite links.
- **Real-Time Group Chat + `@cohort` Commands**
  - `@cohort extract <brief>` — Extracts a project summary and actionable tasks into the board (merge or replace mode).
  - `@cohort check-in` — Summarizes blocked, overdue, and in-progress tasks with next steps.
  - `@cohort mark <taskId> <status> [because <reason>]` — Updates task status (`todo`, `in_progress`, `blocked`, `done`) and records an activity log entry.
  - `@cohort list` / `@cohort help` — Lists board tasks or shows available commands.
- **Board, Table & Fairness Views** — Switch between a 4-column Kanban board (`To do`, `In progress`, `Blocked`, `Done`), a table view, and a **Fairness & Contribution** dashboard with CSV export.
- **Proactive AI Nudges** — Configurable agent cadence (`low`, `medium`, `high`) that watches for stale blocked tasks, approaching deadlines, and quiet rooms via `/api/cohort/pulse`.
- **Task Starter Sandbox** — Generates runnable starter code/templates tailored to each task's discipline (`frontend`, `backend`, `design`, `research`, `general`).
- **Live Presence** — Tracks online status and `lastSeenAt` timestamps for room members.
- **Hardened Firestore Security Rules** — Schema, field-allowlist, ownership, and timestamp validation documented in `security_spec.md` and `firebase-blueprint.json`.

---

## Tech Stack

- **Framework:** Next.js 16 (App Router, `standalone` output), React 19, TypeScript
- **Styling:** Tailwind CSS v4, CSS custom properties (light & dark themes), `lucide-react` icons
- **Backend & Database:** Next.js Route Handlers, Firebase Authentication (Google), Cloud Firestore (named database)
- **AI:** Google Gemini via `@google/genai` (server-side only)

---

## Project Structure

```text
app/
  page.tsx                  # Landing page
  join/page.tsx             # Create or join a room (supports ?room= and ?invite=)
  room/[code]/page.tsx      # Workspace shell for a room
  cohort-app.tsx            # Main client workspace (chat, board, members, invites)
  api/
    rooms/route.ts          # POST: Create a new room atomically
    cohort/route.ts         # POST: @cohort extract, check-in, mark, list, help
    cohort/pulse/route.ts   # POST: Proactive team nudges
    cohort/sandbox/route.ts # POST: Generate task starter code
components/
  fairness-dashboard.tsx    # Contribution analytics + CSV export
  task-sandbox-modal.tsx    # Interactive task starter preview & code viewer
lib/
  firebase.ts               # Client Firebase SDK initialization & error wrapper
  server-firebase.ts        # Server-side Firebase ID token verification & Firestore REST client
  gemini.ts                 # Gemini API prompts and structured JSON schemas
  api.ts                    # Client Firestore listeners & API helpers
  proactive-cohort.ts       # Proactive nudge threshold & due-date evaluation
  fairness.ts               # Contribution score & timeline calculations
  task-sandbox.ts           # Task discipline detection & starter templates
  rate-limit.ts             # In-memory per-user sliding-window rate limiter
firebase-blueprint.json     # Entity schemas and Firestore collection paths
firestore.rules             # Firestore security rules
security_spec.md            # Security invariants and adversarial test cases
```

---

## Prerequisites

- **Node.js 22+** and **npm**
- A **Firebase project** with:
  - **Authentication** enabled (Google sign-in provider)
  - **Cloud Firestore** database created
- A **Google Gemini API key**

---

## Environment Variables

Create a `.env.local` file in the project root (see `.env.example`):

| Variable | Required | Scope | Description |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | Yes | Server-only | API key used by `lib/gemini.ts` inside Next.js API routes. Never expose with `NEXT_PUBLIC_`. |
| `GEMINI_MODEL` | Outside AI Studio | Server-only | `GEMINI_MODEL` must be set outside AI Studio (for example `gemini-2.5-flash`); defaults to `gemini-4-hydrogen`. |
| `FIREBASE_API_KEY` | Optional* | Reference | Documented in `.env.example`; client/server Firebase settings are currently loaded from `firebase-applet-config.json`. |

\* **Firebase Configuration (`firebase-applet-config.json`):**  
Update `firebase-applet-config.json` in the project root with your own Firebase Web App config (`projectId`, `appId`, `apiKey`, `authDomain`, `firestoreDatabaseId`, `storageBucket`, `messagingSenderId`). If you use the default Firestore database rather than a named database, set `"firestoreDatabaseId": "(default)"`.

---

## Running Locally

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment variables**

   ```bash
   cp .env.example .env.local
   ```

   Add your `GEMINI_API_KEY` to `.env.local` and ensure `firebase-applet-config.json` points to your Firebase project.

3. **Deploy Firestore rules**

   Deploy `firestore.rules` to your Firebase project (for example via Firebase CLI):

   ```bash
   firebase deploy --only firestore:rules
   ```

4. **Start the development server**

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000).

---

## Available Scripts

- `npm run dev` — Starts Next.js development server on `0.0.0.0:3000`
- `npm run build` — Builds the production application (`output: 'standalone'`)
- `npm run start` — Starts the production Next.js server
- `npm run lint` — Runs ESLint against `firestore.rules` using `@firebase/eslint-plugin-security-rules`

---

## Architecture Notes

- **Server-Side AI & Token Verification:** All Gemini calls run strictly inside `app/api/*` using `process.env.GEMINI_API_KEY`. Client requests send the user's Firebase ID token (`Authorization: Bearer <token>`), which `lib/server-firebase.ts` verifies cryptographically against Google's public x509 certificates and requires `email_verified === true`.
- **User-Scoped Server Writes:** Instead of bypassing rules with `firebase-admin`, `lib/server-firebase.ts` forwards the authenticated user's ID token to the Firestore REST API (`firestore.googleapis.com/v1`), ensuring every server-initiated write still obeys `firestore.rules`.
- **Real-Time Client Sync:** Approved room members subscribe to `rooms/{code}`, `members`, `messages`, `tasks`, and `logs` via Firestore `onSnapshot` listeners in `lib/api.ts`.

---

## Security

See [`security_spec.md`](./security_spec.md) for the full list of security invariants (verified-email gate, pending approval isolation, immutable logs, strict field allowlists) and [`firestore.rules.test.ts`](./firestore.rules.test.ts) for the Firestore Rules emulator test cases.

---

## License

This project is open source under the [MIT License](./LICENSE).
