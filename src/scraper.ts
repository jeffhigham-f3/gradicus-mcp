import { chromium, Browser, BrowserContext, Page } from "playwright";
import {
  Student,
  SubjectGrade,
  AssignmentDetail,
  HomeworkItem,
  MissingAssignment,
  UpcomingAssignment,
  StudentReport,
  ScheduleEntry,
  StudentSchedule,
} from "./types.js";

const BASE_URL = "https://gradicus.schoolclassics.org";

export class GradicusScraper {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private loggedIn = false;

  isLoggedIn(): boolean {
    return this.loggedIn && this.page !== null;
  }

  async login(email: string, password: string): Promise<string> {
    try {
      this.browser = await chromium.launch({ headless: true });
      this.context = await this.browser.newContext();
      this.page = await this.context.newPage();

      await this.page.goto(`${BASE_URL}/index.php`, {
        waitUntil: "networkidle",
      });

      const emailInput = await this.findInput([
        "email", "user", "login", "username",
      ]);
      const passwordInput = await this.findInput(["password", "pass", "pw"]);

      if (!emailInput || !passwordInput) {
        const html = await this.page.content();
        return `Login failed: could not locate login form fields.\n${html.substring(0, 3000)}`;
      }

      await emailInput.fill(email);
      await passwordInput.fill(password);

      const submitButton = await this.findSubmitButton();
      if (submitButton) {
        await submitButton.click();
      } else {
        await passwordInput.press("Enter");
      }

      await this.page.waitForLoadState("networkidle");

      const currentUrl = this.page.url();
      if (currentUrl !== `${BASE_URL}/index.php`) {
        this.loggedIn = true;
        return `Logged in successfully. Current page: ${currentUrl}`;
      }

      const bodyText = await this.page.textContent("body");
      return `Login may have failed. Current URL: ${currentUrl}\nPage text: ${(bodyText || "").substring(0, 1000)}`;
    } catch (err) {
      return `Login error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async listStudents(): Promise<Student[]> {
    this.ensureLoggedIn();
    await this.navigateToReport();

    const page = this.page!;
    const students: Student[] = [];

    const select = page.locator('select[name="studentid"]');
    if ((await select.count()) === 0) return students;

    const options = await select.locator("option").all();
    for (const opt of options) {
      const value = await opt.getAttribute("value");
      const text = (await opt.textContent())?.trim();
      if (value && text && text !== "select student") {
        students.push({ id: value, name: text });
      }
    }

    return students;
  }

  async getReport(studentName?: string, schoolYear?: string): Promise<StudentReport> {
    this.ensureLoggedIn();
    await this.navigateToReport();

    if (studentName) {
      await this.switchStudent(studentName);
    }

    if (schoolYear) {
      await this.switchSchoolYear(schoolYear);
    }

    const page = this.page!;
    const html = await page.content();

    const student = this.parseStudentInfo(html);
    const grades = this.parseGrades(html);
    const assignments = this.parseAssignmentDetails(html);
    const homework = this.parseHomework(html);
    const missingAssignments = this.parseMissingAssignments(html);
    const upcomingAssignments = this.parseUpcomingAssignments(html);
    const detectedYear = this.parseSchoolYear(html);

    return {
      student,
      grades,
      assignments,
      homework,
      missingAssignments,
      upcomingAssignments,
      schoolYear: schoolYear || detectedYear,
      reportDate: new Date().toISOString().split("T")[0],
    };
  }

  async getSchedule(studentName?: string): Promise<StudentSchedule> {
    this.ensureLoggedIn();
    const page = this.page!;

    let studentId = "";
    if (studentName) {
      await this.navigateToReport();
      const students = await this.listStudents();
      const match = students.find((s) =>
        s.name.toLowerCase().includes(studentName.toLowerCase())
      );
      if (!match) {
        throw new Error(
          `Student "${studentName}" not found. Use list_students to see available students.`
        );
      }
      studentId = match.id;
    }

    const url = studentId
      ? `${BASE_URL}/student-schedule.php?studentid=${studentId}`
      : `${BASE_URL}/student-schedule.php`;
    await page.goto(url, { waitUntil: "networkidle" });

    const html = await page.content();
    return this.parseSchedule(html);
  }

  async getPageContent(): Promise<string> {
    this.ensureLoggedIn();
    await this.navigateToReport();
    await this.page!.waitForTimeout(2000);
    return await this.page!.content();
  }

  async logout(): Promise<string> {
    try {
      if (this.browser) {
        await this.browser.close();
      }
    } catch {
      // ignore cleanup errors
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    this.loggedIn = false;
    return "Logged out and browser session closed.";
  }

  // --- School year switching ---

  private async switchSchoolYear(schoolYear: string): Promise<void> {
    const page = this.page!;
    const yearSelect = page.locator('select[name="schoolyear"]');
    if ((await yearSelect.count()) === 0) return;

    const currentVal = await yearSelect.inputValue();
    if (currentVal === schoolYear) return;

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle" }),
      yearSelect.selectOption(schoolYear),
    ]);
  }

  private parseSchoolYear(html: string): string {
    const match = html.match(
      /<option\s+value="(\d{4}-\d{4})"\s+selected="selected">/
    );
    return match ? match[1] : `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`;
  }

  // --- Schedule parsing ---

  private parseSchedule(html: string): StudentSchedule {
    const student: Student = { id: "unknown", name: "Unknown" };

    const nameMatch = html.match(/<h4[^>]*>([\w\s]+)<\/h4>/);
    if (nameMatch) student.name = nameMatch[1].trim();

    const selMatch = html.match(
      /<option\s+value="([^"]+)"\s+selected="selected">([^<]+)<\/option>/
    );
    if (selMatch) {
      student.id = selMatch[1];
      student.name = selMatch[2].trim();
    }

    const gradeMatch = html.match(/<b>Grade:<\/b>\s*(\w+)/);
    if (gradeMatch) student.gradeLevel = gradeMatch[1].trim();

    const homeroomMatch = html.match(
      /<b>Homeroom Teacher:<\/b>\s*([\w.\s]+?)&nbsp;/
    );
    if (homeroomMatch) student.teacher = homeroomMatch[1].trim();

    let rotationDay = "";
    const rotMatch = html.match(/Rotation Days?:\s*([^<]+)/);
    if (rotMatch) rotationDay = rotMatch[1].trim();

    const entries: ScheduleEntry[] = [];
    const rowRegex =
      /<tr\s+style="background-color:[^"]*;\s*border-bottom:1px solid #ccc;">([\s\S]*?)<\/tr>/g;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(html)) !== null) {
      const cells = this.extractCells(rowMatch[1]);
      if (cells.length < 5) continue;

      const period = cells[0].trim();
      let subject = cells[1].trim();
      const courseId = cells[2].trim();
      const teacher = cells[3].trim();
      const schedule = cells[4].trim();
      const room = cells.length > 5 ? cells[5].trim() : "";

      let semester: string | undefined;
      const semMatch = subject.match(/\(Semester\s+\d+\)/i);
      if (semMatch) {
        semester = semMatch[0].replace(/[()]/g, "");
        subject = subject.replace(semMatch[0], "").trim();
      }

      entries.push({
        period: period || "HR",
        subject,
        courseId: courseId || undefined,
        teacher,
        schedule,
        room,
        semester,
      });
    }

    return { student, rotationDay, entries };
  }

  // --- Report parsing ---

  private parseStudentInfo(html: string): Student {
    const student: Student = { id: "unknown", name: "Unknown" };

    const selMatch = html.match(
      /<option\s+value="([^"]+)"\s+selected="selected">([^<]+)<\/option>/
    );
    if (selMatch) {
      student.id = selMatch[1];
      student.name = selMatch[2].trim();
    }

    const h4Match = html.match(/<h4>([^<]+)\(([^)]+)\)<\/h4>/);
    if (h4Match) {
      student.gradeLevel = h4Match[2].trim().split(" - ")[0].trim();
      student.teacher = h4Match[2].trim().split(" - ")[1]?.trim();
    }

    const absMatch = html.match(/<b>Days Absent:<\/b>\s*(\d+)/);
    if (absMatch) student.daysAbsent = parseInt(absMatch[1]);

    const lateMatch = html.match(/<b>Days Late:<\/b>\s*(\d+)/);
    if (lateMatch) student.daysLate = parseInt(lateMatch[1]);

    const earlyMatch = html.match(/<b>Early Dismissals<\/b>[^:]*:\s*(\d+)/);
    if (earlyMatch) student.earlyDismissals = parseInt(earlyMatch[1]);

    const demMatch = html.match(/<b>Total Demerits YTD:<\/b>\s*(\d+)/);
    if (demMatch) student.totalDemerits = parseInt(demMatch[1]);

    return student;
  }

  private parseGrades(html: string): SubjectGrade[] {
    const grades: SubjectGrade[] = [];

    const gradeRowRegex =
      /<tr\s+style="font-weight:normal;\s*background-color:#ddd;">\s*<td><b>(Per\.\s*\d+)\.\s*<a[^>]*>([^<]+)<\/a><\/b><br><font[^>]*>(\w+\.?\s+\w+(?:\s+\w+)?)\s*&nbsp;\s*<a\s+href="mailto:([^"]*)">[^<]*<\/a><\/font><\/td>((?:<td[^>]*>[^<]*<\/td>)*)<td[^>]*>([^<]+?)(?:<br>[\s\S]*?)?<\/td><\/tr>/g;

    let match;
    while ((match = gradeRowRegex.exec(html)) !== null) {
      const period = match[1].trim();
      const subject = match[2].trim();
      const teacher = match[3].trim();
      const teacherEmail = match[4].trim();
      const gradeCellsHtml = match[5];
      const overallCell = match[6].trim();

      const cellRegex = /<td[^>]*>([^<]*)<\/td>/g;
      const cells: string[] = [];
      let cellMatch;
      while ((cellMatch = cellRegex.exec(gradeCellsHtml)) !== null) {
        cells.push(cellMatch[1].trim());
      }

      const grade: SubjectGrade = {
        period,
        subject,
        teacher,
        teacherEmail,
        comments: [],
      };

      if (cells.length >= 1) grade.gp1 = this.cleanGrade(cells[0]);
      if (cells.length >= 2) grade.gp2 = this.cleanGrade(cells[1]);
      if (cells.length >= 3) grade.s1 = this.cleanGrade(cells[2]);
      if (cells.length >= 4) grade.gp3 = this.cleanGrade(cells[3]);
      if (cells.length >= 5) grade.gp4 = this.cleanGrade(cells[4]);
      if (cells.length >= 6) grade.s2 = this.cleanGrade(cells[5]);
      grade.overall = this.cleanGrade(overallCell);

      grades.push(grade);
    }

    this.parseComments(html, grades);
    return grades;
  }

  private parseComments(html: string, grades: SubjectGrade[]): void {
    const commentRegex =
      /<div\s+style="display:inline;\s*max-width:800px;">\s*<b>(GP\d+)<\/b>:\s*(.*?)\s*<\/div>/g;

    const subjectPositions: { subject: string; pos: number }[] = [];
    const subjectAnchorRegex = /Per\.\s*\d+\.\s*<a[^>]*>([^<]+)<\/a>/g;
    let sMatch;
    while ((sMatch = subjectAnchorRegex.exec(html)) !== null) {
      subjectPositions.push({ subject: sMatch[1].trim(), pos: sMatch.index });
    }

    let cMatch;
    while ((cMatch = commentRegex.exec(html)) !== null) {
      const commentPos = cMatch.index;
      const gpLabel = cMatch[1];
      const commentText = this.stripHtml(cMatch[2]).trim();
      if (!commentText) continue;

      let ownerSubject = "";
      for (let i = subjectPositions.length - 1; i >= 0; i--) {
        if (subjectPositions[i].pos < commentPos) {
          ownerSubject = subjectPositions[i].subject;
          break;
        }
      }

      const grade = grades.find((g) => g.subject === ownerSubject);
      if (grade) {
        grade.comments.push(`${gpLabel}: ${commentText}`);
      }
    }
  }

  parseAssignmentDetails(html: string): AssignmentDetail[] {
    const details: AssignmentDetail[] = [];

    // Find each subject's assignment div by its class pattern
    const subjectDivRegex =
      /class="assignments-[^"]+"\s+style="display:none[^"]*">\s*<table>([\s\S]*?)<\/table>/g;

    // Map div positions to subjects
    const subjectPositions: { subject: string; pos: number }[] = [];
    const subjectAnchorRegex = /Per\.\s*\d+\.\s*<a[^>]*>([^<]+)<\/a>/g;
    let sMatch;
    while ((sMatch = subjectAnchorRegex.exec(html)) !== null) {
      subjectPositions.push({ subject: sMatch[1].trim(), pos: sMatch.index });
    }

    let divMatch;
    while ((divMatch = subjectDivRegex.exec(html)) !== null) {
      const tableHtml = divMatch[1];
      const divPos = divMatch.index;

      let currentSubject = "";
      for (let i = subjectPositions.length - 1; i >= 0; i--) {
        if (subjectPositions[i].pos < divPos) {
          currentSubject = subjectPositions[i].subject;
          break;
        }
      }

      let currentGP = "";
      let currentCategory = "";

      // Parse rows within assignment table
      const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
      let rowMatch;
      while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
        const row = rowMatch[1];

        // Grading period header: <b>Grading Period N</b>
        const gpMatch = row.match(/<b>(Grading Period \d+)<\/b>/);
        if (gpMatch) {
          currentGP = gpMatch[1];
          continue;
        }

        // Category header: <b>Class work (20%)</b>, <b>Quizzes (30%)</b>, etc.
        const catMatch = row.match(
          /<b>([^<]+\(\d+%\))<\/b>/
        );
        if (catMatch) {
          currentCategory = catMatch[1].trim();
          continue;
        }

        // Assignment row: has score like "80/100 (80%)" and a date
        const scoreMatch = row.match(
          /([\d.]+)\/([\d.]+)\s*\((\d+)%\)/
        );
        const dateMatch = row.match(
          /(\w{3}\s+\d{2},\s+\d{4})/
        );
        const nameMatch = row.match(
          /min-width:250px[^>]*>&nbsp;\s*([\s\S]*?)&nbsp;\s*&nbsp;/
        );

        if (scoreMatch && dateMatch && nameMatch && currentSubject) {
          details.push({
            subject: currentSubject,
            gradingPeriod: currentGP,
            category: currentCategory,
            name: this.stripHtml(nameMatch[1]).trim(),
            score: scoreMatch[1],
            maxScore: scoreMatch[2],
            percent: parseFloat(scoreMatch[3]),
            date: dateMatch[1],
          });
        }
      }
    }

    return details;
  }

  private parseHomework(html: string): HomeworkItem[] {
    const items: HomeworkItem[] = [];

    const hwStart = html.indexOf("<b>Homework</b>");
    const hwEnd = html.indexOf("<b>Upcoming Assignments");
    if (hwStart === -1 || hwEnd === -1) return items;
    const hwHtml = html.substring(hwStart, hwEnd);

    let currentSubject = "";
    let currentTeacher = "";

    const rowRegex = /(<tr[^>]*>)([\s\S]*?)<\/tr>/g;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(hwHtml)) !== null) {
      const trTag = rowMatch[1];
      const rowContent = rowMatch[2];

      if (trTag.includes("background-color:#ddd")) {
        const boldMatch = rowContent.match(
          /font-weight:bold[^>]*>\s*([\s\S]*?)\s*<\/td>/
        );
        if (boldMatch) {
          const subjectText = this.stripHtml(boldMatch[1]).trim();
          const teacherSplit = subjectText.match(
            /^(.+?)\s+-\s+((?:Mr|Mrs|Ms|Miss|Dr)\.?\s+.+)$/
          );
          if (teacherSplit) {
            currentSubject = teacherSplit[1].trim();
            currentTeacher = teacherSplit[2].trim();
          } else {
            currentSubject = subjectText;
            currentTeacher = "";
          }
        }
        continue;
      }

      const isTonight = rowContent.includes("tonight");

      const dateCell = rowContent.match(/<td[^>]*>([\s\S]*?)<\/td>/);
      if (!dateCell) continue;
      const dateText = this.stripHtml(dateCell[1]).trim();
      const dateOnly = dateText.replace(/\(.*?\)/g, "").trim();

      const descCell = rowContent.match(
        /max-width:700px[^>]*>([\s\S]*?)<\/td>/
      );
      if (!descCell || !dateOnly || !currentSubject) continue;

      const description = this.stripHtml(descCell[1]).trim();
      if (!description) continue;
      if (dateOnly === "Day Assigned") continue;

      items.push({
        subject: currentSubject,
        teacher: currentTeacher,
        date: dateOnly,
        description,
        isTonight,
      });
    }

    return items;
  }

  private parseMissingAssignments(html: string): MissingAssignment[] {
    const items: MissingAssignment[] = [];

    const missingSectionMatch = html.match(
      /<b>Missing Assignments<\/b>[\s\S]*?<table>([\s\S]*?)<\/table>/
    );
    if (!missingSectionMatch) return items;
    const tableHtml = missingSectionMatch[1];

    const rowRegex = /<tr>\s*([\s\S]*?)\s*<\/tr>/g;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
      const cells = this.extractCells(rowMatch[1]);
      if (cells.length >= 4) {
        items.push({
          dueDate: cells[0].trim(),
          subject: cells[1].trim(),
          teacher: cells[2].trim(),
          description: cells[3].trim(),
        });
      }
    }

    return items;
  }

  private parseUpcomingAssignments(html: string): UpcomingAssignment[] {
    const items: UpcomingAssignment[] = [];

    const upcomingSectionMatch = html.match(
      /<b>Upcoming Assignments and Assessments<\/b>[\s\S]*?<table>([\s\S]*?)<\/table>/
    );
    if (!upcomingSectionMatch) return items;
    const tableHtml = upcomingSectionMatch[1];

    const rowRegex = /<tr>\s*([\s\S]*?)\s*<\/tr>/g;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
      const cells = this.extractCells(rowMatch[1]);
      if (cells.length >= 4) {
        items.push({
          date: cells[0].trim(),
          subject: cells[1].trim(),
          teacher: cells[2].trim(),
          description: cells[3].trim(),
        });
      }
    }

    return items;
  }

  // --- Utilities ---

  private cleanGrade(raw: string): string {
    return raw.replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  private extractCells(rowHtml: string): string[] {
    const cells: string[] = [];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let m;
    while ((m = cellRegex.exec(rowHtml)) !== null) {
      cells.push(this.stripHtml(m[1]));
    }
    return cells;
  }

  private ensureLoggedIn(): void {
    if (!this.loggedIn || !this.page) {
      throw new Error("Not logged in. Call the login tool first.");
    }
  }

  private async navigateToReport(): Promise<void> {
    const page = this.page!;
    const url = page.url();
    if (!url.includes("student-report")) {
      await page.goto(`${BASE_URL}/student-report.php`, {
        waitUntil: "networkidle",
      });
    }
  }

  private async switchStudent(studentName: string): Promise<void> {
    const page = this.page!;
    const select = page.locator('select[name="studentid"]');
    if ((await select.count()) === 0) {
      throw new Error("Student dropdown not found on page.");
    }

    const options = await select.locator("option").all();
    for (const opt of options) {
      const text = (await opt.textContent())?.trim();
      if (text && text.toLowerCase().includes(studentName.toLowerCase())) {
        const value = await opt.getAttribute("value");
        if (value) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: "networkidle" }),
            select.selectOption(value),
          ]);
          return;
        }
      }
    }

    throw new Error(
      `Student "${studentName}" not found. Use list_students to see available students.`
    );
  }

  private async findInput(
    hints: string[]
  ): Promise<ReturnType<Page["locator"]> | null> {
    const page = this.page!;
    for (const hint of hints) {
      for (const sel of [
        `input[name*="${hint}" i]`,
        `input[type="${hint}" i]`,
        `input[id*="${hint}" i]`,
        `input[placeholder*="${hint}" i]`,
      ]) {
        const loc = page.locator(sel);
        if ((await loc.count()) > 0) return loc.first();
      }
    }
    return null;
  }

  private async findSubmitButton(): Promise<ReturnType<
    Page["locator"]
  > | null> {
    const page = this.page!;

    const submitBtn = page.locator(
      'button[type="submit"], input[type="submit"]'
    );
    if ((await submitBtn.count()) > 0) return submitBtn.first();

    for (const text of [
      "Sign In", "Login", "Log In", "Submit", "Sign in",
    ]) {
      const btn = page.locator(`button:has-text("${text}")`);
      if ((await btn.count()) > 0) return btn.first();
      const input = page.locator(`input[value="${text}" i]`);
      if ((await input.count()) > 0) return input.first();
    }

    return null;
  }
}
