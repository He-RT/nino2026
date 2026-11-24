export const ENSO_MONTHS = [
  '6月', '7月', '8月', '9月', '10月', '11月',
  '12月', '1月', '2月', '3月', '4月', '5月',
];

// Non-leap seasonal offsets from June 1 (day 0) to May 1 (day 334), total 365 days.
export const MONTH_START_INDICES = [0, 30, 61, 92, 122, 153, 183, 214, 245, 273, 304, 334];

const REF_JUNE1_UTC = Date.UTC(2001, 5, 1);
const MS_PER_DAY = 86_400_000;

export function formatSeasonLabel(season) {
  return String(season).replace('-', '–');
}

export function formatSignedTemp(val, decimals = 2) {
  if (val === null || val === undefined || Number.isNaN(val)) return '—';
  const rounded = Number(val.toFixed(decimals));
  if (Object.is(rounded, -0) || rounded === 0) {
    return `${(0).toFixed(decimals)} °C`;
  }
  const absStr = Math.abs(rounded).toFixed(decimals);
  return `${rounded > 0 ? '+' : '\u2212'}${absStr} °C`;
}

export function formatAxisTick(val) {
  if (val > 0) return `+${val}`;
  if (val < 0) return `\u2212${Math.abs(val)}`;
  return '0';
}

export function dayIndexToMonthDay(dayIndex) {
  const clamped = Math.max(0, Math.min(364, Math.round(dayIndex)));
  const dt = new Date(REF_JUNE1_UTC + clamped * MS_PER_DAY);
  const month = dt.getUTCMonth() + 1;
  const day = dt.getUTCDate();
  return {
    month,
    day,
    label: `${month} 月 ${day} 日`,
  };
}

export function dayIndexToSeasonDateLabel(season, dayIndex) {
  const { month, day } = dayIndexToMonthDay(dayIndex);
  const startYear = Number.parseInt(String(season).slice(0, 4), 10);
  const year = month >= 6 ? startYear : startYear + 1;
  return `${year} 年 ${month} 月 ${day} 日`;
}

export function dayIndexToIsoDate(season, dayIndex) {
  const { month, day } = dayIndexToMonthDay(dayIndex);
  const startYear = Number.parseInt(String(season).slice(0, 4), 10);
  const year = month >= 6 ? startYear : startYear + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function formatIsoDateZh(isoDate) {
  const [y, m, d] = String(isoDate).split('-').map((n) => Number.parseInt(n, 10));
  if (!y || !m || !d) return isoDate;
  return `${y} 年 ${m} 月 ${d} 日`;
}

export function formatStatusZh(status) {
  if (status === 'final' || status === 'f') return '最终版';
  if (status === 'preliminary' || status === 'p') return '初步版';
  return '未知';
}
