import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GradicusScraper } from "./scraper.js";
import { GradicusCache } from "./cache.js";
import { StudentReport, StudentSchedule } from "./types.js";

const server = new McpServer({
  name: "gradicus",
  version: "2.0.0",
  description: "Query student grades from the Gradicus school portal with intelligent caching",
});

const scraper = new GradicusScraper();
const cache = new GradicusCache();

// --- Helpers ---

function cacheAge(fetchedAt: string | null): string {
  if (!fetchedAt || fetchedAt === "never") return "";
  const mins = (Date.now() - new Date(fetchedAt).getTime()) / 60000;
  if (mins < 1) return "(just now)";
  if (mins < 60) return `(${Math.round(mins)} min ago)`;
  const hours = mins / 60;
  if (hours < 24) return `(${Math.round(hours)}h ago)`;
  return `(${Math.round(hours / 24)}d ago)`;
}

function cacheLabel(meta: { fetchedAt: string; isFrozen: boolean; source: string }): string {
  if (meta.isFrozen) return `[FROZEN ${cacheAge(meta.fetchedAt)}]`;
  if (meta.source === "cache") return `[CACHED ${cacheAge(meta.fetchedAt)}]`;
  return "[LIVE]";
}

async function syncStudent(studentName: string, schoolYear?: string): Promise<string> {
  const report = await scraper.getReport(studentName, schoolYear);
  cache.cacheReport(report);

  const schedule = await scraper.getSchedule(studentName);
  cache.cacheSchedule(report.student.id, schedule, report.schoolYear);

  return report.student.id;
}

async function getReportWithCache(studentName?: string, schoolYear?: string): Promise<{ report: StudentReport; label: string }> {
  // Try to resolve student ID for cache lookup
  let studentId: string | undefined;
  if (studentName) {
    const cachedStudents = cache.getCachedStudents();
    const match = cachedStudents.find(s => s.name.toLowerCase().includes(studentName.toLowerCase()));
    if (match) studentId = match.id;
  }

  // Check if cache is fresh
  if (studentId && cache.isFresh(studentId, "report", schoolYear)) {
    const cached = cache.getCachedReport(studentId, schoolYear);
    if (cached) {
      const meta = cache.getCacheMetadata(studentId, "report", schoolYear);
      return { report: cached, label: cacheLabel(meta) };
    }
  }

  // Try live fetch
  if (scraper.isLoggedIn()) {
    try {
      const report = await scraper.getReport(studentName, schoolYear);
      cache.cacheReport(report);
      return { report, label: "[LIVE]" };
    } catch {
      // Fall through to stale cache
    }
  }

  // Fallback to stale cache
  if (studentId) {
    const cached = cache.getCachedReport(studentId, schoolYear);
    if (cached) {
      const meta = cache.getCacheMetadata(studentId, "report", schoolYear);
      return { report: cached, label: `[OFFLINE ${cacheAge(meta.fetchedAt)}]` };
    }
  }

  throw new Error(
    "No cached data available and not logged in. Call login first, or sync to populate the cache."
  );
}

// --- Tools ---

server.tool(
  "login",
  "Authenticate with Gradicus and auto-sync current data for all students.",
  {},
  async () => {
    const email = process.env.GRADICUS_EMAIL;
    const password = process.env.GRADICUS_PASSWORD;

    if (!email || !password) {
      return {
        content: [{
          type: "text",
          text: "Missing credentials. Set GRADICUS_EMAIL and GRADICUS_PASSWORD environment variables.",
        }],
        isError: true,
      };
    }

    const loginResult = await scraper.login(email, password);
    if (!scraper.isLoggedIn()) {
      return { content: [{ type: "text", text: loginResult }] };
    }

    // Auto-sync all students
    const lines: string[] = [loginResult, "", "Auto-syncing all students..."];
    try {
      const students = await scraper.listStudents();
      for (const s of students) {
        try {
          await syncStudent(s.name);
          lines.push(`  Synced ${s.name}`);
        } catch (err) {
          lines.push(`  Failed to sync ${s.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      lines.push(`\nSync complete. ${students.length} students cached.`);
    } catch (err) {
      lines.push(`Auto-sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "list_students",
  "List all students. Works offline if data has been synced.",
  {},
  async () => {
    try {
      if (scraper.isLoggedIn()) {
        const students = await scraper.listStudents();
        if (students.length > 0) {
          const list = students.map((s, i) => `${i + 1}. ${s.name} (id: ${s.id})`).join("\n");
          return { content: [{ type: "text", text: `Students [LIVE]:\n${list}` }] };
        }
      }
    } catch {
      // fall through to cache
    }

    const cached = cache.getCachedStudents();
    if (cached.length > 0) {
      const list = cached.map((s, i) => `${i + 1}. ${s.name} (id: ${s.id})`).join("\n");
      return { content: [{ type: "text", text: `Students [CACHED]:\n${list}` }] };
    }

    return {
      content: [{ type: "text", text: "No students found. Login first to sync data." }],
    };
  }
);

server.tool(
  "get_grades",
  "Fetch grades for a student. Uses cache when fresh or offline, fetches live otherwise.",
  {
    student_name: z.string().optional().describe("Student name. Omit for currently selected."),
    school_year: z.string().optional().describe("School year like '2024-2025'. Omit for current year."),
  },
  async ({ student_name, school_year }) => {
    try {
      const { report, label } = await getReportWithCache(student_name, school_year);
      return { content: [{ type: "text", text: `${label}\n\n${formatFullReport(report)}` }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_grade_summary",
  "High-level summary of how a student is doing. Works offline with cached data.",
  {
    student_name: z.string().optional().describe("Student name. Omit for currently selected."),
    school_year: z.string().optional().describe("School year. Omit for current year."),
  },
  async ({ student_name, school_year }) => {
    try {
      const { report, label } = await getReportWithCache(student_name, school_year);
      return { content: [{ type: "text", text: `${label}\n\n${formatSummary(report)}` }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_homework",
  "Get tonight's homework and recent assignments. Uses cache when fresh.",
  {
    student_name: z.string().optional().describe("Student name."),
  },
  async ({ student_name }) => {
    try {
      const { report, label } = await getReportWithCache(student_name);
      return { content: [{ type: "text", text: `${label}\n\n${formatHomework(report)}` }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_schedule",
  "Get a student's class schedule. Uses cache when fresh.",
  {
    student_name: z.string().optional().describe("Student name."),
  },
  async ({ student_name }) => {
    try {
      // Try cache first
      let studentId: string | undefined;
      if (student_name) {
        const cached = cache.getCachedStudents();
        const match = cached.find(s => s.name.toLowerCase().includes(student_name.toLowerCase()));
        if (match) studentId = match.id;
      }

      if (studentId && cache.isFresh(studentId, "schedule")) {
        const schedule = cache.getCachedSchedule(studentId);
        if (schedule) {
          const meta = cache.getCacheMetadata(studentId, "schedule");
          return { content: [{ type: "text", text: `${cacheLabel(meta)}\n\n${formatSchedule(schedule)}` }] };
        }
      }

      // Live fetch
      if (scraper.isLoggedIn()) {
        const schedule = await scraper.getSchedule(student_name);
        if (schedule.student.id !== "unknown") {
          cache.cacheSchedule(schedule.student.id, schedule, cache.getCurrentSchoolYear());
        }
        return { content: [{ type: "text", text: `[LIVE]\n\n${formatSchedule(schedule)}` }] };
      }

      // Stale cache fallback
      if (studentId) {
        const schedule = cache.getCachedSchedule(studentId);
        if (schedule) {
          const meta = cache.getCacheMetadata(studentId, "schedule");
          return { content: [{ type: "text", text: `[OFFLINE ${cacheAge(meta.fetchedAt)}]\n\n${formatSchedule(schedule)}` }] };
        }
      }

      throw new Error("No schedule data. Login and sync first.");
    } catch (err) {
      return {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  }
);

server.tool(
  "sync",
  "Sync data from Gradicus. Fetches all students for current year. Pass school_year to pull a past year (fetched once, frozen forever).",
  {
    school_year: z.string().optional().describe("School year to sync, e.g. '2024-2025'. Omit for current year."),
  },
  async ({ school_year }) => {
    if (!scraper.isLoggedIn()) {
      return {
        content: [{ type: "text", text: "Not logged in. Call login first." }],
        isError: true,
      };
    }

    const lines: string[] = [`Syncing ${school_year || "current year"}...`];
    try {
      const students = await scraper.listStudents();
      for (const s of students) {
        try {
          await syncStudent(s.name, school_year);
          lines.push(`  Synced ${s.name}`);
        } catch (err) {
          lines.push(`  Failed: ${s.name} — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      lines.push(`\nDone. ${students.length} students synced.`);
      if (school_year && school_year !== cache.getCurrentSchoolYear()) {
        lines.push(`Past year ${school_year} is now frozen — will never be re-fetched.`);
      }
    } catch (err) {
      lines.push(`Sync error: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "cache_status",
  "Show cache freshness: when data was last synced, what's frozen vs. stale, and total records.",
  {},
  async () => {
    const status = cache.getSyncStatus();
    const lines: string[] = [
      `Cache Status`,
      `Database: ${status.dbPath}`,
      `Total records: ${status.totalRecords}`,
      `${"─".repeat(60)}`,
    ];

    if (status.students.length === 0) {
      lines.push("No data cached yet. Login to sync.");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    let currentStudent = "";
    for (const e of status.students) {
      if (e.studentName !== currentStudent) {
        currentStudent = e.studentName;
        lines.push(`\n${e.studentName}:`);
      }
      const frozen = e.isFrozen ? " [FROZEN]" : "";
      const age = e.lastSynced ? cacheAge(e.lastSynced) : "(never)";
      lines.push(`  ${e.schoolYear} ${e.dataType}: ${e.recordCount} records ${age}${frozen}`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "debug_page",
  "Return the raw HTML of the current student report page for debugging selectors.",
  {},
  async () => {
    try {
      const html = await scraper.getPageContent();
      return { content: [{ type: "text", text: html }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  }
);

server.tool(
  "logout",
  "Close the browser session. Cached data remains available offline.",
  {},
  async () => {
    const result = await scraper.logout();
    return { content: [{ type: "text", text: `${result}\nCached data is still available for offline queries.` }] };
  }
);

// --- Formatting helpers ---

const DIVIDER = "─".repeat(60);

function formatFullReport(report: StudentReport): string {
  const lines: string[] = [];
  const s = report.student;

  lines.push(`Grade Report for ${s.name}`);
  if (s.gradeLevel) lines.push(`Grade: ${s.gradeLevel}${s.teacher ? ` — Homeroom: ${s.teacher}` : ""}`);
  lines.push(`School Year: ${report.schoolYear} | Report Date: ${report.reportDate}`);
  if (s.daysAbsent !== undefined) {
    lines.push(`Attendance: ${s.daysAbsent} absent, ${s.daysLate ?? 0} late, ${s.earlyDismissals ?? 0} early dismissals`);
  }
  if (s.totalDemerits !== undefined) {
    lines.push(`Demerits YTD: ${s.totalDemerits}`);
  }
  lines.push(DIVIDER);

  if (report.missingAssignments.length > 0) {
    lines.push("\nMISSING ASSIGNMENTS:");
    for (const m of report.missingAssignments) {
      lines.push(`  [${m.dueDate}] ${m.subject} (${m.teacher}): ${m.description}`);
    }
  }

  lines.push("\nGRADES BY SUBJECT:");
  for (const g of report.grades) {
    lines.push(`\n  ${g.period} ${g.subject} — ${g.teacher}`);
    const periods: string[] = [];
    if (g.gp1) periods.push(`GP1: ${g.gp1}`);
    if (g.gp2) periods.push(`GP2: ${g.gp2}`);
    if (g.s1) periods.push(`S1: ${g.s1}`);
    if (g.gp3) periods.push(`GP3: ${g.gp3}`);
    if (g.gp4) periods.push(`GP4: ${g.gp4}`);
    if (g.s2) periods.push(`S2: ${g.s2}`);
    if (g.overall) periods.push(`Overall: ${g.overall}`);
    lines.push(`    ${periods.join(" | ")}`);
    for (const c of g.comments) {
      lines.push(`    Comment — ${c}`);
    }
  }

  if (report.homework.length > 0) {
    lines.push(`\n${DIVIDER}`);
    lines.push("HOMEWORK:");
    const tonight = report.homework.filter((h) => h.isTonight);
    const other = report.homework.filter((h) => !h.isTonight);
    if (tonight.length > 0) {
      lines.push("  Tonight:");
      for (const h of tonight) lines.push(`    ${h.subject}: ${h.description}`);
    }
    if (other.length > 0) {
      lines.push("  Recent:");
      for (const h of other) lines.push(`    [${h.date}] ${h.subject}: ${h.description}`);
    }
  }

  if (report.upcomingAssignments.length > 0) {
    lines.push(`\n${DIVIDER}`);
    lines.push("UPCOMING ASSIGNMENTS:");
    for (const u of report.upcomingAssignments) {
      lines.push(`  [${u.date}] ${u.subject} (${u.teacher}): ${u.description}`);
    }
  }

  return lines.join("\n");
}

function formatSummary(report: StudentReport): string {
  const lines: string[] = [];
  const s = report.student;

  lines.push(`Summary for ${s.name} (${report.schoolYear})`);
  lines.push(DIVIDER);

  if (report.grades.length === 0) {
    lines.push("No grade data found.");
    return lines.join("\n");
  }

  lines.push(`Subjects: ${report.grades.length}`);
  if (s.daysAbsent !== undefined) {
    lines.push(`Attendance: ${s.daysAbsent} absent, ${s.daysLate ?? 0} late`);
  }
  if (s.totalDemerits !== undefined) {
    lines.push(`Demerits: ${s.totalDemerits}`);
  }

  const strong: string[] = [];
  const watch: string[] = [];
  const failing: string[] = [];

  for (const g of report.grades) {
    const pct = extractPercent(g.overall);
    const label = `${g.subject}: ${g.overall || "N/A"}`;
    if (pct === null) continue;
    if (pct >= 90) strong.push(label);
    else if (pct >= 70) watch.push(label);
    else failing.push(label);
  }

  if (strong.length > 0) {
    lines.push(`\nStrong (A/B, 90%+):`);
    for (const item of strong) lines.push(`  ${item}`);
  }
  if (watch.length > 0) {
    lines.push(`\nWatch (C/D, 70-89%):`);
    for (const item of watch) lines.push(`  ${item}`);
  }
  if (failing.length > 0) {
    lines.push(`\nNeeds Attention (below 70%):`);
    for (const item of failing) lines.push(`  ${item}`);
  }

  if (report.missingAssignments.length > 0) {
    lines.push(`\nMissing Assignments: ${report.missingAssignments.length}`);
    for (const m of report.missingAssignments) {
      lines.push(`  ${m.subject}: ${m.description} (due ${m.dueDate})`);
    }
  }

  return lines.join("\n");
}

function formatHomework(report: StudentReport): string {
  const lines: string[] = [];
  const s = report.student;

  lines.push(`Homework for ${s.name} (${report.reportDate})`);
  lines.push(DIVIDER);

  const tonight = report.homework.filter((h) => h.isTonight);
  const other = report.homework.filter((h) => !h.isTonight);

  if (tonight.length > 0) {
    lines.push("\nTonight's Homework:");
    for (const h of tonight) lines.push(`  ${h.subject} (${h.teacher}): ${h.description}`);
  } else {
    lines.push("\nNo homework found for tonight.");
  }

  if (other.length > 0) {
    lines.push("\nRecent Homework:");
    for (const h of other) lines.push(`  [${h.date}] ${h.subject}: ${h.description}`);
  }

  if (report.missingAssignments.length > 0) {
    lines.push(`\n${DIVIDER}`);
    lines.push("MISSING (not turned in):");
    for (const m of report.missingAssignments) lines.push(`  [${m.dueDate}] ${m.subject}: ${m.description}`);
  }

  if (report.upcomingAssignments.length > 0) {
    lines.push(`\n${DIVIDER}`);
    lines.push("UPCOMING:");
    for (const u of report.upcomingAssignments) lines.push(`  [${u.date}] ${u.subject}: ${u.description}`);
  }

  return lines.join("\n");
}

function formatSchedule(schedule: StudentSchedule): string {
  const lines: string[] = [];
  const s = schedule.student;

  lines.push(`Schedule for ${s.name}`);
  if (s.gradeLevel) lines.push(`Grade: ${s.gradeLevel}${s.teacher ? ` — Homeroom: ${s.teacher}` : ""}`);
  if (schedule.rotationDay) lines.push(`Rotation: ${schedule.rotationDay}`);
  lines.push(DIVIDER);

  if (schedule.entries.length === 0) {
    lines.push("No schedule entries found.");
    return lines.join("\n");
  }

  for (const e of schedule.entries) {
    let line = `  Per. ${e.period}  ${e.subject}`;
    if (e.semester) line += ` (${e.semester})`;
    line += `\n         ${e.teacher} | ${e.schedule} | Room ${e.room}`;
    if (e.courseId) line += ` | Course: ${e.courseId}`;
    lines.push(line);
  }

  return lines.join("\n");
}

function extractPercent(gradeStr?: string): number | null {
  if (!gradeStr) return null;
  const match = gradeStr.match(/\((\d+)%\)/);
  return match ? parseInt(match[1]) : null;
}

// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Gradicus MCP Server v2.0 running on stdio (with caching)");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
