export interface Student {
  id: string;
  name: string;
  gradeLevel?: string;
  teacher?: string;
  birthday?: string;
  daysAbsent?: number;
  daysLate?: number;
  earlyDismissals?: number;
  totalDemerits?: number;
}

export interface HomeworkItem {
  subject: string;
  teacher: string;
  date: string;
  description: string;
  isTonight: boolean;
}

export interface MissingAssignment {
  dueDate: string;
  subject: string;
  teacher: string;
  description: string;
}

export interface UpcomingAssignment {
  date: string;
  subject: string;
  teacher: string;
  description: string;
}

export interface SubjectGrade {
  period: string;
  subject: string;
  teacher: string;
  teacherEmail?: string;
  gp1?: string;
  gp2?: string;
  s1?: string;
  gp3?: string;
  gp4?: string;
  s2?: string;
  overall?: string;
  comments: string[];
}

export interface AssignmentDetail {
  subject: string;
  gradingPeriod: string;
  category: string;
  name: string;
  score: string;
  maxScore: string;
  percent: number;
  date: string;
}

export interface ScheduleEntry {
  period: string;
  subject: string;
  courseId?: string;
  teacher: string;
  schedule: string;
  room: string;
  semester?: string;
}

export interface StudentSchedule {
  student: Student;
  rotationDay: string;
  entries: ScheduleEntry[];
}

export interface StudentReport {
  student: Student;
  grades: SubjectGrade[];
  assignments: AssignmentDetail[];
  homework: HomeworkItem[];
  missingAssignments: MissingAssignment[];
  upcomingAssignments: UpcomingAssignment[];
  schoolYear: string;
  reportDate: string;
}

// --- Caching types ---

export interface CacheMetadata {
  fetchedAt: string;
  isFrozen: boolean;
  ageMinutes: number;
  source: "cache" | "live";
}

export interface CachedReport extends StudentReport {
  cache: CacheMetadata;
}

export interface SyncStatusEntry {
  studentName: string;
  studentId: string;
  schoolYear: string;
  dataType: string;
  lastSynced: string | null;
  recordCount: number;
  isFrozen: boolean;
}

export interface SyncStatus {
  dbPath: string;
  totalRecords: number;
  students: SyncStatusEntry[];
}
