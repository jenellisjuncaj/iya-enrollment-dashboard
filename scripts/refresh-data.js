const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const TERM_CODE = 20263;
const SCHOOL_CODE = "ACAD";
const PROGRAM_CODES = ["ACAD", "IDSN", "PRIN"];
const TIME_ZONE = "America/Los_Angeles";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "..", "data.js");
const API_URL = "https://classes.usc.edu/api/Courses/CoursesByTermSchoolProgram";

function loadData(source) {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: DATA_FILE });
  return context.window;
}

function formatParts(date, options) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, ...options })
      .formatToParts(date)
      .filter(part => part.type !== "literal")
      .map(part => [part.type, part.value])
  );
}

function runLabels(date) {
  const dateParts = formatParts(date, { year: "numeric", month: "long", day: "numeric" });
  const shortDateParts = formatParts(date, { year: "numeric", month: "numeric", day: "numeric" });
  const timeParts = formatParts(date, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short"
  });
  const hour = Number(formatParts(date, { hour: "numeric", hourCycle: "h23" }).hour);
  const dateLabel = `${dateParts.month} ${dateParts.day}, ${dateParts.year}`;
  const timeLabel = `${timeParts.hour}:${timeParts.minute} ${timeParts.dayPeriod}`;
  const dayPeriod = hour < 12 ? "AM" : "PM";

  return {
    dateLabel,
    trendDate: `${shortDateParts.month}/${shortDateParts.day}/${shortDateParts.year} ${dayPeriod}`,
    currentSnapshot: `${dateLabel} - ${timeLabel} PT (${timeParts.timeZoneName}) ACAD + IDSN + PRIN update`,
    historySnapshot: `${hour < 12 ? "Morning" : "Afternoon"} update - ${timeLabel} PT (${timeParts.timeZoneName})`
  };
}

async function fetchProgram(program) {
  const url = new URL(API_URL);
  url.searchParams.set("termCode", TERM_CODE);
  url.searchParams.set("school", SCHOOL_CODE);
  url.searchParams.set("program", program);

  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "iya-enrollment-dashboard-refresh" }
  });
  if (!response.ok) {
    throw new Error(`USC SOC request for ${program} failed with ${response.status}`);
  }

  const data = await response.json();
  if (!Array.isArray(data.courses)) {
    throw new Error(`USC SOC response for ${program} did not contain courses`);
  }
  return data.courses.map(course => ({ ...course, requestedProgram: program }));
}

function trackedCourses(courseLists) {
  const candidates = courseLists
    .flat()
    .filter(course => PROGRAM_CODES.includes(course.scheduledCourseCode?.prefix));
  const sections = new Map();

  for (const course of candidates) {
    for (const section of course.sections || []) {
      const sectionId = String(section.sisSectionId);
      const current = sections.get(sectionId);
      const isScheduledProgram = course.requestedProgram === course.scheduledCourseCode.prefix;
      if (!current || isScheduledProgram) {
        sections.set(sectionId, { course, section });
      }
    }
  }

  return sections;
}

function instructorNames(section) {
  const names = (section.instructors || [])
    .map(instructor => [instructor.firstName, instructor.lastName].filter(Boolean).join(" "))
    .filter(Boolean);
  return names.length ? names.join(", ") : "TBD";
}

function refreshedRow(existing, record) {
  return {
    ...existing,
    instructor: instructorNames(record.section),
    enrolled: Number(record.section.registeredSeats ?? 0),
    capacity: Number(record.section.totalSeats ?? 0),
    waitlisted: Number(record.section.waitlistedSeats ?? 0)
  };
}

function inferredProgram(prefix) {
  if (prefix === "ACAD") return "Undergraduate ACAD";
  if (prefix === "IDSN") return "Graduate IDSN";
  return "Product Innovation (PRIN)";
}

function newRow(record, template) {
  const prefix = record.course.scheduledCourseCode.prefix;
  const courseCode = record.course.scheduledCourseCode.courseSpace;
  const row = {
    program: template?.program || inferredProgram(prefix),
    course: template?.course || `${courseCode} ${record.course.name}`,
    section: String(record.section.sisSectionId),
    instructor: instructorNames(record.section),
    enrolled: Number(record.section.registeredSeats ?? 0),
    capacity: Number(record.section.totalSeats ?? 0),
    waitlisted: Number(record.section.waitlistedSeats ?? 0)
  };
  if (template && Object.hasOwn(template, "metrics")) row.metrics = template.metrics;
  return row;
}

function buildSections(existingSections, records) {
  const existingIds = new Set(existingSections.map(section => section.section));
  const templates = new Map();

  for (const section of existingSections) {
    const record = records.get(section.section);
    const courseCode = record?.course.scheduledCourseCode?.courseSpace;
    if (courseCode && !templates.has(courseCode)) templates.set(courseCode, section);
  }

  const refreshed = existingSections
    .filter(section => records.has(section.section))
    .map(section => refreshedRow(section, records.get(section.section)));

  const added = [...records.values()]
    .filter(record => !existingIds.has(String(record.section.sisSectionId)))
    .map(record => {
      const courseCode = record.course.scheduledCourseCode.courseSpace;
      return newRow(record, templates.get(courseCode));
    })
    .sort((left, right) =>
      left.program.localeCompare(right.program) ||
      left.course.localeCompare(right.course) ||
      left.section.localeCompare(right.section)
    );

  return [...refreshed, ...added];
}

function enrollmentChanges(existingSections, freshSections, date) {
  const previousBySection = new Map();
  const freshBySection = new Map();
  for (const section of existingSections) {
    if (!previousBySection.has(section.section)) previousBySection.set(section.section, section);
  }
  for (const section of freshSections) {
    if (!freshBySection.has(section.section)) freshBySection.set(section.section, section);
  }

  const changes = [];
  for (const [sectionId, previous] of previousBySection) {
    const current = freshBySection.get(sectionId);
    if (current && current.enrolled !== previous.enrolled) {
      changes.push({
        date,
        course: previous.course,
        section: sectionId,
        previous: previous.enrolled,
        current: current.enrolled
      });
    }
  }
  return changes;
}

function replaceProperty(source, property, value) {
  const marker = `"${property}":`;
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Could not find dashboardData.${property}`);

  let start = markerIndex + marker.length;
  while (/\s/.test(source[start])) start++;
  let end = start;

  if (source[start] === '"') {
    end++;
    let escaped = false;
    while (end < source.length) {
      const char = source[end++];
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') break;
    }
  } else {
    const open = source[start];
    const close = open === "[" ? "]" : "}";
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (; end < source.length; end++) {
      const char = source[end];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '"') {
        quote = char;
      } else if (char === open) {
        depth++;
      } else if (char === close && --depth === 0) {
        end++;
        break;
      }
    }
  }

  const serialized = JSON.stringify(value, null, 6).replace(/\n/g, "\n      ");
  return source.slice(0, start) + serialized + source.slice(end);
}

async function main() {
  const source = fs.readFileSync(DATA_FILE, "utf8");
  const { dashboardData } = loadData(source);
  const runAt = new Date();
  const labels = runLabels(runAt);
  const courseLists = await Promise.all(PROGRAM_CODES.map(fetchProgram));
  const records = trackedCourses(courseLists);
  const sections = buildSections(dashboardData.sections, records);
  const changes = enrollmentChanges(dashboardData.sections, sections, labels.trendDate);
  const added = changes.reduce((sum, change) => sum + Math.max(change.current - change.previous, 0), 0);
  const dropped = changes.reduce((sum, change) => sum + Math.max(change.previous - change.current, 0), 0);
  const fullSections = sections.filter(section =>
    section.metrics !== false &&
    Number.isFinite(section.enrolled) &&
    Number.isFinite(section.capacity) &&
    section.enrolled >= section.capacity
  ).length;
  const history = [
    ...dashboardData.history,
    {
      date: labels.dateLabel,
      snapshot: labels.historySnapshot,
      added,
      dropped,
      fullSections,
      notes: `Automated USC SOC refresh; ${changes.length} sections changed enrollment (+${added}/-${dropped} seats).`
    }
  ];

  let output = source;
  output = replaceProperty(output, "currentSnapshot", labels.currentSnapshot);
  output = replaceProperty(output, "sections", sections);
  output = replaceProperty(output, "trendLog", [...changes, ...dashboardData.trendLog]);
  output = replaceProperty(output, "history", history);
  fs.writeFileSync(DATA_FILE, output);
  console.log(`Refreshed ${sections.length} dashboard rows from ${records.size} USC SOC sections.`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
