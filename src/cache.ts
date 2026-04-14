import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  StudentReport,
  StudentSchedule,
  SubjectGrade,
  AssignmentDetail,
  CacheMetadata,
  SyncStatusEntry,
  SyncStatus,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, "..", "data");
const DB_PATH = join(DB_DIR, "gradicus.db");

// TTLs in minutes
const TTL = {
  CURRENT_GRADES: 60,
  HOMEWORK: 30,
  SCHEDULE_CURRENT: 1440, // 24 hours
  ATTENDANCE: 60,
  ASSIGNMENTS_CURRENT: 60,
};

export class GradicusCache {
  private db: Database.Database;

  constructor() {
    mkdirSync(DB_DIR, { recursive: true });
    this.db = new Database(DB_PATH);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS students (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        grade_level TEXT,
        homeroom_teacher TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS grades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT NOT NULL,
        school_year TEXT NOT NULL,
        subject TEXT NOT NULL,
        period TEXT,
        teacher TEXT,
        teacher_email TEXT,
        gp1 TEXT, gp2 TEXT, s1 TEXT, gp3 TEXT, gp4 TEXT, s2 TEXT,
        overall TEXT,
        comments TEXT,
        is_frozen INTEGER DEFAULT 0,
        fetched_at TEXT NOT NULL,
        snapshot_hash TEXT,
        UNIQUE(student_id, school_year, subject)
      );

      CREATE TABLE IF NOT EXISTS assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT NOT NULL,
        school_year TEXT NOT NULL,
        subject TEXT NOT NULL,
        grading_period TEXT,
        category TEXT,
        name TEXT NOT NULL,
        score TEXT,
        max_score TEXT,
        percent REAL,
        date TEXT,
        is_frozen INTEGER DEFAULT 0,
        fetched_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS homework (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT NOT NULL,
        subject TEXT,
        teacher TEXT,
        date TEXT,
        description TEXT,
        is_tonight INTEGER DEFAULT 0,
        fetched_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS missing_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT NOT NULL,
        due_date TEXT,
        subject TEXT,
        teacher TEXT,
        description TEXT,
        fetched_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS upcoming_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT NOT NULL,
        date TEXT,
        subject TEXT,
        teacher TEXT,
        description TEXT,
        fetched_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schedule (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT NOT NULL,
        school_year TEXT NOT NULL,
        period TEXT,
        subject TEXT,
        course_id TEXT,
        teacher TEXT,
        time_range TEXT,
        room TEXT,
        semester TEXT,
        rotation_day TEXT,
        is_frozen INTEGER DEFAULT 0,
        fetched_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS attendance (
        student_id TEXT NOT NULL,
        school_year TEXT NOT NULL,
        days_absent INTEGER,
        days_late INTEGER,
        early_dismissals INTEGER,
        total_demerits INTEGER,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (student_id, school_year)
      );

      CREATE TABLE IF NOT EXISTS sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT,
        school_year TEXT,
        data_type TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        records_count INTEGER DEFAULT 0,
        was_frozen INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS grade_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT NOT NULL,
        school_year TEXT NOT NULL,
        subject TEXT NOT NULL,
        field TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        changed_at TEXT NOT NULL
      );
    `);

    // Migrations for existing databases
    this.migrate();
  }

  private migrate(): void {
    const columns = this.db.prepare(`PRAGMA table_info(schedule)`).all() as any[];
    const hasRotationDay = columns.some((c: any) => c.name === "rotation_day");
    if (!hasRotationDay) {
      this.db.exec(`ALTER TABLE schedule ADD COLUMN rotation_day TEXT`);
    }
  }

  // --- Cache Report ---

  cacheReport(report: StudentReport): void {
    const now = new Date().toISOString();
    const studentId = report.student.id;
    const schoolYear = report.schoolYear;

    // Upsert student
    this.db.prepare(`
      INSERT INTO students (id, name, grade_level, homeroom_teacher, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, grade_level=excluded.grade_level,
        homeroom_teacher=excluded.homeroom_teacher, updated_at=excluded.updated_at
    `).run(studentId, report.student.name, report.student.gradeLevel || null,
           report.student.teacher || null, now);

    // Upsert attendance
    this.db.prepare(`
      INSERT INTO attendance (student_id, school_year, days_absent, days_late, early_dismissals, total_demerits, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(student_id, school_year) DO UPDATE SET
        days_absent=excluded.days_absent, days_late=excluded.days_late,
        early_dismissals=excluded.early_dismissals, total_demerits=excluded.total_demerits,
        fetched_at=excluded.fetched_at
    `).run(studentId, schoolYear, report.student.daysAbsent ?? null,
           report.student.daysLate ?? null, report.student.earlyDismissals ?? null,
           report.student.totalDemerits ?? null, now);

    // Upsert grades with change detection
    const upsertGrade = this.db.prepare(`
      INSERT INTO grades (student_id, school_year, subject, period, teacher, teacher_email,
                          gp1, gp2, s1, gp3, gp4, s2, overall, comments, is_frozen, fetched_at, snapshot_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(student_id, school_year, subject) DO UPDATE SET
        period=excluded.period, teacher=excluded.teacher, teacher_email=excluded.teacher_email,
        gp1=excluded.gp1, gp2=excluded.gp2, s1=excluded.s1,
        gp3=excluded.gp3, gp4=excluded.gp4, s2=excluded.s2,
        overall=excluded.overall, comments=excluded.comments,
        fetched_at=excluded.fetched_at, snapshot_hash=excluded.snapshot_hash
      WHERE is_frozen = 0
    `);

    const getExisting = this.db.prepare(
      `SELECT gp1, gp2, s1, gp3, gp4, s2, overall FROM grades
       WHERE student_id = ? AND school_year = ? AND subject = ?`
    );

    const insertHistory = this.db.prepare(`
      INSERT INTO grade_history (student_id, school_year, subject, field, old_value, new_value, changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const upsertGrades = this.db.transaction((grades: SubjectGrade[]) => {
      for (const g of grades) {
        const hash = this.hashGrade(g);
        const commentsJson = JSON.stringify(g.comments);

        // Detect changes before upserting
        const existing = getExisting.get(studentId, schoolYear, g.subject) as Record<string, string> | undefined;
        if (existing) {
          for (const field of ["gp1", "gp2", "s1", "gp3", "gp4", "s2", "overall"] as const) {
            const oldVal = existing[field] || null;
            const newVal = g[field] || null;
            if (oldVal !== newVal && newVal) {
              insertHistory.run(studentId, schoolYear, g.subject, field, oldVal, newVal, now);
            }
          }
        }

        upsertGrade.run(
          studentId, schoolYear, g.subject, g.period || null, g.teacher, g.teacherEmail || null,
          g.gp1 || null, g.gp2 || null, g.s1 || null,
          g.gp3 || null, g.gp4 || null, g.s2 || null,
          g.overall || null, commentsJson, now, hash
        );
      }
    });

    upsertGrades(report.grades);

    // Replace assignments (non-frozen only)
    this.db.prepare(
      `DELETE FROM assignments WHERE student_id = ? AND school_year = ? AND is_frozen = 0`
    ).run(studentId, schoolYear);

    const insertAssignment = this.db.prepare(`
      INSERT INTO assignments (student_id, school_year, subject, grading_period, category, name, score, max_score, percent, date, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertAssignments = this.db.transaction((items: AssignmentDetail[]) => {
      for (const a of items) {
        insertAssignment.run(
          studentId, schoolYear, a.subject, a.gradingPeriod, a.category,
          a.name, a.score, a.maxScore, a.percent, a.date, now
        );
      }
    });
    insertAssignments(report.assignments);

    // Replace ephemeral data (homework, missing, upcoming)
    this.db.prepare(`DELETE FROM homework WHERE student_id = ?`).run(studentId);
    const insertHw = this.db.prepare(`
      INSERT INTO homework (student_id, subject, teacher, date, description, is_tonight, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertHomework = this.db.transaction(() => {
      for (const h of report.homework) {
        insertHw.run(studentId, h.subject, h.teacher, h.date, h.description, h.isTonight ? 1 : 0, now);
      }
    });
    insertHomework();

    this.db.prepare(`DELETE FROM missing_assignments WHERE student_id = ?`).run(studentId);
    const insertMa = this.db.prepare(`
      INSERT INTO missing_assignments (student_id, due_date, subject, teacher, description, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertMissing = this.db.transaction(() => {
      for (const m of report.missingAssignments) {
        insertMa.run(studentId, m.dueDate, m.subject, m.teacher, m.description, now);
      }
    });
    insertMissing();

    this.db.prepare(`DELETE FROM upcoming_assignments WHERE student_id = ?`).run(studentId);
    const insertUa = this.db.prepare(`
      INSERT INTO upcoming_assignments (student_id, date, subject, teacher, description, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertUpcoming = this.db.transaction(() => {
      for (const u of report.upcomingAssignments) {
        insertUa.run(studentId, u.date, u.subject, u.teacher, u.description, now);
      }
    });
    insertUpcoming();

    // Freeze logic
    this.freezeCompletedPeriods(studentId, schoolYear);

    // Log sync
    this.logSync(studentId, schoolYear, "report", report.grades.length);
  }

  // --- Cache Schedule ---

  cacheSchedule(studentId: string, schedule: StudentSchedule, schoolYear: string): void {
    const now = new Date().toISOString();

    this.db.prepare(
      `DELETE FROM schedule WHERE student_id = ? AND school_year = ? AND is_frozen = 0`
    ).run(studentId, schoolYear);

    const insert = this.db.prepare(`
      INSERT INTO schedule (student_id, school_year, period, subject, course_id, teacher, time_range, room, semester, rotation_day, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertAll = this.db.transaction(() => {
      for (const e of schedule.entries) {
        insert.run(studentId, schoolYear, e.period, e.subject, e.courseId || null,
                    e.teacher, e.schedule, e.room, e.semester || null,
                    schedule.rotationDay || null, now);
      }
    });
    insertAll();

    this.logSync(studentId, schoolYear, "schedule", schedule.entries.length);
  }

  // --- Retrieve Cached Data ---

  getCachedReport(studentId: string, schoolYear?: string): StudentReport | null {
    const year = schoolYear || this.getCurrentSchoolYear();

    const student = this.db.prepare(`SELECT * FROM students WHERE id = ?`).get(studentId) as any;
    if (!student) return null;

    const grades = this.db.prepare(
      `SELECT * FROM grades WHERE student_id = ? AND school_year = ?`
    ).all(studentId, year) as any[];

    const assignments = this.db.prepare(
      `SELECT * FROM assignments WHERE student_id = ? AND school_year = ?`
    ).all(studentId, year) as any[];

    const homework = this.db.prepare(
      `SELECT * FROM homework WHERE student_id = ?`
    ).all(studentId) as any[];

    const missing = this.db.prepare(
      `SELECT * FROM missing_assignments WHERE student_id = ?`
    ).all(studentId) as any[];

    const upcoming = this.db.prepare(
      `SELECT * FROM upcoming_assignments WHERE student_id = ?`
    ).all(studentId) as any[];

    const attendance = this.db.prepare(
      `SELECT * FROM attendance WHERE student_id = ? AND school_year = ?`
    ).get(studentId, year) as any;

    return {
      student: {
        id: student.id,
        name: student.name,
        gradeLevel: student.grade_level,
        teacher: student.homeroom_teacher,
        daysAbsent: attendance?.days_absent,
        daysLate: attendance?.days_late,
        earlyDismissals: attendance?.early_dismissals,
        totalDemerits: attendance?.total_demerits,
      },
      grades: grades.map((g: any) => ({
        period: g.period || "",
        subject: g.subject,
        teacher: g.teacher || "",
        teacherEmail: g.teacher_email,
        gp1: g.gp1, gp2: g.gp2, s1: g.s1,
        gp3: g.gp3, gp4: g.gp4, s2: g.s2,
        overall: g.overall,
        comments: JSON.parse(g.comments || "[]"),
      })),
      assignments: assignments.map((a: any) => ({
        subject: a.subject,
        gradingPeriod: a.grading_period || "",
        category: a.category || "",
        name: a.name,
        score: a.score || "",
        maxScore: a.max_score || "",
        percent: a.percent ?? 0,
        date: a.date || "",
      })),
      homework: homework.map((h: any) => ({
        subject: h.subject || "",
        teacher: h.teacher || "",
        date: h.date || "",
        description: h.description || "",
        isTonight: !!h.is_tonight,
      })),
      missingAssignments: missing.map((m: any) => ({
        dueDate: m.due_date || "",
        subject: m.subject || "",
        teacher: m.teacher || "",
        description: m.description || "",
      })),
      upcomingAssignments: upcoming.map((u: any) => ({
        date: u.date || "",
        subject: u.subject || "",
        teacher: u.teacher || "",
        description: u.description || "",
      })),
      schoolYear: year,
      reportDate: this.getLastSyncTime(studentId, "report") || "unknown",
    };
  }

  getCachedSchedule(studentId: string, schoolYear?: string): StudentSchedule | null {
    const year = schoolYear || this.getCurrentSchoolYear();

    const student = this.db.prepare(`SELECT * FROM students WHERE id = ?`).get(studentId) as any;
    if (!student) return null;

    const entries = this.db.prepare(
      `SELECT * FROM schedule WHERE student_id = ? AND school_year = ?`
    ).all(studentId, year) as any[];

    if (entries.length === 0) return null;

    return {
      student: {
        id: student.id,
        name: student.name,
        gradeLevel: student.grade_level,
        teacher: student.homeroom_teacher,
      },
      rotationDay: entries[0]?.rotation_day || "",
      entries: entries.map((e: any) => ({
        period: e.period || "",
        subject: e.subject || "",
        courseId: e.course_id,
        teacher: e.teacher || "",
        schedule: e.time_range || "",
        room: e.room || "",
        semester: e.semester,
      })),
    };
  }

  // --- Freshness Checks ---

  isFresh(studentId: string, dataType: string, schoolYear?: string): boolean {
    const year = schoolYear || this.getCurrentSchoolYear();

    // Frozen data is always fresh
    if (this.isYearFrozen(year)) return true;

    const lastSync = this.getLastSyncTime(studentId, dataType, year);
    if (!lastSync) return false;

    const ageMinutes = this.minutesSince(lastSync);
    const ttl = this.getTTL(dataType, year);

    return ageMinutes < ttl;
  }

  getCacheMetadata(studentId: string, dataType: string, schoolYear?: string): CacheMetadata {
    const year = schoolYear || this.getCurrentSchoolYear();
    const lastSync = this.getLastSyncTime(studentId, dataType, year);
    const frozen = this.isYearFrozen(year) || this.areGradesFrozen(studentId, year);

    return {
      fetchedAt: lastSync || "never",
      isFrozen: frozen,
      ageMinutes: lastSync ? this.minutesSince(lastSync) : Infinity,
      source: "cache",
    };
  }

  // --- Freeze Logic ---

  private freezeCompletedPeriods(studentId: string, schoolYear: string): void {
    if (this.isYearFrozen(schoolYear)) {
      // Past year: freeze everything
      this.db.prepare(
        `UPDATE grades SET is_frozen = 1 WHERE student_id = ? AND school_year = ?`
      ).run(studentId, schoolYear);
      this.db.prepare(
        `UPDATE assignments SET is_frozen = 1 WHERE student_id = ? AND school_year = ?`
      ).run(studentId, schoolYear);
      return;
    }

    // Current year: infer completed grading periods
    const grades = this.db.prepare(
      `SELECT subject, gp1, gp2, gp3, gp4, s1, s2 FROM grades WHERE student_id = ? AND school_year = ?`
    ).all(studentId, schoolYear) as any[];

    for (const g of grades) {
      // If GP3 or GP4 has data, GP1 and GP2 are complete
      const hasGP3 = g.gp3 && g.gp3 !== "-";
      const hasGP4 = g.gp4 && g.gp4 !== "-";

      if (hasGP3 || hasGP4) {
        // GP1 and GP2 assignments are frozen
        this.db.prepare(`
          UPDATE assignments SET is_frozen = 1
          WHERE student_id = ? AND school_year = ? AND subject = ?
          AND (grading_period LIKE '%Period 1%' OR grading_period LIKE '%Period 2%')
        `).run(studentId, schoolYear, g.subject);
      }

      if (hasGP4) {
        // GP3 assignments are also frozen
        this.db.prepare(`
          UPDATE assignments SET is_frozen = 1
          WHERE student_id = ? AND school_year = ? AND subject = ?
          AND grading_period LIKE '%Period 3%'
        `).run(studentId, schoolYear, g.subject);
      }
    }
  }

  private isYearFrozen(schoolYear: string): boolean {
    const currentYear = this.getCurrentSchoolYear();
    return schoolYear !== currentYear;
  }

  private areGradesFrozen(studentId: string, schoolYear: string): boolean {
    if (this.isYearFrozen(schoolYear)) return true;
    const frozen = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM grades WHERE student_id = ? AND school_year = ? AND is_frozen = 1`
    ).get(studentId, schoolYear) as any;
    const total = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM grades WHERE student_id = ? AND school_year = ?`
    ).get(studentId, schoolYear) as any;
    return total.cnt > 0 && frozen.cnt === total.cnt;
  }

  // --- Sync Status ---

  getSyncStatus(): SyncStatus {
    const students = this.db.prepare(`SELECT * FROM students ORDER BY name`).all() as any[];

    const entries: SyncStatusEntry[] = [];

    for (const s of students) {
      const years = this.db.prepare(
        `SELECT DISTINCT school_year FROM grades WHERE student_id = ? UNION
         SELECT DISTINCT school_year FROM schedule WHERE student_id = ?
         ORDER BY school_year DESC`
      ).all(s.id, s.id) as any[];

      for (const y of years) {
        for (const dataType of ["report", "schedule"]) {
          const lastSync = this.getLastSyncTime(s.id, dataType, y.school_year);
          const isFrozen = this.isYearFrozen(y.school_year);
          const count = this.getRecordCount(s.id, dataType, y.school_year);

          entries.push({
            studentName: s.name,
            studentId: s.id,
            schoolYear: y.school_year,
            dataType,
            lastSynced: lastSync,
            recordCount: count,
            isFrozen,
          });
        }
      }
    }

    const totalRecords = (this.db.prepare(
      `SELECT (SELECT COUNT(*) FROM grades) + (SELECT COUNT(*) FROM assignments) +
              (SELECT COUNT(*) FROM homework) + (SELECT COUNT(*) FROM schedule) as total`
    ).get() as any).total;

    return {
      dbPath: DB_PATH,
      totalRecords,
      students: entries,
    };
  }

  getChangeLog(studentId?: string, subject?: string, limit = 50): any[] {
    let sql = `SELECT * FROM grade_history WHERE 1=1`;
    const params: any[] = [];

    if (studentId) {
      sql += ` AND student_id = ?`;
      params.push(studentId);
    }
    if (subject) {
      sql += ` AND subject LIKE ?`;
      params.push(`%${subject}%`);
    }

    sql += ` ORDER BY changed_at DESC LIMIT ?`;
    params.push(limit);

    return this.db.prepare(sql).all(...params);
  }

  getCachedStudents(): { id: string; name: string }[] {
    return this.db.prepare(`SELECT id, name FROM students ORDER BY name`).all() as any[];
  }

  // --- Helpers ---

  private logSync(studentId: string, schoolYear: string, dataType: string, count: number): void {
    const frozen = this.isYearFrozen(schoolYear) ? 1 : 0;
    this.db.prepare(`
      INSERT INTO sync_log (student_id, school_year, data_type, fetched_at, records_count, was_frozen)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(studentId, schoolYear, dataType, new Date().toISOString(), count, frozen);
  }

  private getLastSyncTime(studentId: string, dataType: string, schoolYear?: string): string | null {
    let sql = `SELECT fetched_at FROM sync_log WHERE student_id = ? AND data_type = ?`;
    const params: any[] = [studentId, dataType];
    if (schoolYear) {
      sql += ` AND school_year = ?`;
      params.push(schoolYear);
    }
    sql += ` ORDER BY fetched_at DESC LIMIT 1`;
    const row = this.db.prepare(sql).get(...params) as any;
    return row?.fetched_at || null;
  }

  private getRecordCount(studentId: string, dataType: string, schoolYear: string): number {
    if (dataType === "report") {
      return (this.db.prepare(
        `SELECT COUNT(*) as cnt FROM grades WHERE student_id = ? AND school_year = ?`
      ).get(studentId, schoolYear) as any).cnt;
    }
    if (dataType === "schedule") {
      return (this.db.prepare(
        `SELECT COUNT(*) as cnt FROM schedule WHERE student_id = ? AND school_year = ?`
      ).get(studentId, schoolYear) as any).cnt;
    }
    return 0;
  }

  private getTTL(dataType: string, schoolYear: string): number {
    if (this.isYearFrozen(schoolYear)) return Infinity;
    switch (dataType) {
      case "report": return TTL.CURRENT_GRADES;
      case "homework": return TTL.HOMEWORK;
      case "schedule": return TTL.SCHEDULE_CURRENT;
      default: return TTL.CURRENT_GRADES;
    }
  }

  private minutesSince(isoDate: string): number {
    return (Date.now() - new Date(isoDate).getTime()) / 60000;
  }

  getCurrentSchoolYear(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    // School year starts in August
    if (month >= 8) return `${year}-${year + 1}`;
    return `${year - 1}-${year}`;
  }

  private hashGrade(g: SubjectGrade): string {
    const data = `${g.gp1}|${g.gp2}|${g.s1}|${g.gp3}|${g.gp4}|${g.s2}|${g.overall}`;
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const chr = data.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return hash.toString(36);
  }

  close(): void {
    this.db.close();
  }
}
