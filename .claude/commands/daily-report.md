# Gradicus Daily Report

Generate a fresh visual daily report for all students and deploy it via the Gradicus MCP server.

The deploy target is **Git → Vercel**. The MCP tool pushes `report/dist/` to `git@github.com:jeffhigham-f3/gradicus-deploy.git`; Vercel watches that repo and auto-deploys to **https://gradicus-deploy.vercel.app** (override with the `GRADICUS_REPORT_URL` env var on the MCP server if you point Vercel at a different domain).

> Netlify is deprecated. Do not use `deploy_to: "netlify"` or `deploy_to: "both"` — treat them as legacy. New deploys go through Git → Vercel only.

## Steps

### 1. Authenticate and sync fresh data

```
mcp: gradicus → login
```

This auths and auto-syncs all students into the local SQLite cache. Wait for the "Sync complete." line. If `login` fails, stop and tell the user — do not silently fall back to stale cache.

### 2. Pull each student's full grade detail

For every student, call:

```
mcp: gradicus → get_grades (student_name: "<first name>")
```

Read all four (or however many) results. Pay attention to:
- Overall grades and per-grading-period trends (improving / declining / sharp drop)
- Missing assignments — subject, days overdue, description
- Tonight's homework and upcoming deadlines (especially within 7 days)
- Verbatim teacher comments (these are the most personal data point)
- Demerits YTD and any recent ones
- Attendance — absences, tardies, early dismissals
- AP exam season context if April–May and the student takes AP courses

### 3. Author one insight paragraph per student

For each student, write **exactly one paragraph (4–6 sentences, plain prose, no markdown, no headings, no bullets)** that:

1. **Opens by celebrating something genuinely working** — name the kid by their character or effort, not just their score. ("Emory has built one of the more demanding schedules in her grade and shows up to it cheerfully every day" beats "Emory has a 95% in three honors classes.")
2. **Names the one thing worth focusing on** — frame it as a manageable next step, not a verdict. Mention specific subjects or assignments only when it's the most useful detail; otherwise speak in patterns ("a few assignments have piled up", "consistency in the core academics is the next thing to build").
3. **Suggests one warm, doable parent move for this week** — phrased as an invitation, not a prescription. ("Sit with her for 30 minutes this weekend with a snack and her laptop and let her decide the order" beats "Triage and submit the five missing items in order of grade impact.")

**Voice — write like a trusted teacher or family coach speaking to a parent over coffee:**
- Warm, conversational, encouraging — not clinical or audit-style.
- Use the child's name. Speak about them as a whole person, not a row of metrics.
- Be selective with numbers: 1–2 stats that matter, never a stat parade. "Most of his core subjects have slipped" is usually more readable than three percentages in one sentence.
- Soften diagnostic words. Prefer "the next thing to focus on", "what's worth a gentle check-in", "this is a good week to" over "the hard truth is", "collapsed", "must address immediately".
- Acknowledge effort and context. If a kid is overwhelmed, name it with compassion. If a parent is doing a lot already, say so.
- End with hope — a small, named, doable thing the parent can try this week, ideally framed as something that will feel good to do together.
- Still no empty platitudes ("keep up the good work", "stay focused", "they're trying their best"). Specific warmth is fine; vague reassurance is not.

### 4. Author one family-level insight

After per-student paragraphs, also write **one or two short paragraphs (total ~150–250 words)** that step back to the household level. Cover:

- **The shape of the household right now** — without enumerating every kid by stat, paint the overall picture. Who's settled and steady? Who needs a little more right now? Frame it generously — a struggling kid is not a problem child, they're a kid in a developmental window where things are hard.
- **Strong-helps-weak leverage, framed warmly** — name the cross-sibling possibilities (an older sibling tutoring a younger one, a younger sibling's habit modeling for an older one) as gifts the family already has under one roof, not assignments. Be specific about what 10–15 minutes could look like.
- **One household rhythm to try this week** — a single warm, doable family ritual (shared homework time, weekend cleanup session, no-devices dinner check-in) that benefits everyone, not just the kid who needs the most help.
- **Identity balance** — explicitly remind parents to keep letting the struggling kid lead in their genuine strengths (sports, art, music, helping cook, etc.), so their place in the family isn't tied to where they're behind.
- **Family-wide patterns** — if there's a household signal worth naming (combined attendance disruptions, busy week of competing deadlines), mention it with curiosity rather than judgment.

Voice rules from step 3 apply: trusted teacher or family coach, conversational, warm, name the kids personally, be specific without being clinical, end with hope and an invitation.

### 5. Generate, deploy, and push everything in one call

```
mcp: gradicus → daily_report (
  sync: false,
  deploy: true,
  insights: {
    "Cohen": "<paragraph 1>",
    "Emory": "<paragraph 2>",
    "Reese": "<paragraph 3>",
    "Saylor": "<paragraph 4>"
  },
  family_insight: "<one or two paragraphs about the household>"
)
```

The `insights` keys can be a first name, last name, or full name (case-insensitive substring match). `sync: false` is correct because step 1 already synced.

The tool generates `report/dist/`, mirrors it into a local clone of `gradicus-deploy` at `.deploy/`, commits with a timestamped message, and pushes to `main`. Vercel watches that repo and auto-deploys (typically 5–15 seconds). The tool returns the commit SHA and live URL in its response.

`deploy_to` defaults to `"git"`. The only other value you should use is `"none"` (generate locally without deploying).

The tool renders the family insight at the top of the **Summary tab** (purple accent, 🏡 icon) and each per-student paragraph at the top of that student's individual tab (indigo accent, ✨ icon).

### 6. Report the result

Tell the user the live URL: **https://gradicus-deploy.vercel.app** (or whatever the `daily_report` response surfaces — the tool now echoes the live URL after a successful Git deploy).

Include a brief 3–5 line summary based on what you saw across all students:
- Anyone needing immediate attention (failing grades, long-overdue assignments, high demerits)
- The most important upcoming deadline across the family
- Any wins worth celebrating

Keep it tight. The report itself is the deliverable.

## Variants

- **No insights, no fresh sync, no deploy**: `daily_report ({})` — local preview only.
- **Re-deploy without re-authoring insights**: `daily_report (sync: false, deploy: true)` — note the panels will lose their insight cards because the previous insights aren't persisted.
- **Generate locally without deploying**: `daily_report (deploy_to: "none")`.

## Install as an app (PWA)

The deployed report at https://gradicus-deploy.vercel.app is an installable Progressive Web App. Once installed it opens in standalone mode (no browser chrome), keeps a home-screen icon, and works offline by showing the most recent cached report with a small "Showing cached report from <date>" banner.

- **iPhone / iPad (Safari)**: open https://gradicus-deploy.vercel.app, tap the **Share** button, then **Add to Home Screen**, then **Add**. The drawer also has an "Add to Home Screen" button that walks through these steps.
- **Android (Chrome)**: open the URL, tap the in-app **Install app** button in the navigation drawer, or use Chrome's address-bar install prompt.
- **Desktop (Chrome / Edge)**: open the URL and click the install icon in the address bar (right side), or use the **Install app** button in the navigation drawer.
- **Desktop (Safari 17+ on macOS)**: open the URL and use **File → Add to Dock**.

When a fresh report is deployed, the installed PWA picks it up automatically on next online launch.

If the icon ever needs to change, regenerate the source PNG at `report/static/icons/source.png` and run `npm run build:icons` to re-derive all sizes; commit the result.
