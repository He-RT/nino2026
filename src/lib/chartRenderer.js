import {
  ENSO_MONTHS,
  MONTH_START_INDICES,
  formatAxisTick,
  formatIsoDateZh,
  formatSeasonLabel,
  formatSignedTemp,
} from './formatters.js';

export const LOGICAL_WIDTH = 1080;
export const LOGICAL_HEIGHT = 980;

export const PLOT_BOX = {
  left: 108,
  right: 1020,
  top: 138,
  bottom: 842,
};

export const FEATURED_ORDER = ['1982-83', '1997-98', '2015-16', '2023-24'];
const FEATURED_DRAW_ORDER = [...FEATURED_ORDER].reverse();

export const COLORS = {
  paper: '#F6F3EC',
  inkPrimary: '#1C1B18',
  inkSecondary: '#5C574E',
  footnote: '#625D54',
  grid: '#E3DDD1',
  zeroLine: '#7A756B',
  current: '#A62C2B',
  '1982-83': '#3B6B8C',
  '1997-98': '#B07D2B',
  '2015-16': '#5E7344',
  '2023-24': '#6D4C7D',
  extra: '#2A7B76',
  others: '#9B948A',
};

const FONT_SERIF = '"Noto Serif SC", "Songti SC", "STSong", "Noto Serif CJK SC", Georgia, serif';
const FONT_SANS = '"Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';

export function computeYBounds(region, meta, options) {
  let yMin = region.defaultYMin;
  let yMax = region.defaultYMax;
  const visibleSeasons = getVisibleSeasonKeys(meta, options);

  for (const season of visibleSeasons) {
    const arr = region.series[season];
    if (!arr) continue;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v === null || v === undefined) continue;
      if (v > yMax - 0.15) yMax = Math.ceil(v + 0.15);
      if (v < yMin + 0.15) yMin = Math.floor(v - 0.15);
    }
  }
  return { yMin, yMax };
}

export function getVisibleSeasonKeys(meta, options) {
  const keys = [];
  if (options.showOthers) {
    for (const s of meta.seasons) {
      if (s !== meta.currentSeason && !meta.featuredSeasons.includes(s) && s !== options.extraSeason) {
        keys.push(s);
      }
    }
  }
  if (options.extraSeason && options.extraSeason !== 'none' && options.extraSeason !== meta.currentSeason) {
    keys.push(options.extraSeason);
  }
  for (const fs of FEATURED_DRAW_ORDER) {
    if (options.visibleFeatured[fs]) keys.push(fs);
  }
  keys.push(meta.currentSeason);
  return keys;
}

export function xForDayIndex(dayIndex, plot = PLOT_BOX) {
  return plot.left + (dayIndex / 365) * (plot.right - plot.left);
}

export function dayIndexForX(x, plot = PLOT_BOX) {
  const ratio = (x - plot.left) / (plot.right - plot.left);
  return Math.max(0, Math.min(364, Math.round(ratio * 365)));
}

export function yForValue(val, yMin, yMax, plot = PLOT_BOX) {
  const ratio = (val - yMin) / (yMax - yMin);
  return plot.bottom - ratio * (plot.bottom - plot.top);
}

function strokeSeries(ctx, arr, yMin, yMax, { color, width, alpha = 1, plot = PLOT_BOX }) {
  if (!arr) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.globalAlpha = alpha;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();

  let inSegment = false;
  for (let i = 0; i < arr.length; i++) {
    const val = arr[i];
    if (val === null || val === undefined) {
      inSegment = false;
      continue;
    }
    const px = xForDayIndex(i, plot);
    const py = yForValue(val, yMin, yMax, plot);
    if (!inSegment) {
      ctx.moveTo(px, py);
      inSegment = true;
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.stroke();
  ctx.restore();
}

export function renderEnsoChart(ctx, width, height, { region, meta, options, hoverDayIndex = null, exportMode = false }) {
  const scaleX = width / LOGICAL_WIDTH;
  const scaleY = height / LOGICAL_HEIGHT;
  const scale = Math.min(scaleX, scaleY);

  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  // 1. Cream paper background
  ctx.fillStyle = COLORS.paper;
  ctx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);

  const { yMin, yMax } = computeYBounds(region, meta, options);

  // 2. Title
  ctx.fillStyle = COLORS.inkPrimary;
  ctx.font = `700 38px ${FONT_SERIF}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(region.title, 68, 76);

  // 3. Horizontal Gridlines & Y-Axis Ticks
  ctx.font = `400 17px ${FONT_SANS}`;
  ctx.textBaseline = 'middle';
  for (let tick = yMin; tick <= yMax; tick++) {
    const py = Math.round(yForValue(tick, yMin, yMax)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(PLOT_BOX.left, py);
    ctx.lineTo(PLOT_BOX.right, py);
    if (tick === 0) {
      ctx.strokeStyle = COLORS.zeroLine;
      ctx.lineWidth = 1.4;
    } else {
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
    }
    ctx.stroke();

    ctx.fillStyle = COLORS.inkSecondary;
    ctx.textAlign = 'right';
    ctx.fillText(formatAxisTick(tick), PLOT_BOX.left - 14, py);
  }

  // Unit label (°C) matching reference placement
  const unitYVal = Math.max(yMin + 1, Math.min(yMax - 1, region.unitYVal ?? 1));
  ctx.fillStyle = COLORS.inkSecondary;
  ctx.font = `400 17px ${FONT_SANS}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText('°C', PLOT_BOX.left - 48, yForValue(unitYVal, yMin, yMax));

  // 4. X-Axis Month Labels
  ctx.fillStyle = COLORS.inkSecondary;
  ctx.font = `400 16.5px ${FONT_SANS}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i < ENSO_MONTHS.length; i++) {
    const px = xForDayIndex(MONTH_START_INDICES[i]);
    ctx.fillText(ENSO_MONTHS[i], px, PLOT_BOX.bottom + 14);
  }

  // 5. Series Curves (Z-order: others -> extra -> 2015-16 -> 1997-98 -> 1982-83 -> current)
  if (options.showOthers) {
    for (const season of meta.seasons) {
      if (
        season === meta.currentSeason ||
        meta.featuredSeasons.includes(season) ||
        season === options.extraSeason
      ) {
        continue;
      }
      strokeSeries(ctx, region.series[season], yMin, yMax, {
        color: COLORS.others,
        width: 0.9,
        alpha: 0.34,
      });
    }
  }

  if (
    options.extraSeason &&
    options.extraSeason !== 'none' &&
    options.extraSeason !== meta.currentSeason &&
    !meta.featuredSeasons.includes(options.extraSeason)
  ) {
    strokeSeries(ctx, region.series[options.extraSeason], yMin, yMax, {
      color: COLORS.extra,
      width: 2.2,
      alpha: 0.95,
    });
  }

  for (const fs of FEATURED_DRAW_ORDER) {
    if (options.visibleFeatured[fs]) {
      strokeSeries(ctx, region.series[fs], yMin, yMax, {
        color: COLORS[fs],
        width: 1.9,
        alpha: 0.96,
      });
    }
  }

  // Current Season
  const curArr = region.series[meta.currentSeason];
  strokeSeries(ctx, curArr, yMin, yMax, {
    color: COLORS.current,
    width: 3.15,
    alpha: 1,
  });

  // 6. Current Season Terminal Marker & Callout
  const latestIdx = region.latest.dayIndex;
  const latestPlotVal = curArr?.[latestIdx] ?? region.latest.anomaly;
  if (latestPlotVal !== null && latestPlotVal !== undefined) {
    const dotX = xForDayIndex(latestIdx);
    const dotY = yForValue(latestPlotVal, yMin, yMax);

    ctx.save();
    ctx.fillStyle = COLORS.paper;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 6.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = COLORS.current;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 4.6, 0, Math.PI * 2);
    ctx.fill();

    const placeRight = dotX < PLOT_BOX.right - 210;
    const textX = placeRight ? dotX + 18 : dotX - 18;
    const clampedY = Math.max(PLOT_BOX.top + 30, Math.min(PLOT_BOX.bottom - 42, dotY - 4));

    ctx.textAlign = placeRight ? 'left' : 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.current;
    ctx.font = `700 25px ${FONT_SANS}`;
    ctx.fillText(formatSignedTemp(region.latest.anomaly, 2), textX, clampedY);

    ctx.font = `600 15px ${FONT_SANS}`;
    ctx.fillText(formatIsoDateZh(region.latest.date), textX, clampedY + 25);
    ctx.restore();
  }

  // 7. In-plot Legend (top-left)
  const legendItems = [
    { label: formatSeasonLabel(meta.currentSeason), color: COLORS.current, width: 3.1, alpha: 1 },
  ];
  for (const fs of FEATURED_ORDER) {
    if (options.visibleFeatured[fs]) {
      legendItems.push({ label: formatSeasonLabel(fs), color: COLORS[fs], width: 1.9, alpha: 1 });
    }
  }
  if (
    options.extraSeason &&
    options.extraSeason !== 'none' &&
    options.extraSeason !== meta.currentSeason &&
    !meta.featuredSeasons.includes(options.extraSeason)
  ) {
    legendItems.push({
      label: formatSeasonLabel(options.extraSeason),
      color: COLORS.extra,
      width: 2.2,
      alpha: 1,
    });
  }
  if (options.showOthers) {
    legendItems.push({ label: '其他年份', color: COLORS.others, width: 1.0, alpha: 0.72 });
  }

  const legX = PLOT_BOX.left + 16;
  const legY = PLOT_BOX.top + 10;
  const rowH = 25;
  const legW = 132;
  const legH = legendItems.length * rowH + 14;

  ctx.save();
  ctx.fillStyle = 'rgba(246, 243, 236, 0.86)';
  ctx.fillRect(legX, legY, legW, legH);

  ctx.font = `400 16px ${FONT_SANS}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  for (let i = 0; i < legendItems.length; i++) {
    const item = legendItems[i];
    const cy = legY + 18 + i * rowH;

    ctx.save();
    ctx.strokeStyle = item.color;
    ctx.lineWidth = item.width;
    ctx.globalAlpha = item.alpha;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(legX + 10, cy);
    ctx.lineTo(legX + 38, cy);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = COLORS.inkPrimary;
    ctx.fillText(item.label, legX + 48, cy + 0.5);
  }
  ctx.restore();

  // 8. Footnote
  ctx.fillStyle = COLORS.footnote;
  ctx.font = `400 15.5px ${FONT_SANS}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(
    `1981 年 9 月起，NOAA OISST v2.1，1991–2020 年同期均值，${region.boundsLabel}`,
    68,
    928
  );

  // 9. Interactive Crosshair (omitted in PNG export)
  if (!exportMode && hoverDayIndex !== null) {
    const hx = xForDayIndex(hoverDayIndex);
    ctx.save();
    ctx.strokeStyle = 'rgba(28, 27, 24, 0.35)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(hx, PLOT_BOX.top);
    ctx.lineTo(hx, PLOT_BOX.bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    const markerKeys = [
      ...(options.extraSeason && options.extraSeason !== 'none' ? [{ key: options.extraSeason, color: COLORS.extra }] : []),
      ...FEATURED_DRAW_ORDER
        .filter((fs) => options.visibleFeatured[fs])
        .map((fs) => ({ key: fs, color: COLORS[fs] })),
      { key: meta.currentSeason, color: COLORS.current },
    ];

    for (const m of markerKeys) {
      const val = region.series[m.key]?.[hoverDayIndex];
      if (val === null || val === undefined) continue;
      const my = yForValue(val, yMin, yMax);
      ctx.fillStyle = COLORS.paper;
      ctx.beginPath();
      ctx.arc(hx, my, 5.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = m.color;
      ctx.beginPath();
      ctx.arc(hx, my, 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  ctx.restore();
}

export function findNearestOtherSeason(logicalX, logicalY, region, meta, options) {
  if (!options.showOthers) return null;
  if (
    logicalX < PLOT_BOX.left ||
    logicalX > PLOT_BOX.right ||
    logicalY < PLOT_BOX.top ||
    logicalY > PLOT_BOX.bottom
  ) {
    return null;
  }

  const dayIdx = dayIndexForX(logicalX);
  const { yMin, yMax } = computeYBounds(region, meta, options);
  let bestSeason = null;
  let bestDist = 14; // max logical px threshold

  for (const season of meta.seasons) {
    if (season === meta.currentSeason || meta.featuredSeasons.includes(season)) continue;
    const val = region.series[season]?.[dayIdx];
    if (val === null || val === undefined) continue;
    const py = yForValue(val, yMin, yMax);
    const dist = Math.abs(py - logicalY);
    if (dist < bestDist) {
      bestDist = dist;
      bestSeason = season;
    }
  }
  return bestSeason;
}

export async function exportChartPng(data, regionKey, options) {
  if (document.fonts?.ready) {
    await document.fonts.ready;
  }
  const region = data.regions[regionKey];
  const scale = 2;
  const offscreen = document.createElement('canvas');
  offscreen.width = LOGICAL_WIDTH * scale;
  offscreen.height = LOGICAL_HEIGHT * scale;
  const ctx = offscreen.getContext('2d');
  renderEnsoChart(ctx, offscreen.width, offscreen.height, {
    region,
    meta: data.meta,
    options,
    hoverDayIndex: null,
    exportMode: true,
  });

  const blob = await new Promise((resolve) => offscreen.toBlob(resolve, 'image/png'));
  if (!blob) return false;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${regionKey}-${region.latest.date}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
