const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"] as const;
const numberWords: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  couple: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};
const numberExpression = "a|an|one|two|couple|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\d+";

export interface TimeRangeHint {
  startTime?: string;
  endTime?: string;
  durationMinutes?: number;
  crossesMidnight?: boolean;
  ambiguousRange?: { startTime: string; endTime: string };
  invalid?: boolean;
}

export interface EventHints extends TimeRangeHint {
  title?: string;
  date?: string;
  allDay?: boolean;
  ambiguousStartTime?: string;
  ambiguousTimePeriod?: "morning" | "afternoon" | "evening";
  hasDateExpression: boolean;
  hasTimeExpression: boolean;
  looksLikeEvent: boolean;
}

export const normalizeTimePunctuation = (input: string) => input
  .replace(/[–—−]/g, "-")
  .replace(/\b((?:and\s+(?:it\s+)?|it\s+))enzo(?=\s+(?:at|around|about|roughly|approximately|like|\d))/gi, "$1ends")
  .replace(/\b(at|around|about|roughly|approximately)\s+like\s+(?=\d)/gi, "$1 ")
  .replace(/\b(starts?|begins?)\s+at\s+(around|about|roughly|approximately)\s+(?=\d)/gi, "$1 $2 ")
  .replace(/(\b\d{1,2}\s*(?:-|to|till|until|through|thru)\s*\d{1,2});(\d{2})\b/gi, "$1:$2")
  .replace(/\b(\d{1,2});(\d{2})(?=\s*(?:am|pm)\b)/gi, "$1:$2")
  .replace(/\s+/g, " ")
  .trim();

const timeValue = (hourText: string, minuteText?: string, meridiem?: string) => {
  let hour = Number(hourText);
  const minute = Number(minuteText ?? 0);
  if (hour > 23 || minute > 59) return undefined;
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    hour = hour % 12 + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

const minutesOfDay = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const oppositeMeridiem = (meridiem: string) => meridiem.toLowerCase() === "pm" ? "am" : "pm";

export const extractTimeRange = (input: string): TimeRangeHint => {
  const normalized = normalizeTimePunctuation(input).toLowerCase();
  const timeSource = normalized
    .replace(/\bnoon\b/g, "12 pm")
    .replace(/\bmidnight\b/g, "12 am")
    .replace(/\b(\d{1,2}(?::\d{2})?)\s+in\s+the\s+morning\b/g, "$1 am")
    .replace(/\b(\d{1,2}(?::\d{2})?)\s+in\s+the\s+(?:afternoon|evening)\b/g, "$1 pm");
  const between = timeSource.match(/\bbetween\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+and\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  const match = between ?? timeSource.match(/\b(?:(?:from|at|starts?(?:\s+(?:at|around|about|roughly|approximately))?|begins?(?:\s+(?:at|around|about|roughly|approximately))?|beginning(?:\s+at)?|(?:tip[ -]?off|kick[ -]?off)(?:\s+is)?\s+at)\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to|till|until|through|thru|and\s+at\s+|(?:and\s+)?(?:it\s+)?(?:end(?:s|ing)?|finish(?:es|ing)?|(?:should\s+be\s+)?over(?:\s+by)?|wraps?\s+up|wrapping\s+up)(?:\s+(?:at|around|about|roughly|approximately))?)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!match) return {};

  const [, startHour, startMinute, explicitStartMeridiem, endHour, endMinute, explicitEndMeridiem] = match;
  if (!explicitStartMeridiem && !explicitEndMeridiem && Number(startHour) <= 12 && Number(endHour) <= 12) {
    const startTime = timeValue(startHour, startMinute);
    const endTime = timeValue(endHour, endMinute);
    return startTime && endTime ? { ambiguousRange: { startTime, endTime } } : { invalid: true };
  }

  let startMeridiem = explicitStartMeridiem ?? explicitEndMeridiem;
  let endMeridiem = explicitEndMeridiem ?? explicitStartMeridiem;
  let startTime = timeValue(startHour, startMinute, startMeridiem);
  let endTime = timeValue(endHour, endMinute, endMeridiem);
  if (!startTime || !endTime) return { invalid: true };

  let crossesMidnight = false;
  let durationMinutes = minutesOfDay(endTime) - minutesOfDay(startTime);
  if (durationMinutes <= 0 && !explicitStartMeridiem && explicitEndMeridiem) {
    startMeridiem = oppositeMeridiem(explicitEndMeridiem);
    startTime = timeValue(startHour, startMinute, startMeridiem);
    durationMinutes = startTime ? minutesOfDay(endTime) - minutesOfDay(startTime) : 0;
  } else if (durationMinutes <= 0 && explicitStartMeridiem && !explicitEndMeridiem) {
    endMeridiem = oppositeMeridiem(explicitStartMeridiem);
    endTime = timeValue(endHour, endMinute, endMeridiem);
    crossesMidnight = Boolean(endTime && minutesOfDay(endTime) <= minutesOfDay(startTime));
    durationMinutes = endTime ? minutesOfDay(endTime) + (crossesMidnight ? 1_440 : 0) - minutesOfDay(startTime) : 0;
  } else if (durationMinutes <= 0 && explicitStartMeridiem && explicitEndMeridiem && explicitStartMeridiem !== explicitEndMeridiem) {
    crossesMidnight = true;
    durationMinutes += 1_440;
  } else if (durationMinutes <= 0 && (Number(startHour) > 12 || Number(endHour) > 12)) {
    crossesMidnight = true;
    durationMinutes += 1_440;
  }

  if (!startTime || !endTime || durationMinutes <= 0 || durationMinutes > 720) return { invalid: true };
  return { startTime, endTime, durationMinutes, crossesMidnight };
};

const referenceLocalDate = (currentDate: string, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(currentDate));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
};

const formatLocalDate = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (date: Date, amount: number) => new Date(date.getTime() + amount * 86_400_000);

export const resolveDateExpression = (input: string, currentDate: string, timezone: string) => {
  const normalized = normalizeTimePunctuation(input).toLowerCase();
  const reference = referenceLocalDate(currentDate, timezone);
  const relative = normalized.match(new RegExp(`\\b(?:in\\s+)?(${numberExpression})\\s+(day|days|week|weeks)\\s+(?:from|after)\\s+(today|now|tomorrow)\\b|\\b(${numberExpression})\\s+(day|days|week|weeks)\\s+from\\s+(today|now|tomorrow)\\b|\\bin\\s+(${numberExpression})\\s+(day|days|week|weeks)\\b`));
  if (relative) {
    const amountText = relative[1] ?? relative[4] ?? relative[7];
    const unit = relative[2] ?? relative[5] ?? relative[8];
    const baseWord = relative[3] ?? relative[6];
    const amount = numberWords[amountText] ?? Number(amountText);
    const base = baseWord === "tomorrow" ? addDays(reference, 1) : reference;
    return formatLocalDate(addDays(base, unit.startsWith("week") ? amount * 7 : amount));
  }
  if (/\bday after tomorrow\b/.test(normalized)) return formatLocalDate(addDays(reference, 2));
  if (/\btomorrow\b/.test(normalized)) return formatLocalDate(addDays(reference, 1));
  if (/\b(?:today|tonight)\b/.test(normalized)) return formatLocalDate(reference);

  const absolute = normalized.match(new RegExp(`\\b(${monthNames.join("|")})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "i"));
  if (absolute) {
    const month = monthNames.indexOf(absolute[1].toLowerCase() as typeof monthNames[number]);
    const day = Number(absolute[2]);
    let year = absolute[3] ? Number(absolute[3]) : reference.getUTCFullYear();
    let result = new Date(Date.UTC(year, month, day));
    if (result.getUTCMonth() !== month || result.getUTCDate() !== day) return undefined;
    if (!absolute[3] && result < reference) result = new Date(Date.UTC(++year, month, day));
    return formatLocalDate(result);
  }

  const weekdayIndex = weekdays.findIndex((weekday) => new RegExp(`\\b(?:(?:this|next)\\s+|this\\s+coming\\s+)?${weekday}\\b`).test(normalized));
  if (weekdayIndex >= 0) {
    let delta = (weekdayIndex - reference.getUTCDay() + 7) % 7;
    if (new RegExp(`\\bnext\\s+${weekdays[weekdayIndex]}\\b`).test(normalized)) delta += 7;
    return formatLocalDate(addDays(reference, delta));
  }
  return undefined;
};

const titleCase = (value: string) => value.toLowerCase().replace(/\b\w/g, (character) => character.toUpperCase()).replace(/\bWith\b/g, "with").replace(/\bAnd\b/g, "and").replace(/\bVs\b/g, "vs.");
const preserveAcronyms = (value: string) => value.replace(/\b(fifa|nba|nfl|ufc|f1|bts)\b/gi, (match) => match.toUpperCase());

export const normalizeEventTitle = (input: string) => {
  let value = normalizeTimePunctuation(input)
    .replace(/[.,!?]/g, " ")
    .replace(/\bfrom\s+noon\b/gi, "from 12 PM")
    .replace(/\b(to|till|until|through|thru)\s+noon\b/gi, "$1 12 PM")
    .replace(/\bfrom\s+midnight\b/gi, "from 12 AM")
    .replace(/\b(to|till|until|through|thru)\s+midnight\b/gi, "$1 12 AM")
    .replace(/\b((?:end(?:s|ing)?|finish(?:es|ing)?|(?:should\s+be\s+)?over(?:\s+by)?|wraps?\s+up|wrapping\s+up)\s+(?:at\s+)?)noon\b/gi, "$1 12 PM")
    .replace(/\b((?:end(?:s|ing)?|finish(?:es|ing)?|(?:should\s+be\s+)?over(?:\s+by)?|wraps?\s+up|wrapping\s+up)\s+(?:at\s+)?)midnight\b/gi, "$1 12 AM")
    .replace(/\b(?:can|could|would)\s+(?:you|u)\s+(?:please\s+)?(?:add|put|schedule|create)\s+(?:that|it)\b.*$/gi, " ")
    .replace(/\b(?:add|put|save)?\s*(?:that|it)?\s*(?:to|on|in)\s+(?:(?:my|the)\s+)?(?:calendar|schedule|plans?)\b/gi, " ")
    .replace(/\b(?:please|can\s+(?:you|u)|cna\s+(?:you|u)|could\s+(?:you|u)|would\s+(?:you|u)|for me)\b/gi, " ")
    .replace(/\b(?:add|create|schedule|put|block|save)\b/gi, " ")
    .replace(/\b(?:remind me(?:\s+that|\s+to)?|i need to|i have to|i have(?:\s+(?:an?|the))?|i(?:'|â€™|\s+)ve got(?:\s+(?:an?|the))?|there(?:'|â€™|\s+)s(?:\s+(?:an?|the))?)\b/gi, " ")
    .replace(/\b(?:in\s+)?(?:a|an|one|two|couple|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)\s+(?:days?|weeks?)\s+(?:from|after)\s+(?:today|now|tomorrow)\b/gi, " ")
    .replace(/\b(?:a|an|one|two|couple|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)\s+(?:days?|weeks?)\s+from\s+(?:today|now|tomorrow)\b/gi, " ")
    .replace(/\bin\s+(?:a|an|one|two|couple|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)\s+(?:days?|weeks?)\b/gi, " ")
    .replace(/\b(?:at|from|starts?(?:\s+(?:at|around|about|roughly|approximately))?|begins?(?:\s+(?:at|around|about|roughly|approximately))?|beginning(?:\s+at)?|(?:tip[ -]?off|kick[ -]?off)(?:\s+is)?\s+at)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:-|to|till|until|through|thru|and\s+at\s+|(?:and\s+)?(?:it\s+)?(?:end(?:s|ing)?|finish(?:es|ing)?|(?:should\s+be\s+)?over(?:\s+by)?|wraps?\s+up|wrapping\s+up)(?:\s+(?:at|around|about|roughly|approximately))?)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, " ")
    .replace(/\bbetween\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s+and\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, " ")
    .replace(/\b(?:at|around|about|roughly|approximately)?\s*(?:half|quarter)\s+(?:past|to)\s+\d{1,2}\s*(?:am|pm)\b/gi, " ")
    .replace(/(?:\b(?:at|from|around|about|roughly|approximately)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b)/gi, " ")
    .replace(/\b(?:for\s+)?(?:(?:a|an|one|two|three|four|\d+)\s+hours?\s+and\s+a\s+half|an?\s+hour\s+and\s+a\s+half|half\s+an?\s+hour)\b/gi, " ")
    .replace(/\b(?:for\s+)?(?:a|an|one|two|three|four|\d+(?:\.\d+)?)\s*[- ]?\s*(?:hours?|hrs?|minutes?|mins?)\b/gi, " ")
    .replace(/\b(?:after work|in the morning|in the afternoon|in the evening|morning|afternoon|evening|noon|midnight|all[ -]?day)\b/gi, " ")
    .replace(/\b(?:on|for)\s+(?:(?:this|next)\s+)?(?:today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi, " ")
    .replace(/\b(?:this|next)\s+week\b/gi, " ")
    .replace(/\bcoming\s+up\b/gi, " ")
    .replace(/\b(?:the\s+day\s+after\s+tomorrow|day\s+after\s+tomorrow|this\s+coming\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)|this\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)|next\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)|today|tomorrow|tonight|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi, " ")
    .replace(new RegExp(`\\b(?:(?:on|at)\\s+)?(?:${monthNames.join("|")})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, "gi"), " ")
    .replace(/\b(?:at|around|about|roughly|approximately)\s+(?:noon|midnight)\b/gi, " ")
    .replace(/[;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:(?:so|well|okay|ok|hey|um|uh|basically|actually)\s+)+/i, "")
    .replace(/^to\s+have\s+(?:an?|the)?\s*/i, "")
    .replace(/^(?:the|an?|is|it)\s+/i, "")
    .replace(/^my\s+/i, "")
    .replace(/^for\s+/i, "")
    .replace(/(?:\s+(?:is|that|it|on|at|for))+$/i, "")
    .trim();

  const interview = value.match(/^interview with (.+)$/i);
  if (interview) value = `${interview[1]} Interview`;
  if (/^doctor(?:\s+thing)?$/i.test(value)) value = "Doctor Appointment";
  if (/\bassignment\b/i.test(value) && /\bfinish\b/i.test(value)) value = value.replace(/\bfinish(?:\s+my)?\b/i, "Complete");
  value = value
    .replace(/\bformula(?:\s+one|\s+1)?\s+game\s+to\s+watch\b/gi, "Formula 1 Race")
    .replace(/\bgrand\s+pr(?:ix|x|i)\b/gi, "Grand Prix")
    .replace(/\bformula one\b/gi, "Formula 1")
    .replace(/\bgrand prix in belgium\b/gi, "Belgian Grand Prix")
    .replace(/\bbelgium grand prix\b/gi, "Belgian Grand Prix");
  if (/\bf1\b.*\bgrand prix\b/i.test(value)) value = value.replace(/\bf1\b/i, "Formula 1");
  const normalized = preserveAcronyms(titleCase(value)).replace(/['â€™]S\b/g, (match) => `${match.slice(0, -1)}s`);
  return /^(?:event|calendar event|appointment)$/i.test(normalized) || !normalized ? undefined : normalized;
};

const addDuration = (startTime: string, durationMinutes: number) => {
  const total = minutesOfDay(startTime) + durationMinutes;
  return { endTime: `${String(Math.floor((total % 1_440) / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`, crossesMidnight: total >= 1_440 };
};

export const extractEventHints = (message: string, currentDate: string, timezone: string): EventHints => {
  const normalized = normalizeTimePunctuation(message);
  const lower = normalized.toLowerCase()
    .replace(/\b(\d{1,2}(?::\d{2})?)\s+in\s+the\s+morning\b/g, "$1 am")
    .replace(/\b(\d{1,2}(?::\d{2})?)\s+in\s+the\s+(?:afternoon|evening)\b/g, "$1 pm");
  const range = extractTimeRange(normalized);
  const allDay = /\ball[ -]?day\b/i.test(normalized);
  const hourAndHalf = lower.match(/\b(?:for\s+)?(?:(a|an|one|two|three|four|\d+)\s+hours?\s+and\s+a\s+half|an?\s+hour\s+and\s+a\s+half)\b/);
  const durationMatch = lower.match(/\b(?:for\s+)?(a|an|one|two|three|four|\d+(?:\.\d+)?)\s*[- ]?\s*(hours?|hrs?|minutes?|mins?)\b/);
  const durationValue = durationMatch ? numberWords[durationMatch[1]] ?? Number(durationMatch[1]) : undefined;
  const explicitDuration = hourAndHalf
    ? ((numberWords[hourAndHalf[1]] ?? Number(hourAndHalf[1] ?? 1)) * 60) + 30
    : /\b(?:for\s+)?half\s+an?\s+hour\b/.test(lower)
      ? 30
      : durationValue === undefined ? undefined : durationMatch?.[2].startsWith("h") ? durationValue * 60 : durationValue;
  const spokenTime = lower.match(/\b(?:at|around|about|roughly|approximately)?\s*(half|quarter)\s+(past|to)\s+(\d{1,2})\s*(am|pm)\b/);
  const spokenStart = spokenTime
    ? timeValue(String(spokenTime[2] === "to" ? Number(spokenTime[3]) - 1 || 12 : Number(spokenTime[3])), spokenTime[2] === "to" ? String(60 - (spokenTime[1] === "half" ? 30 : 15)) : String(spokenTime[1] === "half" ? 30 : 15), spokenTime[4])
    : undefined;
  const singleTime = !range.startTime && !range.ambiguousRange && !spokenStart ? lower.match(/\b(?:at|around|about)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/) : null;
  const namedTime = /\bnoon\b/.test(lower) ? "12:00" : /\bmidnight\b/.test(lower) ? "00:00" : undefined;
  const startTime = range.startTime ?? spokenStart ?? namedTime ?? (singleTime?.[3] ? timeValue(singleTime[1], singleTime[2], singleTime[3]) : undefined);
  const ambiguousStartTime = singleTime && !singleTime[3] ? timeValue(singleTime[1], singleTime[2]) : undefined;
  const computedEnd = startTime && explicitDuration && !range.endTime ? addDuration(startTime, explicitDuration) : undefined;
  const ambiguousTimePeriod = /\bmorning\b/.test(lower) ? "morning" : /\bafternoon\b/.test(lower) ? "afternoon" : /\bevening\b/.test(lower) ? "evening" : undefined;
  const date = resolveDateExpression(normalized, currentDate, timezone);
  const hasDateExpression = Boolean(date || /\b(?:today|tomorrow|day after tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(normalized));
  const hasTimeExpression = Boolean(allDay || range.startTime || range.ambiguousRange || singleTime || explicitDuration || ambiguousTimePeriod || /\b(?:noon|midnight)\b/.test(lower));

  return {
    title: normalizeEventTitle(normalized),
    date,
    startTime: allDay ? undefined : startTime,
    endTime: allDay ? undefined : range.endTime ?? computedEnd?.endTime,
    durationMinutes: range.durationMinutes ?? explicitDuration,
    crossesMidnight: range.crossesMidnight ?? computedEnd?.crossesMidnight,
    ambiguousRange: range.ambiguousRange,
    invalid: range.invalid,
    allDay,
    ambiguousStartTime,
    ambiguousTimePeriod,
    hasDateExpression,
    hasTimeExpression,
    looksLikeEvent: /\b(?:calendar|schedule|plans?|event|game|match|race|dinner|brunch|meeting|appointment|interview|practice|class|lesson|call|lab|movie night|team sync|final|workout|flight|graduation|therapy|concert|reservation|shift|exam|test|study session|workshop|conference|ceremony|party|block|add|put)\b/i.test(normalized),
  };
};
