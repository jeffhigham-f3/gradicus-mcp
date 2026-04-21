#!/usr/bin/env node
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'gradicus.db');
const OUT_DIR = join(__dirname, 'dist');
const OUT_PATH = join(OUT_DIR, 'index.html');
const STATIC_DIR = join(__dirname, 'static');

// Recursively copy report/static/* into report/dist/, preserving subdirectories.
// Called after the main HTML is written so the PWA shell (manifest, sw.js,
// icons) ends up in dist/ and Netlify deploys them with the rest.
function cpStaticAssets(srcDir, destDir) {
  let entries;
  try { entries = readdirSync(srcDir); } catch { return 0; }
  let count = 0;
  for (const name of entries) {
    const srcPath = join(srcDir, name);
    const destPath = join(destDir, name);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      count += cpStaticAssets(srcPath, destPath);
    } else if (st.isFile()) {
      copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}

function getCurrentSchoolYear() {
  const now = new Date();
  const m = now.getMonth() + 1;
  const y = now.getFullYear();
  return m >= 8 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

function extractPercent(s) {
  if (!s) return null;
  const m = s.match(/\((\d+)%\)/);
  return m ? parseInt(m[1]) : null;
}

function extractLetter(s) {
  if (!s) return null;
  const m = s.match(/^([A-F][+-]?)/);
  return m ? m[1] : null;
}

function gradeColor(pct) {
  if (pct === null || pct === undefined) return '#64748b';
  if (pct >= 90) return '#22c55e';
  if (pct >= 80) return '#3b82f6';
  if (pct >= 70) return '#f59e0b';
  if (pct >= 60) return '#f97316';
  return '#ef4444';
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseFlexDate(s) {
  if (!s) return null;
  const cleaned = String(s).replace(/^Due\s+/i, '').trim();
  if (cleaned.match(/\d{4}/)) {
    const direct = new Date(cleaned);
    if (!isNaN(direct.getTime())) return direct;
  }
  const md = cleaned.match(/^([A-Za-z]+)\s+(\d+)/);
  if (md) {
    const today = new Date();
    let candidate = new Date(`${md[1]} ${md[2]}, ${today.getFullYear()}`);
    if (candidate.getTime() - today.getTime() > 60 * 86400000) {
      candidate = new Date(`${md[1]} ${md[2]}, ${today.getFullYear() - 1}`);
    }
    if (!isNaN(candidate.getTime())) return candidate;
  }
  return null;
}

function daysSince(date) {
  if (!date) return null;
  return Math.floor((Date.now() - date.getTime()) / 86400000);
}

function gradeTrend(g) {
  const values = ['gp1', 'gp2', 'gp3', 'gp4'].map(f => extractPercent(g[f])).filter(v => v !== null);
  if (values.length < 2) return { label: '—', cls: 'flat', type: 'none' };
  const diff = values[values.length - 1] - values[values.length - 2];
  if (diff <= -15) return { label: `↓ ${Math.abs(diff)}pts`, cls: 'down', type: 'sharp_drop' };
  if (diff <= -5) return { label: `↓ ${Math.abs(diff)}pts`, cls: 'warn', type: 'declining' };
  if (diff >= 15) return { label: `↑ ${diff}pts`, cls: 'up', type: 'sharp_rise' };
  if (diff >= 5) return { label: `↑ ${diff}pts`, cls: 'up', type: 'improving' };
  return { label: `→ ${diff >= 0 ? '+' : ''}${diff}pts`, cls: 'flat', type: 'stable' };
}

function buildPriorities(s) {
  const items = [];

  for (const m of s.missing) {
    const d = parseFlexDate(m.dueDate);
    const days = daysSince(d);
    let title;
    if (days !== null && days > 14) title = `${days}d overdue · ${m.subject}`;
    else if (days !== null && days > 0) title = `Overdue ${days}d · ${m.subject}`;
    else title = `Missing · ${m.subject}`;
    items.push({
      priority: 'urgent', icon: days > 14 ? '🚨' : '⚠️',
      title, detail: m.description, meta: m.dueDate || null,
      sortKey: -(days || 0),
    });
  }

  for (const h of s.homework.filter(x => x.isTonight)) {
    items.push({
      priority: 'tonight', icon: '📚',
      title: `Tonight · ${h.subject}`, detail: h.description, meta: null,
      sortKey: -1000,
    });
  }

  for (const u of s.upcoming) {
    const d = parseFlexDate(u.date);
    if (!d) continue;
    const daysUntil = -daysSince(d);
    if (daysUntil < 0 || daysUntil > 7) continue;
    const when = daysUntil === 0 ? 'Today' : daysUntil === 1 ? 'Tomorrow' : `In ${daysUntil}d`;
    items.push({
      priority: 'week', icon: '📅',
      title: `${when} · ${u.subject}`, detail: u.description, meta: u.date,
      sortKey: daysUntil,
    });
  }

  for (const g of s.grades) {
    if (g.pct !== null && g.pct < 60) {
      items.push({
        priority: 'urgent', icon: '📉',
        title: `Failing · ${g.subject}`, detail: `Currently ${g.overall} with ${esc(g.teacher)}`,
        meta: null, sortKey: -500,
      });
    } else if (g.pct !== null && g.pct < 70) {
      const trend = gradeTrend(g);
      if (trend.type === 'sharp_drop' || trend.type === 'declining') {
        items.push({
          priority: 'watch', icon: '📊',
          title: `Declining · ${g.subject}`, detail: `${g.overall} (${trend.label}) with ${esc(g.teacher)}`,
          meta: null, sortKey: 100,
        });
      }
    }
  }

  const recentDemerits = s.demerits.filter(d => {
    const date = parseFlexDate(d.date);
    const ds = daysSince(date);
    return ds !== null && ds <= 7;
  });
  if (recentDemerits.length > 0) {
    const list = recentDemerits.map(d => d.infraction).join(', ');
    items.push({
      priority: 'watch', icon: '⚠️',
      title: `${recentDemerits.length} demerit${recentDemerits.length > 1 ? 's' : ''} this week`,
      detail: list, meta: null, sortKey: 200,
    });
  }

  const recentAtt = s.attendance.records.filter(r => {
    const date = parseFlexDate(r.date);
    const ds = daysSince(date);
    return ds !== null && ds <= 7;
  });
  if (recentAtt.length > 0) {
    items.push({
      priority: 'watch', icon: '🕐',
      title: `${recentAtt.length} attendance event${recentAtt.length > 1 ? 's' : ''} this week`,
      detail: recentAtt.map(r => `${r.date}: ${r.type}`).join('; '),
      meta: null, sortKey: 300,
    });
  }

  items.sort((a, b) => {
    const order = { urgent: 0, tonight: 1, week: 2, watch: 3 };
    if (order[a.priority] !== order[b.priority]) return order[a.priority] - order[b.priority];
    return a.sortKey - b.sortKey;
  });

  return items;
}

function calcStatus(s, priorities) {
  const failing = s.grades.filter(g => g.pct !== null && g.pct < 60).length;
  const overdue = s.missing.filter(m => {
    const d = parseFlexDate(m.dueDate);
    const ds = daysSince(d);
    return ds === null || ds > 14;
  }).length;
  const yearDemerits = s.demerits[0]?.yearTotal || s.totalDemerits || 0;
  const tonightCount = s.homework.filter(h => h.isTonight).length;

  if (failing >= 2 || overdue >= 2 || yearDemerits >= 30) {
    const msgParts = [];
    if (failing > 0) msgParts.push(`${failing} failing subject${failing > 1 ? 's' : ''}`);
    if (overdue > 0) msgParts.push(`${overdue} long-overdue assignment${overdue > 1 ? 's' : ''}`);
    if (yearDemerits >= 30) msgParts.push(`${yearDemerits} demerits YTD`);
    return { level: 'critical', icon: '🚨', title: 'Needs Immediate Attention',
      msg: msgParts.join(' · ') + '. Address urgent items below.' };
  }
  if (failing >= 1 || s.missing.length > 0 || yearDemerits >= 15) {
    const msgParts = [];
    if (failing > 0) msgParts.push(`${failing} subject below 60%`);
    if (s.missing.length > 0) msgParts.push(`${s.missing.length} missing assignment${s.missing.length > 1 ? 's' : ''}`);
    if (tonightCount > 0) msgParts.push(`${tonightCount} item${tonightCount > 1 ? 's' : ''} tonight`);
    if (msgParts.length === 0) msgParts.push(`${yearDemerits} demerits YTD`);
    return { level: 'concern', icon: '⚠️', title: 'Areas to Watch', msg: msgParts.join(' · ') + '.' };
  }
  if (priorities.length > 0) {
    return { level: 'watch', icon: 'ℹ️', title: 'On Track — A Few Items',
      msg: tonightCount > 0 ? `${tonightCount} homework item${tonightCount > 1 ? 's' : ''} for tonight.` : 'Review the items below.' };
  }
  return { level: 'good', icon: '✓', title: 'Doing Great', msg: 'No urgent action items today.' };
}

// --- Read database ---

const db = new Database(DB_PATH, { readonly: true });
const currentYear = getCurrentSchoolYear();
const students = db.prepare('SELECT * FROM students ORDER BY name').all();

const data = students.map(s => {
  const id = s.id;
  const grades = db.prepare('SELECT * FROM grades WHERE student_id=? AND school_year=? ORDER BY period').all(id, currentYear);
  const assignments = db.prepare('SELECT * FROM assignments WHERE student_id=? AND school_year=? ORDER BY date DESC LIMIT 150').all(id, currentYear);
  const homework = db.prepare('SELECT * FROM homework WHERE student_id=? ORDER BY is_tonight DESC, date DESC').all(id);
  const missing = db.prepare('SELECT * FROM missing_assignments WHERE student_id=? ORDER BY due_date').all(id);
  const upcoming = db.prepare('SELECT * FROM upcoming_assignments WHERE student_id=? ORDER BY date').all(id);
  const attTotals = db.prepare('SELECT * FROM attendance_totals WHERE student_id=? AND school_year=?').get(id, currentYear) ?? {};
  const attRecords = db.prepare('SELECT * FROM attendance_records WHERE student_id=? AND school_year=? ORDER BY date DESC').all(id, currentYear);
  const demeritRows = db.prepare('SELECT * FROM demerits WHERE student_id=? AND school_year=? ORDER BY date DESC').all(id, currentYear);
  const emailRows = db.prepare('SELECT * FROM emails WHERE student_id=? ORDER BY date DESC LIMIT 20').all(id);
  const attSummary = db.prepare('SELECT * FROM attendance WHERE student_id=? AND school_year=?').get(id, currentYear) ?? {};

  const mappedGrades = grades.map(g => ({
    period: g.period, subject: g.subject, teacher: g.teacher,
    gp1: g.gp1, gp2: g.gp2, s1: g.s1, gp3: g.gp3, gp4: g.gp4, s2: g.s2,
    overall: g.overall, comments: JSON.parse(g.comments || '[]'),
    pct: extractPercent(g.overall), letter: extractLetter(g.overall),
  }));

  return {
    id, name: s.name, gradeLevel: s.grade_level, teacher: s.homeroom_teacher,
    grades: mappedGrades,
    assignments: assignments.map(a => ({
      subject: a.subject, name: a.name, score: a.score, maxScore: a.max_score,
      percent: a.percent, date: a.date, category: a.category, gradingPeriod: a.grading_period,
    })),
    homework: homework.map(h => ({ subject: h.subject, description: h.description, date: h.date, isTonight: !!h.is_tonight })),
    missing: missing.map(m => ({ dueDate: m.due_date, subject: m.subject, description: m.description })),
    upcoming: upcoming.map(u => ({ date: u.date, subject: u.subject, description: u.description })),
    attendance: {
      absentExcused: attTotals.absent_excused || 0,
      absentUnexcused: attTotals.absent_unexcused || 0,
      tardyExcused: attTotals.tardy_excused || 0,
      tardyUnexcused: attTotals.tardy_unexcused || 0,
      earlyExcused: attTotals.early_dismissal_excused || 0,
      earlyUnexcused: attTotals.early_dismissal_unexcused || 0,
      totalTimeLost: attTotals.total_time_lost || '',
      records: attRecords.map(r => ({ date: r.date, type: r.type, reason: r.reason, timeLost: r.time_lost, section: r.section })),
    },
    demerits: demeritRows.map(d => ({
      date: d.date, teacher: d.issuing_teacher, infraction: d.infraction,
      detail: d.detail, issued: d.demerits_issued, gpTotal: d.gp_total, yearTotal: d.year_total,
    })),
    emails: emailRows.map(e => ({ date: e.date, from: e.sender, subject: e.subject, body: e.body })),
    totalDemerits: attSummary.total_demerits || 0,
    daysAbsent: attSummary.days_absent || 0,
    daysLate: attSummary.days_late || 0,
  };
});

db.close();

// --- Attach AI-generated insights (one paragraph per student) ---
//
// The MCP daily_report tool passes a JSON-encoded {studentName: paragraph}
// map via GRADICUS_AI_INSIGHTS. The map's keys can be a full name, first
// name, or last name; we match case-insensitively on substring.

let aiInsights = {};
if (process.env.GRADICUS_AI_INSIGHTS) {
  try {
    aiInsights = JSON.parse(process.env.GRADICUS_AI_INSIGHTS);
  } catch (err) {
    console.error('Failed to parse GRADICUS_AI_INSIGHTS:', err.message);
  }
}

function findInsight(studentName) {
  const target = studentName.toLowerCase();
  for (const [key, value] of Object.entries(aiInsights)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const k = key.toLowerCase();
    if (target.includes(k) || k.includes(target)) return value.trim();
  }
  return null;
}

for (const s of data) {
  s.aiInsight = findInsight(s.name);
}

const familyInsight = (process.env.GRADICUS_FAMILY_INSIGHT || '').trim();

// --- Compute priorities & status per student ---

for (const s of data) {
  s.priorities = buildPriorities(s);
  s.status = calcStatus(s, s.priorities);
}

// --- Chart data ---

function buildDemeritChart(demerits) {
  const byMonth = {};
  for (const d of demerits) {
    if (!d.date) continue;
    const key = d.date.substring(0, 7);
    byMonth[key] = (byMonth[key] || 0) + (d.issued || 1);
  }
  const sorted = Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b));
  return {
    labels: sorted.map(([k]) => {
      const [y, m] = k.split('-');
      return new Date(parseInt(y), parseInt(m) - 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    }),
    data: sorted.map(([, v]) => v),
  };
}

const chartData = data.map(s => ({
  gradeChart: {
    labels: s.grades.map(g => g.subject.replace('English Language Arts - ', 'ELA — ')),
    data: s.grades.map(g => g.pct),
    colors: s.grades.map(g => gradeColor(g.pct)),
  },
  attendanceChart: {
    labels: ['Absent (Unexcused)', 'Absent (Excused)', 'Tardy (Unexcused)', 'Tardy (Excused)', 'Early Dismissal'],
    data: [
      s.attendance.absentUnexcused, s.attendance.absentExcused,
      s.attendance.tardyUnexcused, s.attendance.tardyExcused,
      s.attendance.earlyExcused + s.attendance.earlyUnexcused,
    ],
    colors: ['#ef4444', '#f97316', '#f59e0b', '#fbbf24', '#60a5fa'],
  },
  demeritChart: buildDemeritChart(s.demerits),
}));

// --- HTML generation ---

function renderGradeCell(val) {
  if (!val || val === '-') return `<td class="gc muted">—</td>`;
  const pct = extractPercent(val);
  const color = gradeColor(pct);
  return `<td class="gc" style="color:${color}">${esc(val)}</td>`;
}

function renderAiInsight(s) {
  if (!s.aiInsight) return '';
  // Tolerate the LLM accidentally producing multiple paragraphs.
  const paragraphs = s.aiInsight.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  return `
<section class="ai-insight">
  <div class="ai-insight-hdr">
    <span class="ai-insight-icon" aria-hidden="true">✨</span>
    <span class="ai-insight-label">Today's Insight for ${esc(s.name.split(' ')[0])}</span>
    <span class="ai-insight-tag" title="Generated by AI from today's data">AI</span>
  </div>
  ${paragraphs.map(p => `<p class="ai-insight-body">${esc(p)}</p>`).join('')}
</section>`;
}

function renderStatusBanner(status) {
  return `
<div class="status-banner ${status.level}">
  <div class="status-icon">${status.icon}</div>
  <div class="status-text">
    <div class="status-title">${esc(status.title)}</div>
    <div class="status-msg">${esc(status.msg)}</div>
  </div>
</div>`;
}

function renderPriorities(items) {
  if (items.length === 0) {
    return `
<section class="section">
  <h2 class="section-title"><span class="icon">🎯</span> Today's Priorities</h2>
  <div class="no-priorities">✓ No urgent action items. Keep up the good work.</div>
</section>`;
  }
  return `
<section class="section">
  <h2 class="section-title"><span class="icon">🎯</span> Today's Priorities</h2>
  <div class="priority-list">
    ${items.map(it => `
    <div class="priority-item ${it.priority}">
      <div class="priority-icon">${it.icon}</div>
      <div class="priority-body">
        <div class="priority-chip ${it.priority}">${it.priority === 'urgent' ? 'Urgent' : it.priority === 'tonight' ? 'Tonight' : it.priority === 'week' ? 'This Week' : 'Watch'}</div>
        <div class="priority-title">${esc(it.title)}</div>
        ${it.detail ? `<div class="priority-detail">${esc(it.detail)}</div>` : ''}
        ${it.meta ? `<div class="priority-meta">${esc(it.meta)}</div>` : ''}
      </div>
    </div>`).join('')}
  </div>
</section>`;
}

function renderTeacherComments(s) {
  const blocks = [];
  for (const g of s.grades) {
    if (g.comments && g.comments.length > 0) {
      for (const c of g.comments) {
        blocks.push({ subject: g.subject, teacher: g.teacher, period: g.period, comment: c, pct: g.pct });
      }
    }
  }
  if (blocks.length === 0) return '';
  return `
<section class="section">
  <h2 class="section-title"><span class="icon">💬</span> What Teachers Are Saying</h2>
  <div class="tcomment-grid">
    ${blocks.map(b => `
    <div class="tcomment" style="border-left-color:${gradeColor(b.pct)}">
      <div class="tcomment-quote">${esc(b.comment)}</div>
      <div class="tcomment-attr"><strong>${esc(b.teacher)}</strong> · ${esc(b.subject)}${b.period ? ` · Period ${esc(b.period)}` : ''}</div>
    </div>`).join('')}
  </div>
</section>`;
}

function renderOverview(s, i) {
  const strong = s.grades.filter(g => g.pct !== null && g.pct >= 80).length;
  const fair = s.grades.filter(g => g.pct !== null && g.pct >= 70 && g.pct < 80).length;
  const attn = s.grades.filter(g => g.pct !== null && g.pct < 70).length;
  const totalAbsent = s.attendance.absentExcused + s.attendance.absentUnexcused;
  const yearDemerits = s.demerits.length > 0 ? s.demerits[0].yearTotal : s.totalDemerits;
  return `
<section class="section">
  <h2 class="section-title"><span class="icon">📊</span> Overview</h2>
  <div class="stat-grid">
    <div class="stat-card"><div class="stat-num green">${strong}</div><div class="stat-lbl">Strong Grades</div></div>
    <div class="stat-card"><div class="stat-num amber">${fair}</div><div class="stat-lbl">Fair Grades</div></div>
    <div class="stat-card"><div class="stat-num red">${attn}</div><div class="stat-lbl">Needs Attention</div></div>
    <div class="stat-card"><div class="stat-num ${s.missing.length > 0 ? 'red' : 'green'}">${s.missing.length}</div><div class="stat-lbl">Missing</div></div>
    <div class="stat-card"><div class="stat-num ${totalAbsent > 5 ? 'red' : 'muted'}">${totalAbsent}</div><div class="stat-lbl">Absences</div></div>
    <div class="stat-card"><div class="stat-num ${yearDemerits > 15 ? 'red' : yearDemerits > 8 ? 'amber' : 'muted'}">${yearDemerits}</div><div class="stat-lbl">Demerits YTD</div></div>
  </div>
  <div class="chart-box">
    <div class="chart-label">Grade Overview by Subject</div>
    <canvas id="gc${i}" height="110"></canvas>
  </div>
</section>`;
}

function renderGrades(s) {
  if (!s.grades.length) return '';
  return `
<section class="section">
  <h2 class="section-title"><span class="icon">📝</span> Grades</h2>
  <div class="tbl-wrap">
    <table class="tbl">
      <thead><tr>
        <th>Per.</th><th>Subject</th><th>Teacher</th>
        <th>GP1</th><th>GP2</th><th>S1</th><th>GP3</th><th>GP4</th><th>S2</th><th>Overall</th><th>Trend</th>
      </tr></thead>
      <tbody>
        ${s.grades.map(g => {
          const tr = gradeTrend(g);
          return `<tr>
          <td class="per">${esc(g.period)}</td>
          <td class="subj">${esc(g.subject)}</td>
          <td class="tchr">${esc(g.teacher)}</td>
          ${renderGradeCell(g.gp1)}${renderGradeCell(g.gp2)}${renderGradeCell(g.s1)}
          ${renderGradeCell(g.gp3)}${renderGradeCell(g.gp4)}${renderGradeCell(g.s2)}
          <td class="overall" style="color:${gradeColor(g.pct)}">${esc(g.overall || '—')}</td>
          <td class="ctr"><span class="trend ${tr.cls}">${esc(tr.label)}</span></td>
        </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>
</section>`;
}

function renderAssignments(s) {
  if (!s.assignments.length) return '';
  const bySubject = {};
  for (const a of s.assignments) {
    if (!bySubject[a.subject]) bySubject[a.subject] = [];
    bySubject[a.subject].push(a);
  }
  return `
<section class="section">
  <h2 class="section-title"><span class="icon">📋</span> Recent Assignments</h2>
  <div class="asgn-grid">
    ${Object.entries(bySubject).map(([subj, items]) => `
    <div class="asgn-card">
      <div class="asgn-subj">${esc(subj)}</div>
      ${items.slice(0, 12).map(a => {
        const pct = typeof a.percent === 'number' ? a.percent : null;
        const color = gradeColor(pct);
        return `<div class="asgn-row">
          <span class="asgn-name">${esc(a.name)}</span>
          <span class="asgn-score" style="color:${color}">
            ${a.score && a.maxScore ? `${esc(a.score)}/${esc(a.maxScore)} ` : ''}${pct !== null ? `<b>${Math.round(pct)}%</b>` : ''}
          </span>
        </div>`;
      }).join('')}
    </div>`).join('')}
  </div>
</section>`;
}

function renderHomework(s) {
  const tonight = s.homework.filter(h => h.isTonight);
  const recent = s.homework.filter(h => !h.isTonight).slice(0, 6);
  return `
<section class="section">
  <h2 class="section-title"><span class="icon">📚</span> Homework &amp; Assignments</h2>
  ${s.missing.length ? `
  <div class="alert-box danger">
    <div class="alert-title">⚠ ${s.missing.length} Missing Assignment${s.missing.length > 1 ? 's' : ''}</div>
    ${s.missing.map(m => `<div class="alert-row">
      <span class="pill">${esc(m.subject)}</span>
      ${esc(m.description)}
      ${m.dueDate ? `<span class="due">Due: ${esc(m.dueDate)}</span>` : ''}
    </div>`).join('')}
  </div>` : ''}
  <div class="hw-block">
    <div class="hw-head">Tonight's Homework</div>
    ${tonight.length ? tonight.map(h => `<div class="hw-item tonight">
      <span class="pill">${esc(h.subject)}</span>${esc(h.description)}
    </div>`).join('') : '<div class="hw-empty">No homework assigned for tonight.</div>'}
  </div>
  ${s.upcoming.length ? `
  <div class="hw-block">
    <div class="hw-head">Upcoming</div>
    ${s.upcoming.map(u => `<div class="hw-item">
      <span class="pill">${esc(u.subject)}</span>${esc(u.description)}
      ${u.date ? `<span class="due">${esc(u.date)}</span>` : ''}
    </div>`).join('')}
  </div>` : ''}
  ${recent.length ? `
  <div class="hw-block">
    <div class="hw-head">Recent Homework</div>
    ${recent.map(h => `<div class="hw-item">
      ${h.date ? `<span class="date-lbl">${esc(h.date)}</span>` : ''}
      <span class="pill">${esc(h.subject)}</span>${esc(h.description)}
    </div>`).join('')}
  </div>` : ''}
</section>`;
}

function renderAttendance(s, i) {
  const att = s.attendance;
  const totalAbsent = att.absentExcused + att.absentUnexcused;
  const totalTardy = att.tardyExcused + att.tardyUnexcused;
  const totalEarly = att.earlyExcused + att.earlyUnexcused;
  return `
<section class="section">
  <h2 class="section-title"><span class="icon">📅</span> Attendance</h2>
  <div class="att-layout">
    <div class="att-stats">
      <div class="att-card ${totalAbsent > 5 ? 'red-card' : ''}">
        <div class="att-num">${totalAbsent}</div>
        <div class="att-lbl">Absences</div>
        <div class="att-sub">${att.absentExcused} excused · ${att.absentUnexcused} unexcused</div>
      </div>
      <div class="att-card ${totalTardy > 10 ? 'red-card' : totalTardy > 5 ? 'amber-card' : ''}">
        <div class="att-num">${totalTardy}</div>
        <div class="att-lbl">Tardies</div>
        <div class="att-sub">${att.tardyExcused} excused · ${att.tardyUnexcused} unexcused</div>
      </div>
      <div class="att-card">
        <div class="att-num">${totalEarly}</div>
        <div class="att-lbl">Early Dismissals</div>
        <div class="att-sub">${att.earlyExcused} excused · ${att.earlyUnexcused} unexcused</div>
      </div>
      ${att.totalTimeLost ? `<div class="att-card">
        <div class="att-num small">${esc(att.totalTimeLost)}</div>
        <div class="att-lbl">Time Lost</div>
      </div>` : ''}
    </div>
    <div class="chart-box compact"><canvas id="ac${i}" height="220"></canvas></div>
  </div>
  ${att.records.length ? `
  <div class="tbl-wrap" style="margin-top:1.25rem">
    <table class="tbl sm">
      <thead><tr><th>Date</th><th>Type</th><th>Reason</th><th>Time Lost</th></tr></thead>
      <tbody>
        ${att.records.slice(0, 25).map(r => `<tr>
          <td>${esc(r.date)}</td><td>${esc(r.type)}</td>
          <td>${esc(r.reason || '—')}</td><td>${esc(r.timeLost || '—')}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>` : ''}
</section>`;
}

function renderDemerits(s, i) {
  const yearTotal = s.demerits.length > 0 ? s.demerits[0].yearTotal : s.totalDemerits;
  const severity = yearTotal > 20 ? 'red-card' : yearTotal > 10 ? 'amber-card' : '';
  return `
<section class="section">
  <h2 class="section-title"><span class="icon">⚠️</span> Demerits</h2>
  <div class="dem-header">
    <div class="dem-total ${severity}">
      <div class="att-num">${yearTotal}</div>
      <div class="att-lbl">Total This Year</div>
    </div>
    ${s.demerits.length ? `<div class="chart-box compact flex-grow"><canvas id="dc${i}" height="160"></canvas></div>` : '<div class="empty-state">No demerit history.</div>'}
  </div>
  ${s.demerits.length ? `
  <div class="tbl-wrap" style="margin-top:1.25rem">
    <table class="tbl sm">
      <thead><tr><th>Date</th><th>Infraction</th><th>Detail</th><th>Teacher</th><th>Issued</th><th>YTD</th></tr></thead>
      <tbody>
        ${s.demerits.map(d => `<tr>
          <td>${esc(d.date)}</td><td>${esc(d.infraction)}</td>
          <td>${esc(d.detail || '—')}</td><td>${esc(d.teacher)}</td>
          <td class="ctr">${d.issued}</td>
          <td class="ctr ${d.yearTotal > 15 ? 'red-txt' : ''}">${d.yearTotal}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>` : ''}
</section>`;
}

function renderEmails(s) {
  return `
<section class="section">
  <h2 class="section-title"><span class="icon">✉️</span> Email Messages</h2>
  ${s.emails.length ? `<div class="email-list">
    ${s.emails.map(e => `<div class="email-card">
      <div class="email-hdr">
        <span class="email-from">${esc(e.from || 'School')}</span>
        <span class="email-date">${esc(e.date)}</span>
      </div>
      ${e.subject ? `<div class="email-subj">${esc(e.subject)}</div>` : ''}
      ${e.body ? `<div class="email-body">${esc(e.body.substring(0, 600))}${e.body.length > 600 ? '…' : ''}</div>` : ''}
    </div>`).join('')}
  </div>` : '<div class="empty-state">No messages found.</div>'}
</section>`;
}

function renderPanel(s, i) {
  return `
<div class="panel" id="panel${i}" hidden>
  <div class="student-hdr">
    <h2>${esc(s.name)}</h2>
    <p>${s.gradeLevel ? `Grade ${esc(s.gradeLevel)}` : ''}${s.teacher ? ` · Homeroom: ${esc(s.teacher)}` : ''}</p>
  </div>
  ${renderAiInsight(s)}
  ${renderStatusBanner(s.status)}
  ${renderPriorities(s.priorities)}
  ${renderHomework(s)}
  ${renderOverview(s, i)}
  ${renderGrades(s)}
  ${renderTeacherComments(s)}
  ${renderAssignments(s)}
  ${renderAttendance(s, i)}
  ${renderDemerits(s, i)}
  ${renderEmails(s)}
</div>`;
}

function renderFamilyInsight(text) {
  if (!text) return '';
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  return `
<section class="ai-insight family">
  <div class="ai-insight-hdr">
    <span class="ai-insight-icon" aria-hidden="true">🏡</span>
    <span class="ai-insight-label">Family Insight</span>
    <span class="ai-insight-tag" title="Generated by AI from today's data across all students">AI</span>
  </div>
  ${paragraphs.map(p => `<p class="ai-insight-body">${esc(p)}</p>`).join('')}
</section>`;
}

function renderOverallSummary(students, familyInsight) {
  const counts = { urgent: 0, tonight: 0, week: 0, watch: 0 };
  for (const s of students) for (const p of s.priorities) counts[p.priority]++;

  const order = { critical: 0, concern: 1, watch: 2, good: 3 };
  const indexed = students.map((s, i) => ({ s, originalIdx: i }));
  indexed.sort((a, b) => {
    const d = order[a.s.status.level] - order[b.s.status.level];
    return d !== 0 ? d : b.s.priorities.length - a.s.priorities.length;
  });
  const total = counts.urgent + counts.tonight + counts.week + counts.watch;

  return `
<section class="overall-summary">
  <div class="overall-header">
    <div>
      <div class="overall-title">📋 Today's Action Summary</div>
      <div class="overall-sub">${students.length} students · ${total} action item${total !== 1 ? 's' : ''} across all kids</div>
    </div>
    <div class="overall-counts">
      ${counts.urgent ? `<span class="count-pill urgent">${counts.urgent} urgent</span>` : ''}
      ${counts.tonight ? `<span class="count-pill tonight">${counts.tonight} tonight</span>` : ''}
      ${counts.week ? `<span class="count-pill week">${counts.week} this week</span>` : ''}
      ${counts.watch ? `<span class="count-pill watch">${counts.watch} watch</span>` : ''}
      ${total === 0 ? `<span class="count-pill good">✓ All clear</span>` : ''}
    </div>
  </div>
  ${renderFamilyInsight(familyInsight)}
  <div class="summary-grid">
    ${indexed.map(({ s, originalIdx }) => {
      const top = s.priorities.slice(0, 4);
      const more = s.priorities.length - top.length;
      return `
    <div class="summary-card status-${s.status.level}">
      <div class="summary-card-hdr">
        <div class="summary-icon">${s.status.icon}</div>
        <div class="summary-name">
          <div class="summary-fname">${esc(s.name.split(' ')[0])}</div>
          <div class="summary-stat">${esc(s.status.title)}</div>
        </div>
      </div>
      ${top.length > 0 ? `
      <ul class="summary-items">
        ${top.map(p => `
        <li class="summary-li">
          <span class="summary-dot ${p.priority}"></span>
          <span class="summary-li-text">${esc(p.title)}</span>
        </li>`).join('')}
      </ul>
      ${more > 0 ? `<div class="summary-more">+ ${more} more item${more > 1 ? 's' : ''}</div>` : ''}` : `
      <div class="summary-good">✓ No urgent items today</div>`}
      <button class="summary-jump" onclick="jumpTo(${originalIdx})">Open ${esc(s.name.split(' ')[0])}'s panel →</button>
    </div>`;
    }).join('')}
  </div>
</section>`;
}

// --- Build final HTML ---

const reportDate = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const generated = new Date().toISOString();

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Gradicus Report — ${esc(reportDate)}</title>
<!-- PWA -->
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#eef2ff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0b0f1a" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/icons/favicon.svg" type="image/svg+xml">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Gradicus">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="report-generated" content="${esc(generated)}">
<meta name="report-date" content="${esc(reportDate)}">
<script>
// Apply saved theme before paint to avoid flash
(function(){try{var t=localStorage.getItem('gradicus-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();
<\/script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"><\/script>
<style>
:root{
  color-scheme:light dark;
  /* color tokens */
  --bg:#f8fafc;--surface:#ffffff;--surface2:#f1f5f9;--surface3:#e2e8f0;
  --border:rgba(15,23,42,.08);--text:#0f172a;--muted:#64748b;
  --accent:#4f46e5;--accent-l:#4338ca;
  --green:#16a34a;--blue:#2563eb;--amber:#d97706;--orange:#ea580c;--red:#dc2626;
  --header-from:#eef2ff;--header-to:#ffffff;
  --title-grad-end:#7c3aed;
  --chart-grid:rgba(15,23,42,.08);
  --scrim:rgba(15,23,42,.42);
  --on-accent:#ffffff;
  /* shape (MD3) */
  --shape-xs:4px;--shape-sm:8px;--shape-md:12px;--shape-lg:16px;--shape-xl:24px;--shape-full:999px;
  --r:12px;
  /* elevation */
  --elev-1:0 1px 2px rgba(15,23,42,.06),0 1px 3px rgba(15,23,42,.04);
  --elev-2:0 4px 8px rgba(15,23,42,.08),0 2px 4px rgba(15,23,42,.04);
  --elev-3:0 10px 24px rgba(15,23,42,.10),0 4px 8px rgba(15,23,42,.04);
  /* motion (MD3 emphasized easings) */
  --motion-fast:160ms cubic-bezier(.2,0,0,1);
  --motion-standard:240ms cubic-bezier(.2,0,0,1);
  --motion-emphasized:380ms cubic-bezier(.05,.7,.1,1);
  /* touch targets */
  --touch-min:44px;--touch-comfy:48px;
  /* state layer opacities */
  --state-hover:.08;--state-focus:.12;--state-pressed:.16;
  /* layout */
  --appbar-h:56px;--appbar-h-large:80px;
  --gutter:1rem;
}
/* Dark palette: applied via OS preference unless user forced light */
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#0b0f1a;--surface:#141824;--surface2:#1b2236;--surface3:#232f47;
    --border:rgba(255,255,255,.07);--text:#e2e8f0;--muted:#94a3b8;
    --accent:#6366f1;--accent-l:#818cf8;
    --green:#22c55e;--blue:#3b82f6;--amber:#f59e0b;--orange:#f97316;--red:#ef4444;
    --header-from:#141d35;--header-to:#0b0f1a;
    --title-grad-end:#a78bfa;
    --chart-grid:rgba(255,255,255,.06);
    --scrim:rgba(0,0,0,.62);
    --elev-1:0 1px 2px rgba(0,0,0,.4),0 1px 3px rgba(0,0,0,.3);
    --elev-2:0 4px 12px rgba(0,0,0,.45),0 2px 6px rgba(0,0,0,.3);
    --elev-3:0 12px 32px rgba(0,0,0,.55),0 6px 12px rgba(0,0,0,.35);
  }
}
/* Manual override (toggle button) */
:root[data-theme="dark"]{
  --bg:#0b0f1a;--surface:#141824;--surface2:#1b2236;--surface3:#232f47;
  --border:rgba(255,255,255,.07);--text:#e2e8f0;--muted:#94a3b8;
  --accent:#6366f1;--accent-l:#818cf8;
  --green:#22c55e;--blue:#3b82f6;--amber:#f59e0b;--orange:#f97316;--red:#ef4444;
  --header-from:#141d35;--header-to:#0b0f1a;
  --title-grad-end:#a78bfa;
  --chart-grid:rgba(255,255,255,.06);
  --scrim:rgba(0,0,0,.62);
  --elev-1:0 1px 2px rgba(0,0,0,.4),0 1px 3px rgba(0,0,0,.3);
  --elev-2:0 4px 12px rgba(0,0,0,.45),0 2px 6px rgba(0,0,0,.3);
  --elev-3:0 12px 32px rgba(0,0,0,.55),0 6px 12px rgba(0,0,0,.35);
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;min-height:100dvh;font-size:16px;line-height:1.5;transition:background-color .2s ease,color .2s ease;overflow-x:hidden;padding-bottom:max(env(safe-area-inset-bottom),0px)}
a{color:var(--accent-l)}

/* App bar (sticky, condenses on scroll) */
.appbar{position:sticky;top:0;z-index:100;background:linear-gradient(135deg,var(--header-from) 0%,var(--header-to) 100%);border-bottom:1px solid transparent;padding:max(env(safe-area-inset-top),0px) max(env(safe-area-inset-right),0px) 0 max(env(safe-area-inset-left),0px);transition:background var(--motion-standard),border-color var(--motion-standard),box-shadow var(--motion-standard),backdrop-filter var(--motion-standard)}
:root[data-scrolled="true"] .appbar{background:color-mix(in oklab,var(--surface) 78%,transparent);backdrop-filter:saturate(180%) blur(14px);-webkit-backdrop-filter:saturate(180%) blur(14px);border-bottom-color:var(--border);box-shadow:var(--elev-1)}
.appbar-row{max-width:1400px;margin:0 auto;display:flex;align-items:center;gap:.5rem;padding:.5rem 1rem;min-height:var(--appbar-h)}
.appbar-spacer{flex:1;min-width:0}

/* Large title sits below the row at top of page; collapses on scroll. */
.appbar-bigtitle{max-width:1400px;margin:0 auto;padding:.25rem 1.25rem 1.25rem;overflow:hidden;transition:max-height var(--motion-standard),opacity var(--motion-standard),padding var(--motion-standard);max-height:140px;opacity:1}
.appbar-bigtitle .big{font-size:1.65rem;font-weight:800;background:linear-gradient(135deg,var(--accent-l),var(--title-grad-end));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;line-height:1.15}
.appbar-bigtitle .sub{color:var(--muted);font-size:.85rem;margin-top:.25rem}
:root[data-scrolled="true"] .appbar-bigtitle{max-height:0;opacity:0;padding-top:0;padding-bottom:0}

/* Icon button (hamburger, theme toggle, drawer-close) */
.icon-btn{position:relative;overflow:hidden;background:transparent;border:1px solid transparent;color:var(--text);width:var(--touch-min);height:var(--touch-min);border-radius:var(--shape-full);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:1.15rem;font-family:inherit;line-height:1;flex-shrink:0;transition:background var(--motion-fast),border-color var(--motion-fast),transform var(--motion-fast);-webkit-tap-highlight-color:transparent}
.icon-btn:hover{background:color-mix(in oklab,var(--text) 8%,transparent)}
.icon-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.icon-btn:active{transform:scale(.96)}
.icon-btn svg{width:1.35rem;height:1.35rem;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}

/* Theme toggle (icon-btn variant) */
.theme-toggle .icon-light{display:none}
.theme-toggle .icon-dark{display:inline}
:root[data-theme="dark"] .theme-toggle .icon-light{display:inline}
:root[data-theme="dark"] .theme-toggle .icon-dark{display:none}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]) .theme-toggle .icon-light{display:inline}
  :root:not([data-theme="light"]) .theme-toggle .icon-dark{display:none}
}

/* Active-student chip */
.active-chip{position:relative;overflow:hidden;display:inline-flex;align-items:center;gap:.5rem;background:var(--surface2);border:1px solid var(--border);color:var(--text);font:inherit;font-weight:600;font-size:.875rem;height:var(--touch-min);padding:0 .9rem 0 .75rem;border-radius:var(--shape-full);cursor:pointer;flex-shrink:1;min-width:0;max-width:60vw;transition:background var(--motion-fast),border-color var(--motion-fast),box-shadow var(--motion-fast);-webkit-tap-highlight-color:transparent}
.active-chip:hover{background:var(--surface3)}
.active-chip:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.active-chip .chip-dot{width:10px;height:10px;border-radius:50%;background:var(--accent);flex-shrink:0;transition:background var(--motion-fast)}
.active-chip[data-status="critical"] .chip-dot{background:var(--red)}
.active-chip[data-status="concern"] .chip-dot{background:var(--amber)}
.active-chip[data-status="watch"] .chip-dot{background:var(--accent)}
.active-chip[data-status="good"] .chip-dot{background:var(--green)}
.active-chip[data-status="summary"] .chip-dot{background:var(--title-grad-end)}
.active-chip .chip-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.active-chip .chip-caret{width:.85rem;height:.85rem;flex-shrink:0;opacity:.6;stroke:currentColor;fill:none;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}

/* Year badge (hidden on mobile, visible on tablet+) */
.year-badge{display:none;background:var(--surface2);border:1px solid var(--border);border-radius:var(--shape-full);padding:.35rem 1rem;font-size:.78rem;color:var(--muted);font-weight:500;flex-shrink:0}
@media(min-width:768px){.year-badge{display:inline-flex;align-items:center}}

/* Drawer */
.drawer-scrim{position:fixed;inset:0;background:var(--scrim);opacity:0;pointer-events:none;z-index:200;transition:opacity var(--motion-standard);backdrop-filter:blur(2px)}
.drawer-scrim.open{opacity:1;pointer-events:auto}
.drawer{position:fixed;top:0;left:0;bottom:0;z-index:201;width:min(86vw,320px);background:var(--surface);box-shadow:var(--elev-3);transform:translateX(-105%);transition:transform var(--motion-emphasized);display:flex;flex-direction:column;padding:max(env(safe-area-inset-top),.5rem) 0 max(env(safe-area-inset-bottom),.75rem) 0;border-right:1px solid var(--border)}
.drawer.open{transform:translateX(0)}
.drawer-hdr{display:flex;align-items:center;justify-content:space-between;gap:.5rem;padding:.5rem .75rem .75rem 1rem;border-bottom:1px solid var(--border);margin-bottom:.5rem}
.drawer-brand{font-size:.78rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase;background:linear-gradient(135deg,var(--accent-l),var(--title-grad-end));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.drawer-list{list-style:none;padding:.25rem .5rem;margin:0;overflow-y:auto;-webkit-overflow-scrolling:touch}
.drawer-section-label{font-size:.65rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.12em;padding:.75rem .75rem .25rem}
.drawer-item{position:relative;overflow:hidden;display:flex;align-items:center;gap:.75rem;width:100%;min-height:var(--touch-comfy);padding:.5rem .75rem;border:none;background:transparent;color:var(--text);font:inherit;font-size:.95rem;text-align:left;cursor:pointer;border-radius:var(--shape-full);transition:background var(--motion-fast);-webkit-tap-highlight-color:transparent}
.drawer-item:hover{background:color-mix(in oklab,var(--text) 6%,transparent)}
.drawer-item:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.drawer-item.active{background:color-mix(in oklab,var(--accent) 14%,transparent);color:var(--accent-l);font-weight:600}
.drawer-item.active::before{content:"";position:absolute;left:0;top:50%;transform:translateY(-50%);width:3px;height:60%;background:var(--accent);border-radius:0 var(--shape-xs) var(--shape-xs) 0}
.drawer-dot{width:10px;height:10px;border-radius:50%;background:var(--muted);flex-shrink:0}
.drawer-item[data-status="critical"] .drawer-dot{background:var(--red)}
.drawer-item[data-status="concern"] .drawer-dot{background:var(--amber)}
.drawer-item[data-status="watch"] .drawer-dot{background:var(--accent)}
.drawer-item[data-status="good"] .drawer-dot{background:var(--green)}
.drawer-item[data-status="summary"] .drawer-dot{background:var(--title-grad-end)}
.drawer-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.drawer-grade{font-size:.72rem;color:var(--muted);font-weight:500;flex-shrink:0;letter-spacing:.02em}
.drawer-divider{height:1px;background:var(--border);margin:.4rem .75rem}
.drawer-foot{margin-top:auto;padding:.5rem .75rem .75rem;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:.5rem}
.drawer-foot-meta{font-size:.7rem;color:var(--muted);text-align:center}
.drawer-install{position:relative;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;gap:.5rem;width:100%;min-height:var(--touch-min);padding:.55rem 1rem;background:var(--accent);color:var(--on-accent);border:none;border-radius:var(--shape-full);font:inherit;font-weight:600;font-size:.9rem;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:background var(--motion-fast),box-shadow var(--motion-fast),transform var(--motion-fast);box-shadow:var(--elev-1)}
.drawer-install:hover{background:var(--accent-l);box-shadow:var(--elev-2)}
.drawer-install:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.drawer-install:active{transform:scale(.98)}
.drawer-install svg{width:1.05rem;height:1.05rem;stroke:currentColor;fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
.drawer-install[hidden]{display:none}

/* iOS install instructions modal */
.ios-modal{position:fixed;inset:0;z-index:300;display:none;align-items:flex-end;justify-content:center;background:var(--scrim);padding:1rem;padding-bottom:max(1rem,env(safe-area-inset-bottom))}
.ios-modal.open{display:flex;animation:scrimFade var(--motion-standard)}
.ios-modal-card{background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:var(--shape-xl);max-width:420px;width:100%;padding:1.25rem 1.25rem 1rem;box-shadow:var(--elev-3);animation:cardRise var(--motion-emphasized)}
.ios-modal-hdr{display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem}
.ios-modal-title{font-weight:700;font-size:1.05rem;flex:1}
.ios-modal-close{background:transparent;border:none;color:var(--muted);font-size:1.5rem;cursor:pointer;line-height:1;width:32px;height:32px;border-radius:var(--shape-full)}
.ios-modal-close:hover{background:color-mix(in oklab,var(--text) 8%,transparent);color:var(--text)}
.ios-modal-body{font-size:.92rem;line-height:1.55;color:var(--text)}
.ios-modal-step{display:flex;align-items:flex-start;gap:.65rem;padding:.5rem 0}
.ios-modal-step .num{flex-shrink:0;width:24px;height:24px;border-radius:50%;background:var(--accent);color:var(--on-accent);font-size:.75rem;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:.05rem}
.ios-modal-step .text strong{color:var(--accent-l)}
.ios-modal-share{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border:1.5px solid currentColor;border-radius:5px;color:var(--accent-l);vertical-align:-5px;margin:0 2px}
.ios-modal-share svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
@keyframes scrimFade{from{opacity:0}to{opacity:1}}
@keyframes cardRise{from{transform:translateY(40px);opacity:0}to{transform:translateY(0);opacity:1}}
@media (prefers-reduced-motion: reduce){
  .ios-modal.open,.ios-modal-card{animation:none}
}


/* Body scroll lock when drawer open */
body.drawer-open{overflow:hidden}

/* FAB (Summary jump) */
.fab{position:fixed;bottom:calc(1.25rem + env(safe-area-inset-bottom));right:calc(1.25rem + env(safe-area-inset-right));z-index:90;display:inline-flex;align-items:center;gap:.5rem;height:56px;min-width:56px;padding:0 1.25rem 0 1.1rem;background:var(--accent);color:var(--on-accent);border:none;border-radius:var(--shape-lg);font:inherit;font-size:.95rem;font-weight:600;cursor:pointer;box-shadow:var(--elev-3);transition:transform var(--motion-emphasized),opacity var(--motion-emphasized),background var(--motion-fast),box-shadow var(--motion-fast);-webkit-tap-highlight-color:transparent;overflow:hidden;will-change:transform,opacity}
.fab:hover{background:var(--accent-l);box-shadow:var(--elev-3),0 0 0 8px color-mix(in oklab,var(--accent) 12%,transparent)}
.fab:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.fab:active{transform:scale(.96)}
.fab-icon{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}
.fab-icon svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.fab-label{white-space:nowrap}
/* Hide on Summary panel; on tiny screens collapse to icon-only */
body[data-panel="summary"] .fab{transform:translateY(140%) scale(.6);opacity:0;pointer-events:none}
@media(max-width:520px){
  .fab{padding:0;width:56px;justify-content:center}
  .fab .fab-label{display:none}
}

/* Offline banner (PWA) */
.offline-banner{position:sticky;top:var(--appbar-h);z-index:80;display:flex;align-items:center;gap:.6rem;padding:.55rem .9rem;background:color-mix(in oklab,var(--amber) 18%,var(--surface));color:var(--text);border-bottom:1px solid color-mix(in oklab,var(--amber) 35%,var(--border));box-shadow:var(--elev-1);font-size:.85rem;animation:offlineSlide var(--motion-emphasized)}
.offline-banner[hidden]{display:none}
.offline-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:var(--amber);color:#fff;flex-shrink:0}
.offline-icon svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.offline-text{flex:1;min-width:0}
.offline-text strong{font-weight:600}
.offline-refresh{position:relative;overflow:hidden;background:transparent;border:1px solid color-mix(in oklab,var(--amber) 50%,var(--border));color:var(--text);font:inherit;font-size:.78rem;font-weight:600;padding:.4rem .8rem;border-radius:var(--shape-full);cursor:pointer;flex-shrink:0;-webkit-tap-highlight-color:transparent;transition:background var(--motion-fast)}
.offline-refresh:hover{background:color-mix(in oklab,var(--amber) 16%,transparent)}
.offline-refresh:focus-visible{outline:2px solid var(--amber);outline-offset:2px}
@keyframes offlineSlide{from{transform:translateY(-100%);opacity:0}to{transform:translateY(0);opacity:1}}
@media (prefers-reduced-motion: reduce){
  .offline-banner{animation:none}
}

/* Material 3 click ripple (JS-injected span) */
.ripple{position:absolute;border-radius:50%;background:currentColor;opacity:.28;transform:scale(0);pointer-events:none;animation:rippleAnim var(--motion-emphasized) cubic-bezier(.05,.7,.1,1) forwards;will-change:transform,opacity}
@keyframes rippleAnim{
  0%{transform:scale(0);opacity:.28}
  100%{transform:scale(2.6);opacity:0}
}
@media (prefers-reduced-motion: reduce){
  .ripple{display:none}
  .fab,.icon-btn,.active-chip,.drawer,.drawer-scrim,.appbar{transition:none}
}

/* Main */
main{max-width:1400px;margin:0 auto;padding:2rem}

/* Student header */
.student-hdr{margin-bottom:1.5rem}
.student-hdr h2{font-size:1.5rem;font-weight:700}
.student-hdr p{color:var(--muted);margin-top:.25rem;font-size:.9rem}

/* Section */
.section{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:1.5rem;margin-bottom:1.5rem}
.section-title{font-size:1rem;font-weight:700;color:var(--accent-l);margin-bottom:1.25rem;display:flex;align-items:center;gap:.5rem;text-transform:uppercase;letter-spacing:.05em;font-size:.8rem}
.icon{font-size:1.1rem}

/* Stat grid */
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:.875rem;margin-bottom:1.25rem}
.stat-card{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:1rem;text-align:center}
.stat-num{font-size:2.25rem;font-weight:800;line-height:1}
.stat-num.green{color:var(--green)}.stat-num.amber{color:var(--amber)}.stat-num.red{color:var(--red)}.stat-num.muted{color:var(--muted)}
.stat-lbl{font-size:.7rem;color:var(--muted);margin-top:.4rem;font-weight:500;text-transform:uppercase;letter-spacing:.04em}

/* Chart box */
.chart-box{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:1.25rem}
.chart-box.compact{padding:1rem}.chart-box.flex-grow{flex:1}
.chart-label{font-size:.75rem;font-weight:600;color:var(--muted);margin-bottom:.875rem;text-transform:uppercase;letter-spacing:.04em}

/* Tables */
.tbl-wrap{overflow-x:auto;border-radius:8px;border:1px solid var(--border)}
.tbl{width:100%;border-collapse:collapse;font-size:.85rem}
.tbl th{background:var(--surface2);color:var(--muted);font-weight:600;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;padding:.75rem 1rem;text-align:left;white-space:nowrap;border-bottom:1px solid var(--border)}
.tbl td{padding:.7rem 1rem;border-bottom:1px solid var(--border)}
.tbl tr:last-child td{border-bottom:none}
.tbl tr:hover td{background:var(--surface2)}
.tbl.sm td,.tbl.sm th{padding:.5rem .75rem}
.gc{text-align:center;font-weight:500}.gc.muted{color:var(--muted)}
.overall{font-weight:700}.tchr{color:var(--muted);font-size:.8rem}.per{color:var(--muted);font-size:.78rem;font-weight:600}
.subj{font-weight:500}
.ctr{text-align:center}.red-txt{color:var(--red);font-weight:600}
.tag{display:inline-block;background:var(--surface3);border-radius:4px;padding:.1rem .45rem;font-size:.72rem;color:var(--muted);margin:.1rem}
.comments{max-width:260px}

/* Assignments */
.asgn-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1rem}
.asgn-card{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:1rem}
.asgn-subj{font-size:.8rem;font-weight:700;color:var(--accent-l);margin-bottom:.75rem;text-transform:uppercase;letter-spacing:.04em}
.asgn-row{display:flex;align-items:center;justify-content:space-between;gap:.5rem;padding:.35rem 0;border-bottom:1px solid var(--border);font-size:.83rem}
.asgn-row:last-child{border-bottom:none}
.asgn-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.asgn-score{flex-shrink:0;font-size:.8rem}

/* Homework */
.alert-box{border-radius:8px;padding:1rem 1.25rem;margin-bottom:1.25rem}
.alert-box.danger{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3)}
.alert-title{font-weight:700;color:var(--red);margin-bottom:.5rem;font-size:.9rem}
.alert-row{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem;padding:.2rem 0;font-size:.85rem}
.hw-block{margin-bottom:1rem}
.hw-head{font-size:.78rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.5rem}
.hw-item{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem;padding:.45rem .75rem;background:var(--surface2);border-radius:6px;margin-bottom:.3rem;font-size:.875rem}
.hw-item.tonight{background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.25)}
.hw-empty{color:var(--muted);font-size:.85rem;font-style:italic;padding:.3rem 0}
.pill{display:inline-block;background:var(--surface3);border-radius:4px;padding:.1rem .5rem;font-size:.72rem;font-weight:700;color:var(--accent-l);flex-shrink:0}
.due{font-size:.75rem;color:var(--amber);margin-left:auto;flex-shrink:0}
.date-lbl{font-size:.75rem;color:var(--muted);flex-shrink:0}

/* Attendance */
.att-layout{display:grid;grid-template-columns:1fr 280px;gap:1.5rem;align-items:start}
.att-stats{display:grid;grid-template-columns:repeat(2,1fr);gap:.875rem}
.att-card{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:1rem;text-align:center}
.att-card.red-card{border-color:rgba(239,68,68,.4)}
.att-card.amber-card{border-color:rgba(245,158,11,.4)}
.att-card.red-card .att-num{color:var(--red)}
.att-card.amber-card .att-num{color:var(--amber)}
.att-num{font-size:1.75rem;font-weight:800}.att-num.small{font-size:1.1rem;line-height:1.4}
.att-lbl{font-size:.72rem;font-weight:600;color:var(--muted);margin-top:.25rem;text-transform:uppercase;letter-spacing:.04em}
.att-sub{font-size:.68rem;color:var(--muted);margin-top:.2rem}

/* Demerits */
.dem-header{display:flex;gap:1.5rem;align-items:flex-start;flex-wrap:wrap}
.dem-total{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:1.25rem 2rem;text-align:center;flex-shrink:0}
.dem-total.red-card{border-color:rgba(239,68,68,.4)}.dem-total.red-card .att-num{color:var(--red)}
.dem-total.amber-card{border-color:rgba(245,158,11,.4)}.dem-total.amber-card .att-num{color:var(--amber)}

/* Emails */
.email-list{display:flex;flex-direction:column;gap:.75rem}
.email-card{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:1rem}
.email-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:.4rem}
.email-from{font-weight:600;font-size:.9rem}
.email-date{font-size:.78rem;color:var(--muted)}
.email-subj{font-weight:500;color:var(--accent-l);margin-bottom:.4rem;font-size:.9rem}
.email-body{font-size:.83rem;color:var(--muted);line-height:1.65;white-space:pre-wrap;max-height:200px;overflow:hidden}

/* Status banner */
.status-banner{display:flex;align-items:center;gap:1.25rem;padding:1.25rem 1.5rem;border-radius:var(--r);margin-bottom:1.5rem;border:1px solid;border-left-width:4px}
.status-banner.critical{background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.3);border-left-color:var(--red)}
.status-banner.concern{background:rgba(245,158,11,.1);border-color:rgba(245,158,11,.3);border-left-color:var(--amber)}
.status-banner.watch{background:rgba(99,102,241,.08);border-color:rgba(99,102,241,.25);border-left-color:var(--accent)}
.status-banner.good{background:rgba(34,197,94,.08);border-color:rgba(34,197,94,.25);border-left-color:var(--green)}
.status-icon{font-size:1.75rem;line-height:1;flex-shrink:0}
.status-text{flex:1;min-width:0}
.status-title{font-weight:700;font-size:1.05rem;margin-bottom:.2rem}
.status-msg{color:var(--muted);font-size:.88rem;line-height:1.5}

/* Priority items */
.priority-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:.75rem}
.priority-item{display:flex;align-items:flex-start;gap:.75rem;padding:.875rem 1rem;background:var(--surface2);border:1px solid var(--border);border-radius:8px;border-left:3px solid var(--muted)}
.priority-item.urgent{border-left-color:var(--red);background:rgba(239,68,68,.06)}
.priority-item.tonight{border-left-color:var(--accent);background:rgba(99,102,241,.06)}
.priority-item.week{border-left-color:var(--blue);background:rgba(59,130,246,.06)}
.priority-item.watch{border-left-color:var(--amber);background:rgba(245,158,11,.06)}
.priority-icon{font-size:1.3rem;flex-shrink:0;line-height:1.2}
.priority-body{flex:1;min-width:0}
.priority-chip{display:inline-block;font-size:.62rem;font-weight:800;padding:.15rem .5rem;border-radius:4px;background:var(--surface3);color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.35rem}
.priority-chip.urgent{background:var(--red);color:#fff}
.priority-chip.tonight{background:var(--accent);color:#fff}
.priority-chip.week{background:var(--blue);color:#fff}
.priority-chip.watch{background:var(--amber);color:#fff}
.priority-title{font-weight:600;font-size:.9rem;margin-bottom:.25rem;line-height:1.3}
.priority-detail{color:var(--muted);font-size:.8rem;line-height:1.45}
.priority-meta{font-size:.7rem;color:var(--muted);margin-top:.3rem;font-style:italic}
.no-priorities{padding:1.25rem;text-align:center;color:var(--green);background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.2);border-radius:8px;font-size:.95rem;font-weight:500}

/* Trend pill */
.trend{display:inline-block;font-size:.7rem;font-weight:700;padding:.15rem .5rem;border-radius:4px;white-space:nowrap}
.trend.up{background:rgba(34,197,94,.15);color:var(--green)}
.trend.down{background:rgba(239,68,68,.15);color:var(--red)}
.trend.warn{background:rgba(245,158,11,.15);color:var(--amber)}
.trend.flat{background:var(--surface3);color:var(--muted)}

/* Teacher comment quotes */
.tcomment-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:1rem}
.tcomment{background:var(--surface2);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;padding:1rem 1.25rem}
.tcomment-quote{font-style:italic;color:var(--text);line-height:1.65;font-size:.9rem;margin-bottom:.6rem}
.tcomment-quote::before{content:'\\201C';color:var(--accent-l);font-size:1.5rem;vertical-align:-.3rem;margin-right:.15rem}
.tcomment-quote::after{content:'\\201D';color:var(--accent-l);font-size:1.5rem;vertical-align:-.3rem;margin-left:.15rem}
.tcomment-attr{font-size:.78rem;color:var(--muted);font-weight:500}
.tcomment-attr strong{color:var(--accent-l)}

/* Overall summary */
.overall-summary{background:linear-gradient(135deg,var(--header-from) 0%,var(--surface) 100%);border:1px solid var(--border);border-radius:var(--r);padding:1.75rem;margin-bottom:1.5rem}
.overall-header{display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:1rem;margin-bottom:1.5rem;padding-bottom:1.25rem;border-bottom:1px solid var(--border)}
.overall-title{font-size:1.35rem;font-weight:800;background:linear-gradient(135deg,var(--accent-l),var(--title-grad-end));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.overall-sub{color:var(--muted);font-size:.85rem;margin-top:.25rem}
.overall-counts{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.count-pill{display:inline-flex;align-items:center;font-size:.75rem;font-weight:700;padding:.4rem .75rem;border-radius:999px;text-transform:uppercase;letter-spacing:.04em}
.count-pill.urgent{background:var(--red);color:#fff}
.count-pill.tonight{background:var(--accent);color:#fff}
.count-pill.week{background:var(--blue);color:#fff}
.count-pill.watch{background:var(--amber);color:#fff}
.count-pill.good{background:var(--green);color:#fff}

.summary-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem}
.summary-card{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:1.1rem 1.2rem;display:flex;flex-direction:column;gap:.85rem;border-top:3px solid var(--muted)}
.summary-card.status-critical{border-top-color:var(--red)}
.summary-card.status-concern{border-top-color:var(--amber)}
.summary-card.status-watch{border-top-color:var(--accent)}
.summary-card.status-good{border-top-color:var(--green)}
.summary-card-hdr{display:flex;align-items:center;gap:.75rem}
.summary-icon{font-size:1.6rem;line-height:1;flex-shrink:0}
.summary-name{flex:1;min-width:0}
.summary-fname{font-size:1.1rem;font-weight:700;line-height:1.2}
.summary-stat{font-size:.72rem;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-top:.15rem}
.summary-items{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.45rem}
.summary-li{display:flex;align-items:flex-start;gap:.55rem;font-size:.83rem;line-height:1.35}
.summary-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:.45rem;background:var(--muted)}
.summary-dot.urgent{background:var(--red)}
.summary-dot.tonight{background:var(--accent)}
.summary-dot.week{background:var(--blue)}
.summary-dot.watch{background:var(--amber)}
.summary-li-text{flex:1;min-width:0}
.summary-more{font-size:.72rem;color:var(--muted);font-style:italic;margin-top:-.15rem}
.summary-good{color:var(--green);font-size:.88rem;font-weight:500;padding:.4rem 0}
.summary-jump{position:relative;overflow:hidden;margin-top:auto;background:transparent;border:1px solid var(--border);color:var(--accent-l);font-size:.85rem;font-weight:600;padding:.65rem 1rem;min-height:var(--touch-min);border-radius:var(--shape-full);cursor:pointer;font-family:inherit;transition:background var(--motion-fast),color var(--motion-fast),border-color var(--motion-fast),box-shadow var(--motion-fast);text-align:center;-webkit-tap-highlight-color:transparent;display:inline-flex;align-items:center;justify-content:center;gap:.4rem}
.summary-jump:hover{background:var(--accent);color:var(--on-accent);border-color:var(--accent);box-shadow:var(--elev-1)}
.summary-jump:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.summary-jump:active{transform:scale(.98)}

/* AI insight (panel-top, per student) */
.ai-insight{position:relative;background:linear-gradient(135deg,var(--surface2) 0%,var(--surface) 100%);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:var(--r);padding:1.25rem 1.5rem;margin-bottom:1.5rem;overflow:hidden}
.ai-insight::before{content:"";position:absolute;inset:0;background:radial-gradient(120% 80% at 0% 0%,rgba(99,102,241,.07),transparent 60%);pointer-events:none}
.ai-insight-hdr{display:flex;align-items:center;gap:.55rem;margin-bottom:.65rem;position:relative}
.ai-insight-icon{font-size:1.15rem;line-height:1}
.ai-insight-label{font-size:.78rem;font-weight:700;color:var(--accent-l);text-transform:uppercase;letter-spacing:.05em}
.ai-insight-tag{margin-left:auto;font-size:.62rem;font-weight:800;padding:.2rem .55rem;border-radius:999px;background:var(--accent);color:#fff;letter-spacing:.06em}
.ai-insight-body{font-size:.95rem;line-height:1.7;color:var(--text);margin:0;position:relative;min-height:1.7em;white-space:pre-wrap}
.ai-insight-body + .ai-insight-body{margin-top:.65rem}
.ai-insight-body.typing{cursor:pointer}
.ai-insight-body.typing::after{content:"";display:inline-block;width:.45em;height:1em;margin-left:1px;background:var(--accent);vertical-align:text-bottom;border-radius:1px;animation:caret-blink 1.05s steps(2) infinite;will-change:opacity}
.ai-insight.family .ai-insight-body.typing::after{background:var(--title-grad-end)}
@keyframes caret-blink{to{opacity:0}}
@media (prefers-reduced-motion: reduce){
  .ai-insight-body.typing::after{animation:none;opacity:.55}
}

/* Family-scope variant (Summary tab) */
.ai-insight.family{margin-bottom:1.5rem;border-left-width:4px;border-left-color:var(--title-grad-end);background:linear-gradient(135deg,var(--surface) 0%,var(--surface2) 100%)}
.ai-insight.family::before{background:radial-gradient(140% 90% at 0% 0%,rgba(124,58,237,.09),transparent 60%)}
.ai-insight.family .ai-insight-label{color:var(--title-grad-end)}
.ai-insight.family .ai-insight-tag{background:var(--title-grad-end)}
.ai-insight.family .ai-insight-body{font-size:1rem;line-height:1.75}

/* Misc */
.empty-state{color:var(--muted);font-style:italic;font-size:.875rem;padding:.5rem 0}

footer{text-align:center;padding:2rem;color:var(--muted);font-size:.78rem;border-top:1px solid var(--border);margin-top:1rem}

/* ===== Responsive (mobile-first refinement) ===== */

/* Default (mobile <=480px): single column, max density */
.summary-grid{grid-template-columns:1fr}
.stat-grid{grid-template-columns:repeat(2,1fr);gap:.625rem}
.priority-list{grid-template-columns:1fr}
.asgn-grid{grid-template-columns:1fr}
.tcomment-grid{grid-template-columns:1fr}
.att-layout{grid-template-columns:1fr;gap:1rem}
.att-stats{grid-template-columns:repeat(2,1fr);gap:.625rem}
main{padding:1rem}
.section{padding:1rem;border-radius:var(--shape-md);margin-bottom:1rem}
.section-title{margin-bottom:.875rem}
.overall-summary{padding:1.1rem;border-radius:var(--shape-md);margin-bottom:1rem}
.overall-header{margin-bottom:1rem;padding-bottom:.875rem}
.overall-title{font-size:1.15rem}
.appbar-bigtitle{padding:.25rem 1rem 1rem}
.appbar-bigtitle .big{font-size:1.35rem}
.ai-insight{padding:1rem 1.1rem;border-radius:var(--shape-md)}
.summary-card{border-radius:var(--shape-md)}
.stat-num{font-size:1.85rem}
.dem-total{padding:1rem 1.5rem}
.priority-list{gap:.5rem}

/* Phone landscape / small tablet (>=480px) */
@media(min-width:481px){
  .stat-grid{grid-template-columns:repeat(3,1fr);gap:.75rem}
  .att-stats{grid-template-columns:repeat(4,1fr)}
  .stat-num{font-size:2rem}
}

/* Tablet (>=600px) */
@media(min-width:600px){
  .summary-grid{grid-template-columns:repeat(2,1fr);gap:1rem}
  .priority-list{grid-template-columns:repeat(2,1fr);gap:.75rem}
  .asgn-grid{grid-template-columns:repeat(2,1fr);gap:1rem}
}

/* Tablet wide (>=768px) */
@media(min-width:768px){
  main{padding:1.5rem}
  .section{padding:1.25rem;border-radius:var(--shape-md);margin-bottom:1.25rem}
  .overall-summary{padding:1.5rem;border-radius:var(--shape-md);margin-bottom:1.25rem}
  .overall-title{font-size:1.3rem}
  .appbar-bigtitle .big{font-size:1.55rem}
  .stat-grid{grid-template-columns:repeat(4,1fr);gap:.875rem}
  .stat-num{font-size:2.15rem}
  .tcomment-grid{grid-template-columns:repeat(auto-fill,minmax(340px,1fr))}
}

/* Desktop (>=1024px) */
@media(min-width:1024px){
  main{padding:2rem}
  .section{padding:1.5rem}
  .overall-summary{padding:1.75rem;margin-bottom:1.5rem}
  .overall-title{font-size:1.35rem}
  .appbar-bigtitle .big{font-size:1.65rem}
  .summary-grid{grid-template-columns:repeat(4,1fr)}
  .priority-list{grid-template-columns:repeat(3,1fr)}
  .asgn-grid{grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
  .stat-grid{grid-template-columns:repeat(auto-fill,minmax(120px,1fr))}
  .att-layout{grid-template-columns:1fr 280px;gap:1.5rem}
  .stat-num{font-size:2.25rem}
}

/* Wide desktop title scale-up */
@media(min-width:1280px){
  .appbar-bigtitle .big{font-size:1.8rem}
}
</style>
</head>
<body data-panel="summary">
<header class="appbar">
  <div class="appbar-row">
    <button class="icon-btn" type="button" id="navBtn" onclick="toggleDrawer()" aria-label="Open navigation menu" aria-controls="drawer" aria-expanded="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>
    </button>
    <button class="active-chip" id="activeChip" type="button" onclick="toggleDrawer()" aria-label="Switch student" aria-controls="drawer" data-status="summary">
      <span class="chip-dot" aria-hidden="true"></span>
      <span class="chip-label">Summary</span>
      <svg class="chip-caret" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div class="appbar-spacer"></div>
    <span class="year-badge">${esc(currentYear)}</span>
    <button class="icon-btn theme-toggle" type="button" onclick="toggleTheme()" aria-label="Toggle light or dark mode" title="Toggle light/dark">
      <span class="icon-dark" aria-hidden="true">🌙</span>
      <span class="icon-light" aria-hidden="true">☀️</span>
    </button>
  </div>
  <div class="appbar-bigtitle">
    <div class="big">Gradicus Daily Report</div>
    <div class="sub">${esc(reportDate)}</div>
  </div>
</header>

<aside class="drawer" id="drawer" role="dialog" aria-modal="true" aria-label="Navigation" tabindex="-1">
  <div class="drawer-hdr">
    <div class="drawer-brand">Gradicus</div>
    <button class="icon-btn" type="button" onclick="closeDrawer()" aria-label="Close navigation menu">
      <svg viewBox="0 0 24 24" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>
    </button>
  </div>
  <div class="drawer-section-label">Overview</div>
  <ul class="drawer-list" role="menu">
    <li role="none">
      <button class="drawer-item active" type="button" role="menuitem" data-target="summary" data-status="summary" onclick="show('summary'); closeDrawer()">
        <span class="drawer-dot" aria-hidden="true"></span>
        <span class="drawer-name">Summary</span>
        <span class="drawer-grade">All</span>
      </button>
    </li>
  </ul>
  <div class="drawer-divider"></div>
  <div class="drawer-section-label">Students</div>
  <ul class="drawer-list" role="menu">
    ${data.map((s, i) => `<li role="none">
      <button class="drawer-item" type="button" role="menuitem" data-target="${i}" data-status="${esc(s.status.level)}" onclick="show(${i}); closeDrawer()">
        <span class="drawer-dot" aria-hidden="true"></span>
        <span class="drawer-name">${esc(s.name.split(' ')[0])}</span>
        <span class="drawer-grade">${esc(s.gradeLevel || '')}</span>
      </button>
    </li>`).join('')}
  </ul>
  <div class="drawer-foot">
    <button id="installBtn" class="drawer-install" type="button" hidden onclick="triggerInstall()">
      <svg viewBox="0 0 24 24" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="17"/><polyline points="6 11 12 17 18 11"/><line x1="5" y1="20" x2="19" y2="20"/></svg>
      <span class="install-label">Install app</span>
    </button>
    <div class="drawer-foot-meta">${esc(currentYear)} · Updated ${esc(reportDate)}</div>
  </div>
</aside>

<div class="ios-modal" id="iosInstall" role="dialog" aria-modal="true" aria-labelledby="iosInstallTitle" onclick="if(event.target===this)closeIOSInstall()">
  <div class="ios-modal-card" role="document">
    <div class="ios-modal-hdr">
      <div class="ios-modal-title" id="iosInstallTitle">Add to Home Screen</div>
      <button class="ios-modal-close" type="button" aria-label="Close" onclick="closeIOSInstall()">&times;</button>
    </div>
    <div class="ios-modal-body">
      <p style="margin:0 0 .5rem">Install <strong>Gradicus</strong> on your home screen for one-tap access:</p>
      <div class="ios-modal-step"><span class="num">1</span><span class="text">Tap the <span class="ios-modal-share" aria-label="Share"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="8 7 12 3 16 7"/><line x1="12" y1="3" x2="12" y2="14"/><path d="M5 12 v7 a2 2 0 0 0 2 2 h10 a2 2 0 0 0 2 -2 v-7"/></svg></span> <strong>Share</strong> button at the bottom of Safari.</span></div>
      <div class="ios-modal-step"><span class="num">2</span><span class="text">Scroll and tap <strong>Add to Home Screen</strong>.</span></div>
      <div class="ios-modal-step"><span class="num">3</span><span class="text">Tap <strong>Add</strong> in the top-right.</span></div>
    </div>
  </div>
</div>
<div class="drawer-scrim" id="drawerScrim" onclick="closeDrawer()"></div>

<div id="offlineBanner" class="offline-banner" role="status" aria-live="polite" hidden>
  <span class="offline-icon" aria-hidden="true">
    <svg viewBox="0 0 24 24"><path d="M2 9 a14 14 0 0 1 20 0"/><path d="M5.5 12.5 a9 9 0 0 1 13 0"/><path d="M9 16 a4 4 0 0 1 6 0"/><circle cx="12" cy="19.5" r="1.2" fill="currentColor" stroke="none"/><line x1="3" y1="3" x2="21" y2="21"/></svg>
  </span>
  <span class="offline-text">Showing cached report from <strong id="offlineDate">earlier</strong></span>
  <button class="offline-refresh" type="button" onclick="location.reload()">Retry</button>
</div>

<main>
  <div class="panel" id="panelSummary">
    ${renderOverallSummary(data, familyInsight)}
  </div>
  ${data.map((s, i) => renderPanel(s, i)).join('')}
</main>

<button class="fab" id="summaryFab" type="button" onclick="show('summary')" aria-label="Back to Summary">
  <span class="fab-icon" aria-hidden="true">
    <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
  </span>
  <span class="fab-label">Summary</span>
</button>

<footer>Generated ${esc(generated)} · Gradicus MCP Report · ${esc(currentYear)}</footer>

<script>
const CD = ${JSON.stringify(chartData)};
const charts = {};

function applyChartTheme() {
  const cs = getComputedStyle(document.documentElement);
  Chart.defaults.color = cs.getPropertyValue('--muted').trim() || '#64748b';
  Chart.defaults.borderColor = cs.getPropertyValue('--chart-grid').trim() || 'rgba(255,255,255,0.06)';
}
applyChartTheme();

function toggleTheme() {
  let cur = document.documentElement.getAttribute('data-theme');
  if (!cur) cur = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('gradicus-theme', next); } catch (e) {}
  applyChartTheme();
  Object.values(charts).forEach(c => { if (c) c.update(); });
}

// React when the OS theme changes (only if user hasn't pinned a choice)
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!document.documentElement.getAttribute('data-theme')) {
    applyChartTheme();
    Object.values(charts).forEach(c => { if (c) c.update(); });
  }
});

function gradeColor(p) {
  if (p == null) return '#64748b';
  if (p >= 90) return '#22c55e';
  if (p >= 80) return '#3b82f6';
  if (p >= 70) return '#f59e0b';
  if (p >= 60) return '#f97316';
  return '#ef4444';
}

function initCharts(i) {
  const d = CD[i];

  // Grade bar chart
  const gc = document.getElementById('gc' + i);
  if (gc && !charts['gc' + i]) {
    charts['gc' + i] = new Chart(gc, {
      type: 'bar',
      data: {
        labels: d.gradeChart.labels,
        datasets: [{
          data: d.gradeChart.data,
          backgroundColor: d.gradeChart.colors.map(c => c + '55'),
          borderColor: d.gradeChart.colors,
          borderWidth: 2,
          borderRadius: 6,
          borderSkipped: false,
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => ctx.raw != null ? ctx.raw + '%' : 'N/A' } }
        },
        scales: {
          y: { min: 0, max: 100, ticks: { callback: v => v + '%', stepSize: 20 } },
          x: { ticks: { maxRotation: 25, font: { size: 11 } } }
        }
      }
    });
  }

  // Attendance donut
  const ac = document.getElementById('ac' + i);
  if (ac && !charts['ac' + i]) {
    const ad = d.attendanceChart;
    const nz = ad.labels.map((l, j) => ({ l, v: ad.data[j], c: ad.colors[j] })).filter(x => x.v > 0);
    if (nz.length > 0) {
      charts['ac' + i] = new Chart(ac, {
        type: 'doughnut',
        data: {
          labels: nz.map(x => x.l),
          datasets: [{ data: nz.map(x => x.v), backgroundColor: nz.map(x => x.c + 'cc'), borderColor: nz.map(x => x.c), borderWidth: 2 }]
        },
        options: { responsive: true, cutout: '62%', plugins: { legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 12 } } } }
      });
    } else {
      ac.parentElement.innerHTML = '<p style="color:#22c55e;font-size:.9rem;text-align:center;padding:2rem 0">✓ Perfect Attendance</p>';
    }
  }

  // Demerit bar
  const dc = document.getElementById('dc' + i);
  if (dc && !charts['dc' + i] && d.demeritChart.labels && d.demeritChart.labels.length) {
    charts['dc' + i] = new Chart(dc, {
      type: 'bar',
      data: {
        labels: d.demeritChart.labels,
        datasets: [{
          label: 'Demerits',
          data: d.demeritChart.data,
          backgroundColor: '#ef444455',
          borderColor: '#ef4444',
          borderWidth: 2,
          borderRadius: 4,
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: { y: { min: 0, ticks: { stepSize: 1 } }, x: { ticks: { font: { size: 11 } } } }
      }
    });
  }
}

// --- Student metadata for chip + drawer (kept in sync with renderPanel data) ---
const STUDENTS = ${JSON.stringify(data.map(s => ({
  name: s.name.split(' ')[0],
  grade: s.gradeLevel || '',
  status: s.status.level,
  statusTitle: s.status.title,
})))};

function show(target) {
  const panels = document.querySelectorAll('.panel');
  panels.forEach(p => { p.hidden = true; });
  const isSummary = target === 'summary';
  const panel = isSummary
    ? document.getElementById('panelSummary')
    : document.getElementById('panel' + target);
  if (panel) panel.hidden = false;

  // Mark which panel is active (drives FAB visibility, chip label, drawer highlight)
  document.body.dataset.panel = isSummary ? 'summary' : String(target);
  updateChip(target);
  updateDrawerActive(target);

  if (!isSummary) initCharts(Number(target));
  if (panel) typeInsightsInPanel(panel);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function jumpTo(i) { show(i); }

function updateChip(target) {
  const chip = document.getElementById('activeChip');
  if (!chip) return;
  const label = chip.querySelector('.chip-label');
  if (target === 'summary') {
    chip.dataset.status = 'summary';
    chip.setAttribute('aria-label', 'Switch student (currently viewing Summary)');
    if (label) label.textContent = 'Summary';
  } else {
    const s = STUDENTS[Number(target)];
    if (!s) return;
    chip.dataset.status = s.status;
    chip.setAttribute('aria-label', \`Switch student (currently viewing \${s.name})\`);
    if (label) label.textContent = s.name;
  }
}

function updateDrawerActive(target) {
  const items = document.querySelectorAll('.drawer-item');
  const targetStr = String(target);
  items.forEach(it => {
    const t = it.dataset.target;
    const isActive = t === targetStr;
    it.classList.toggle('active', isActive);
    if (isActive) it.setAttribute('aria-current', 'page');
    else it.removeAttribute('aria-current');
  });
}

// --- Drawer ---

let drawerLastFocus = null;

function openDrawer() {
  const d = document.getElementById('drawer');
  const s = document.getElementById('drawerScrim');
  const btn = document.getElementById('navBtn');
  if (!d || !s) return;
  drawerLastFocus = document.activeElement;
  d.classList.add('open');
  s.classList.add('open');
  document.body.classList.add('drawer-open');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  // Move focus to the active drawer item (or first item)
  const active = d.querySelector('.drawer-item.active') || d.querySelector('.drawer-item');
  if (active) active.focus({ preventScroll: true });
}

function closeDrawer() {
  const d = document.getElementById('drawer');
  const s = document.getElementById('drawerScrim');
  const btn = document.getElementById('navBtn');
  if (!d || !s) return;
  d.classList.remove('open');
  s.classList.remove('open');
  document.body.classList.remove('drawer-open');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  // Restore focus
  if (drawerLastFocus && drawerLastFocus.focus) {
    try { drawerLastFocus.focus({ preventScroll: true }); } catch (e) {}
  }
  drawerLastFocus = null;
}

function toggleDrawer() {
  const d = document.getElementById('drawer');
  if (!d) return;
  if (d.classList.contains('open')) closeDrawer();
  else openDrawer();
}

// Escape closes the drawer; Tab traps focus inside it while open
document.addEventListener('keydown', (e) => {
  const d = document.getElementById('drawer');
  if (!d || !d.classList.contains('open')) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeDrawer();
    return;
  }
  if (e.key === 'Tab') {
    const focusables = d.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])');
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  }
});

// --- Sticky app bar scroll-state ---

let _scrollRaf = 0;
function onScroll() {
  if (_scrollRaf) return;
  _scrollRaf = requestAnimationFrame(() => {
    _scrollRaf = 0;
    const scrolled = window.scrollY > 8;
    const html = document.documentElement;
    if (scrolled !== (html.dataset.scrolled === 'true')) {
      html.dataset.scrolled = scrolled ? 'true' : 'false';
    }
  });
}
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

// --- Material 3 click ripple ---

function spawnRipple(e) {
  const target = e.currentTarget;
  if (!target) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const rect = target.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const x = (e.clientX != null ? e.clientX - rect.left : rect.width / 2) - size / 2;
  const y = (e.clientY != null ? e.clientY - rect.top : rect.height / 2) - size / 2;
  const span = document.createElement('span');
  span.className = 'ripple';
  span.style.width = span.style.height = size + 'px';
  span.style.left = x + 'px';
  span.style.top = y + 'px';
  target.appendChild(span);
  span.addEventListener('animationend', () => span.remove(), { once: true });
}

document.querySelectorAll('.fab, .drawer-item, .icon-btn, .active-chip, .summary-jump').forEach(el => {
  el.addEventListener('click', spawnRipple);
});

// --- ChatGPT-style streaming for AI insights ---
//
// Three-layer pipeline:
//   1. SOURCE: capture rendered text into data-text (progressive enhancement —
//      no-JS users see the full insight in the DOM at load time).
//   2. CHUNKER: split text into variable-sized 2-6 char chunks that prefer to
//      end at whitespace boundaries, mimicking token streaming.
//   3. RENDERER: append chunks to a persistent Text node (no re-rendering of
//      previously rendered text), with naturally irregular pacing and longer
//      pauses at commas, sentence-ends, em-dashes, and between paragraphs.
//
// All knobs are on the TYPING config object below.

const TYPING = {
  baseChunkDelayMs: 28,         // mean delay between chunks
  delayJitterMs: 18,            // +/- random jitter
  chunkMin: 2,                  // smallest chunk in chars
  chunkMax: 6,                  // largest chunk in chars
  wordBoundarySnap: 3,          // extend chunk up to N chars to land on whitespace
  commaPauseMultiplier: 4.5,    // x base for ,;:
  sentencePauseMultiplier: 9,   // x base for .!?
  emDashPauseMultiplier: 3,     // x base for em-dash
  paragraphPauseMs: 380,        // pause between paragraph elements
  cursor: true,                 // show blinking caret while streaming
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
};

const PUNCT_SENT = new Set(['.', '!', '?']);
const PUNCT_SOFT = new Set([',', ';', ':']);
const EM_DASH = '\u2014';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Layer 1: source ---

function setupInsightTyping() {
  document.querySelectorAll('.ai-insight-body').forEach(el => {
    const text = el.textContent.trim();
    if (!text) return;
    el.dataset.text = text;
    el.dataset.typed = 'false';
    el.textContent = '';
    // Persistent text node — append-only updates so existing chars are never re-rendered
    el._streamNode = document.createTextNode('');
    el.appendChild(el._streamNode);
  });
}

// --- Layer 2: chunker ---

function chunkText(text, cfg) {
  const chunks = [];
  const len = text.length;
  let i = 0;
  while (i < len) {
    const target = cfg.chunkMin + Math.floor(Math.random() * (cfg.chunkMax - cfg.chunkMin + 1));
    let end = Math.min(i + target, len);
    // Snap to whitespace boundary if it's within wordBoundarySnap chars,
    // so chunks tend to end at natural token boundaries instead of mid-word.
    if (end < len && cfg.wordBoundarySnap > 0) {
      let look = end;
      while (look < len && (look - end) < cfg.wordBoundarySnap && !/\s/.test(text[look])) {
        look++;
      }
      if (look < len && /\s/.test(text[look])) end = look + 1;
    }
    chunks.push(text.substring(i, end));
    i = end;
  }
  return chunks;
}

function chunkDelay(chunk, cfg) {
  // Symmetric jitter: avoid perfectly uniform timing.
  let delay = cfg.baseChunkDelayMs + (Math.random() * 2 - 1) * cfg.delayJitterMs;
  if (delay < 8) delay = 8;
  // Detect punctuation pauses by looking at the last non-whitespace char,
  // so a chunk like "world! " still triggers a sentence pause.
  let k = chunk.length - 1;
  while (k >= 0 && /\s/.test(chunk[k])) k--;
  if (k < 0) return delay;
  const last = chunk[k];
  if (PUNCT_SENT.has(last)) delay *= cfg.sentencePauseMultiplier;
  else if (PUNCT_SOFT.has(last)) delay *= cfg.commaPauseMultiplier;
  else if (last === EM_DASH) delay *= cfg.emDashPauseMultiplier;
  return delay;
}

// --- Layer 3: renderer ---

function streamInsight(el) {
  return new Promise(resolve => {
    const text = el.dataset.text || '';
    if (!text || el.dataset.typed === 'true') { resolve(); return; }

    // Reduced-motion or cursor disabled: instant reveal, no animation.
    if (TYPING.reducedMotion) {
      el._streamNode.nodeValue = text;
      el.dataset.typed = 'true';
      resolve();
      return;
    }

    if (TYPING.cursor) el.classList.add('typing');
    let cancelled = false;

    function complete() {
      if (cancelled) return;
      cancelled = true;
      el._streamNode.nodeValue = text;
      el.dataset.typed = 'true';
      el.classList.remove('typing');
      el.removeEventListener('click', skip);
      resolve();
    }
    function skip() { complete(); }
    el.addEventListener('click', skip);

    const chunks = chunkText(text, TYPING);
    let i = 0;
    function emitNext() {
      if (cancelled) return;
      if (i >= chunks.length) { complete(); return; }
      const chunk = chunks[i++];
      // Append-only: the existing nodeValue prefix is untouched; only the new chars are added.
      el._streamNode.nodeValue += chunk;
      setTimeout(emitNext, chunkDelay(chunk, TYPING));
    }
    emitNext();
  });
}

function typeInsightsInPanel(panel) {
  if (!panel) return;
  const bodies = panel.querySelectorAll('.ai-insight-body[data-typed="false"]');
  if (bodies.length === 0) return;
  // Stream paragraphs sequentially with a paragraph-level pause between them.
  let chain = Promise.resolve();
  bodies.forEach((el, idx) => {
    chain = chain.then(() => streamInsight(el));
    if (idx < bodies.length - 1 && !TYPING.reducedMotion) {
      chain = chain.then(() => sleep(TYPING.paragraphPauseMs));
    }
  });
}

// Wire it up: capture text, then start streaming the visible (Summary) panel.
setupInsightTyping();
typeInsightsInPanel(document.getElementById('panelSummary'));

// --- PWA: service worker registration ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('SW registration failed:', err);
    });
  });
}

// --- PWA: offline banner ---
(function setupOfflineBanner() {
  const banner = document.getElementById('offlineBanner');
  const dateEl = document.getElementById('offlineDate');
  if (!banner) return;
  // Pull the report's friendly date from the meta we injected at generate time
  const metaDate = document.querySelector('meta[name="report-date"]');
  if (dateEl && metaDate && metaDate.content) {
    dateEl.textContent = metaDate.content;
  }
  function update() {
    banner.hidden = navigator.onLine;
  }
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
})();

// --- PWA: install button (Android/Chrome/Edge native + iOS instructions) ---
let _deferredPrompt = null;
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || navigator.standalone === true;
}
function showInstallBtn(label) {
  const btn = document.getElementById('installBtn');
  if (!btn) return;
  btn.hidden = false;
  const lbl = btn.querySelector('.install-label');
  if (lbl && label) lbl.textContent = label;
}
function hideInstallBtn() {
  const btn = document.getElementById('installBtn');
  if (btn) btn.hidden = true;
}
function triggerInstall() {
  if (_deferredPrompt) {
    _deferredPrompt.prompt();
    _deferredPrompt.userChoice.finally(() => {
      _deferredPrompt = null;
      hideInstallBtn();
    });
  } else if (isIOS()) {
    openIOSInstall();
  }
}
function openIOSInstall() {
  const m = document.getElementById('iosInstall');
  if (m) m.classList.add('open');
}
function closeIOSInstall() {
  const m = document.getElementById('iosInstall');
  if (m) m.classList.remove('open');
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredPrompt = e;
  showInstallBtn('Install app');
});
window.addEventListener('appinstalled', () => {
  _deferredPrompt = null;
  hideInstallBtn();
});
// Show iOS install hint when running in Safari (no beforeinstallprompt) and not already added
(function maybeShowIOSInstall() {
  if (isStandalone()) return;
  if (isIOS()) showInstallBtn('Add to Home Screen');
})();
// Escape closes the iOS modal
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const m = document.getElementById('iosInstall');
    if (m && m.classList.contains('open')) { e.preventDefault(); closeIOSInstall(); }
  }
});
<\/script>
</body>
</html>`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_PATH, html, 'utf-8');
const kb = Math.round(html.length / 1024);
console.log(`✓ Report generated: ${OUT_PATH} (${kb} KB)`);

const copied = cpStaticAssets(STATIC_DIR, OUT_DIR);
if (copied > 0) {
  console.log(`✓ Copied ${copied} PWA asset(s) from ${STATIC_DIR} to ${OUT_DIR}`);
} else {
  console.log(`(no PWA assets found in ${STATIC_DIR})`);
}
