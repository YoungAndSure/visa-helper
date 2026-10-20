import { z } from "zod";

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "请输入有效的日历日期。");
// Calendar arithmetic clamps to the final day of a month (including leap years).
function addMonths(value, months) {
  const [year, month, day] = value.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}
export function passportDateChecks(fields, answers = {}) {
  const arrival = dateSchema.safeParse(answers.arrivalDate).success ? answers.arrivalDate : null;
  const departure = dateSchema.safeParse(answers.departureDate).success ? answers.departureDate : null;
  const issue = fields.issueDate, expiry = fields.expiryDate;
  const minimumExpiry = departure ? addMonths(departure, 3) : null;
  const latestArrival = issue ? addMonths(issue, 120) : null;
  return [
    { id: "issued_within_ten_years", status: issue && arrival ? (issue <= arrival && arrival <= latestArrival ? "pass" : "fail") : "unknown",
      referenceDate: arrival, limitDate: latestArrival, guidance: "以已确认的预计入境日核对签发后10年，不推断递交日期。" },
    { id: "validity", status: expiry && minimumExpiry ? (expiry >= minimumExpiry && (!issue || expiry > issue) ? "pass" : "fail") : "unknown",
      referenceDate: departure, limitDate: minimumExpiry, guidance: "到期日须覆盖预计离境日后3个日历月。" },
  ];
}

export function materialChecks(definition, data, answers = {}) {
  return (definition.rules ?? []).map((rule) => {
    const fields = data.fields;
    let status = "unknown";
    if (rule.kind === "trip_coverage") {
      const start = fields[rule.start], end = fields[rule.end];
      if (start && end && answers.arrivalDate && answers.departureDate) status = start <= answers.arrivalDate && end >= answers.departureDate && start <= end ? "pass" : "fail";
    } else if (rule.kind === "minimum_amount") {
      const amount = fields[rule.amount], minimum = rule.minimum[fields[rule.currency]?.toUpperCase()];
      if (amount !== undefined && minimum !== undefined) status = Number(amount) >= minimum ? "pass" : "fail";
    } else if (rule.kind === "itinerary_days" && data.rows.length) {
      const expected = travelDays(answers), dates = data.rows.map((row) => row.date);
      if (expected.length) status = expected.length === dates.length && new Set(dates).size === dates.length && expected.every((day) => dates.includes(day))
        && data.rows.every((row) => row.location?.trim() && row.plan?.trim()) ? "pass" : "fail";
    }
    return { id: rule.checkId, status, guidance: definition.checks.find(({ id }) => id === rule.checkId)?.guidance ?? "按实际资料核对。" };
  });
}
export function travelDays(answers) {
  if (!dateSchema.safeParse(answers.arrivalDate).success || !dateSchema.safeParse(answers.departureDate).success) return [];
  const start = Date.parse(`${answers.arrivalDate}T00:00:00Z`), end = Date.parse(`${answers.departureDate}T00:00:00Z`);
  const count = (end - start) / 86400000 + 1;
  if (count < 1 || count > 366) return [];
  return Array.from({ length: count }, (_, i) => new Date(start + i * 86400000).toISOString().slice(0, 10));
}
