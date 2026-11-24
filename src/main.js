import {
  COLORS,
  FEATURED_ORDER,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  PLOT_BOX,
  dayIndexForX,
  exportChartPng,
  findNearestOtherSeason,
  renderEnsoChart,
  xForDayIndex,
} from './lib/chartRenderer.js';
import {
  dayIndexToIsoDate,
  dayIndexToMonthDay,
  dayIndexToSeasonDateLabel,
  formatIsoDateZh,
  formatSeasonLabel,
  formatSignedTemp,
  formatStatusZh,
} from './lib/formatters.js';

const REGION_ORDER = ['nino3', 'nino12', 'nino34'];

const state = {
  data: null,
  selectedRegion: 'nino3',
  hoverDayIndex: null,
  activeRegion: null,
  options: {
    visibleFeatured: {
      '1982-83': true,
      '1997-98': true,
      '2015-16': true,
      '2023-24': true,
    },
    showOthers: true,
    extraSeason: 'none',
  },
};

const canvases = {};
const tooltips = {};
const tabs = {};
const panels = {};
let liveAnnouncer = null;

function announce(msg) {
  if (!liveAnnouncer) return;
  liveAnnouncer.textContent = '';
  requestAnimationFrame(() => {
    liveAnnouncer.textContent = msg;
  });
}

function populateControls(data) {
  const select = document.getElementById('extra-season-select');
  const seasonsDesc = [...data.meta.seasons]
    .filter((s) => s !== data.meta.currentSeason && !data.meta.featuredSeasons.includes(s))
    .reverse();

  for (const s of seasonsDesc) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = formatSeasonLabel(s);
    select.appendChild(opt);
  }
}

function updateMetadataAndSummary(data) {
  const { meta, regions } = data;
  const freshness = document.getElementById('freshness-meta');
  freshness.textContent = `数据截至 ${formatIsoDateZh(meta.latestDate)}（${formatStatusZh(meta.latestStatus)}）· NOAA OISST v2.1 · 1991–2020 气候态基线 · 每日自动更新`;

  const tbody = document.getElementById('summary-table-body');
  tbody.innerHTML = '';

  for (const key of REGION_ORDER) {
    const region = regions[key];
    const lt = region.latest;

    // Tab quick metric badge
    const tabMetric = document.getElementById(`tab-val-${key}`);
    if (tabMetric) {
      tabMetric.textContent = formatSignedTemp(lt.anomaly, 2);
    }

    // Stat pill above active chart
    const pill = document.getElementById(`stat-${key}`);
    const deltaStr =
      lt.prevDayDelta === 0
        ? '较前日持平'
        : `较前日 ${formatSignedTemp(lt.prevDayDelta, 2)}`;
    pill.innerHTML = `最新 <strong>${formatSignedTemp(lt.anomaly, 2)}</strong>（${lt.date} · ${deltaStr} · 历史同期第 ${lt.rank}/${lt.totalYears} 位）`;

    // Accessible figcaption
    const figcap = document.getElementById(`figcaption-${key}`);
    figcap.textContent = `${region.title}，范围 ${region.boundsLabel}。${formatIsoDateZh(lt.date)} 最新海温距平为 ${formatSignedTemp(lt.anomaly, 2)}（海表温度 ${lt.sst.toFixed(2)} °C，${formatStatusZh(lt.status)}），在 1981 年以来同日观测中排名第 ${lt.rank} 位（共 ${lt.totalYears} 年）。`;

    const canvas = canvases[key];
    canvas.setAttribute(
      'aria-label',
      `${region.title}：${formatIsoDateZh(lt.date)} 最新值 ${formatSignedTemp(lt.anomaly, 2)}，使用左右方向键可逐日浏览。`
    );

    // Summary table row
    const tr = document.createElement('tr');
    const p82 = region.featuredPeaks['1982-83'];
    const p97 = region.featuredPeaks['1997-98'];
    const p15 = region.featuredPeaks['2015-16'];
    const p23 = region.featuredPeaks['2023-24'];

    const cells = [
      { tag: 'th', scope: 'row', text: region.shortName },
      { tag: 'td', text: region.boundsLabel },
      { tag: 'td', text: formatSignedTemp(lt.anomaly, 2) },
      { tag: 'td', text: `${lt.date} (${formatStatusZh(lt.status)})` },
      { tag: 'td', text: `第 ${lt.rank} / ${lt.totalYears} 年` },
      { tag: 'td', text: p82 ? `${formatSignedTemp(p82.anomaly, 2)} (${p82.date.slice(0, 7)})` : '—' },
      { tag: 'td', text: p97 ? `${formatSignedTemp(p97.anomaly, 2)} (${p97.date.slice(0, 7)})` : '—' },
      { tag: 'td', text: p15 ? `${formatSignedTemp(p15.anomaly, 2)} (${p15.date.slice(0, 7)})` : '—' },
      { tag: 'td', text: p23 ? `${formatSignedTemp(p23.anomaly, 2)} (${p23.date.slice(0, 7)})` : '—' },
    ];

    for (const c of cells) {
      const el = document.createElement(c.tag);
      if (c.scope) el.scope = c.scope;
      el.textContent = c.text;
      tr.appendChild(el);
    }
    tbody.appendChild(tr);
  }
}

function sizeAndDrawCanvas(regionKey) {
  if (!state.data) return;
  const canvas = canvases[regionKey];
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const targetW = Math.round(rect.width * dpr);
  const targetH = Math.round(rect.height * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  const ctx = canvas.getContext('2d');
  const activeDay = state.activeRegion === regionKey ? state.hoverDayIndex : null;

  renderEnsoChart(ctx, canvas.width, canvas.height, {
    region: state.data.regions[regionKey],
    meta: state.data.meta,
    options: state.options,
    hoverDayIndex: activeDay,
    exportMode: false,
  });
}

function renderAllCharts() {
  sizeAndDrawCanvas(state.selectedRegion);
  updateTooltips();
}

function updateTooltips() {
  if (!state.data) return;
  const { meta, regions } = state.data;

  for (const key of REGION_ORDER) {
    const tip = tooltips[key];
    const showHere =
      key === state.selectedRegion &&
      state.hoverDayIndex !== null &&
      state.activeRegion === key;

    if (!showHere) {
      tip.hidden = true;
      continue;
    }

    const dayIdx = state.hoverDayIndex;
    const region = regions[key];
    const md = dayIndexToMonthDay(dayIdx);
    const curVal = region.series[meta.currentSeason]?.[dayIdx];
    const curStatus = meta.currentSeasonStatus?.[dayIdx];

    const rows = [];
    rows.push({
      label: formatSeasonLabel(meta.currentSeason),
      val: curVal,
      color: COLORS.current,
      isCurrent: true,
    });

    if (
      state.options.extraSeason !== 'none' &&
      state.options.extraSeason !== meta.currentSeason &&
      !meta.featuredSeasons.includes(state.options.extraSeason)
    ) {
      rows.push({
        label: formatSeasonLabel(state.options.extraSeason),
        val: region.series[state.options.extraSeason]?.[dayIdx],
        color: COLORS.extra,
        isCurrent: false,
      });
    }

    for (const fs of FEATURED_ORDER) {
      if (state.options.visibleFeatured[fs]) {
        rows.push({
          label: formatSeasonLabel(fs),
          val: region.series[fs]?.[dayIdx],
          color: COLORS[fs],
          isCurrent: false,
        });
      }
    }

    tip.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'tooltip-date';
    const dateSpan = document.createElement('span');
    dateSpan.textContent =
      curVal !== null && curVal !== undefined
        ? dayIndexToSeasonDateLabel(meta.currentSeason, dayIdx)
        : md.label;
    header.appendChild(dateSpan);

    if (curStatus) {
      const stSpan = document.createElement('span');
      stSpan.className = 'tooltip-status';
      stSpan.textContent = formatStatusZh(curStatus);
      header.appendChild(stSpan);
    }
    tip.appendChild(header);

    const ul = document.createElement('ul');
    ul.className = 'tooltip-rows';
    for (const r of rows) {
      const li = document.createElement('li');
      li.className = 'tooltip-row';

      const left = document.createElement('span');
      left.className = 'tooltip-label';
      const dot = document.createElement('span');
      dot.className = 'tooltip-dot';
      dot.style.backgroundColor = r.color;
      left.appendChild(dot);
      left.appendChild(document.createTextNode(r.label));

      const right = document.createElement('span');
      right.className = r.isCurrent ? 'tooltip-val is-current' : 'tooltip-val';
      right.textContent = formatSignedTemp(r.val, 2);

      li.appendChild(left);
      li.appendChild(right);
      ul.appendChild(li);
    }
    tip.appendChild(ul);
    tip.hidden = false;

    const canvas = canvases[key];
    const stageW = canvas.clientWidth;
    const stageH = canvas.clientHeight;
    const xRatio = xForDayIndex(dayIdx) / LOGICAL_WIDTH;
    const pixelX = xRatio * stageW;
    const tipW = tip.offsetWidth || 210;
    const tipH = tip.offsetHeight || 120;

    const placeRight = pixelX + tipW + 24 < stageW;
    const leftPx = placeRight ? pixelX + 14 : Math.max(8, pixelX - tipW - 14);
    const topPx = Math.max(12, Math.min(stageH - tipH - 12, stageH * 0.16));
    tip.style.transform = `translate3d(${Math.round(leftPx)}px, ${Math.round(topPx)}px, 0)`;
  }
}

function selectRegionTab(regionKey, { moveFocus = false } = {}) {
  if (!REGION_ORDER.includes(regionKey)) return;
  const changed = state.selectedRegion !== regionKey;
  state.selectedRegion = regionKey;
  if (changed) {
    state.hoverDayIndex = null;
    state.activeRegion = null;
  }

  for (const key of REGION_ORDER) {
    const isSelected = key === regionKey;
    const tab = tabs[key];
    const panel = panels[key];
    tab.setAttribute('aria-selected', String(isSelected));
    tab.toggleAttribute('focusgroupstart', isSelected);
    if (isSelected) {
      panel.removeAttribute('hidden');
    } else {
      panel.setAttribute('hidden', 'until-found');
    }
  }

  const selectedTab = tabs[regionKey];
  if (moveFocus) {
    selectedTab.focus({ preventScroll: true });
  }
  selectedTab.scrollIntoView({ block: 'nearest', inline: 'nearest', container: 'nearest' });

  requestAnimationFrame(() => renderAllCharts());
}

function wireTabs() {
  for (const key of REGION_ORDER) {
    const tab = tabs[key];
    const panel = panels[key];

    tab.addEventListener('click', () => {
      selectRegionTab(key);
    });

    // Selection follows focus for instant responsive tab navigation
    tab.addEventListener('focus', () => {
      if (state.selectedRegion !== key) {
        selectRegionTab(key);
      }
    });

    // Sync selection when native Find-in-Page reveals a hidden="until-found" panel
    panel.addEventListener('beforematch', () => {
      selectRegionTab(key);
    });
  }

  // Fallback arrow-key support if native focusGroup is unavailable before polyfill initializes
  const tablist = document.querySelector('.region-tablist');
  tablist.addEventListener('keydown', (ev) => {
    if (Object.hasOwn(HTMLElement.prototype, 'focusGroup')) return;
    const idx = REGION_ORDER.indexOf(document.activeElement?.dataset?.regionTab);
    if (idx === -1) return;

    let nextIdx = null;
    if (ev.key === 'ArrowRight') nextIdx = (idx + 1) % REGION_ORDER.length;
    else if (ev.key === 'ArrowLeft') nextIdx = (idx - 1 + REGION_ORDER.length) % REGION_ORDER.length;
    else if (ev.key === 'Home') nextIdx = 0;
    else if (ev.key === 'End') nextIdx = REGION_ORDER.length - 1;

    if (nextIdx !== null) {
      ev.preventDefault();
      selectRegionTab(REGION_ORDER[nextIdx], { moveFocus: true });
    }
  });

  if (!CSS.supports('animation-timeline', 'scroll()')) {
    const scroller = document.querySelector('.region-tablist.scroller');
    if (scroller && scroller.firstElementChild && scroller.lastElementChild) {
      const [first, last] = [scroller.firstElementChild, scroller.lastElementChild];
      const observer = new IntersectionObserver(
        (entries) => {
          for (const { target, intersectionRatio } of entries) {
            scroller.classList.toggle(
              target === first ? 'more-start' : 'more-end',
              intersectionRatio < 1
            );
          }
        },
        { root: scroller, threshold: 1, rootMargin: '1px' }
      );
      observer.observe(first);
      observer.observe(last);
    }
  }
}

function attachChartInteractions(regionKey) {
  const canvas = canvases[regionKey];

  const toLogical = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    return {
      lx: ((clientX - rect.left) / rect.width) * LOGICAL_WIDTH,
      ly: ((clientY - rect.top) / rect.height) * LOGICAL_HEIGHT,
    };
  };

  canvas.addEventListener('pointermove', (ev) => {
    if (!state.data || state.selectedRegion !== regionKey) return;
    const { lx } = toLogical(ev.clientX, ev.clientY);
    if (lx < PLOT_BOX.left - 8 || lx > PLOT_BOX.right + 8) {
      if (state.activeRegion === regionKey) {
        state.hoverDayIndex = null;
        state.activeRegion = null;
        renderAllCharts();
      }
      return;
    }
    state.activeRegion = regionKey;
    state.hoverDayIndex = dayIndexForX(lx);
    renderAllCharts();
  });

  canvas.addEventListener('pointerleave', () => {
    if (state.activeRegion === regionKey) {
      state.hoverDayIndex = null;
      state.activeRegion = null;
      renderAllCharts();
    }
  });

  canvas.addEventListener('click', (ev) => {
    if (!state.data || state.selectedRegion !== regionKey) return;
    const { lx, ly } = toLogical(ev.clientX, ev.clientY);
    const hit = findNearestOtherSeason(
      lx,
      ly,
      state.data.regions[regionKey],
      state.data.meta,
      state.options
    );
    if (hit) {
      const next = state.options.extraSeason === hit ? 'none' : hit;
      state.options.extraSeason = next;
      document.getElementById('extra-season-select').value = next;
      renderAllCharts();
      announce(
        next === 'none'
          ? `已取消叠加 ${formatSeasonLabel(hit)}`
          : `已叠加对比 ${formatSeasonLabel(next)} 曲线`
      );
    }
  });

  canvas.addEventListener('keydown', (ev) => {
    if (!state.data || state.selectedRegion !== regionKey) return;
    const latestIdx = state.data.regions[regionKey].latest.dayIndex;
    const step = ev.shiftKey ? 7 : 1;

    if (ev.key === 'ArrowLeft') {
      ev.preventDefault();
      state.activeRegion = regionKey;
      const cur = state.hoverDayIndex ?? latestIdx;
      state.hoverDayIndex = Math.max(0, cur - step);
      renderAllCharts();
    } else if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      state.activeRegion = regionKey;
      const cur = state.hoverDayIndex ?? latestIdx;
      state.hoverDayIndex = Math.min(364, cur + step);
      renderAllCharts();
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      state.activeRegion = regionKey;
      state.hoverDayIndex = 0;
      renderAllCharts();
    } else if (ev.key === 'End') {
      ev.preventDefault();
      state.activeRegion = regionKey;
      state.hoverDayIndex = latestIdx;
      renderAllCharts();
    } else if (ev.key === 'Escape') {
      state.hoverDayIndex = null;
      state.activeRegion = null;
      renderAllCharts();
    }
  });
}

function wireControls() {
  document.querySelectorAll('.pill-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.toggle;
      const next = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', String(next));

      if (key === 'others') {
        state.options.showOthers = next;
      } else {
        state.options.visibleFeatured[key] = next;
      }
      renderAllCharts();
    });
  });

  document.getElementById('extra-season-select').addEventListener('change', (ev) => {
    state.options.extraSeason = ev.target.value;
    renderAllCharts();
    announce(
      ev.target.value === 'none'
        ? '已关闭额外历史年份叠加'
        : `已叠加对比 ${formatSeasonLabel(ev.target.value)}`
    );
  });

  document.querySelectorAll('[data-export]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!state.data) return;
      const key = btn.dataset.export;
      btn.disabled = true;
      try {
        await exportChartPng(state.data, key, state.options);
        announce(`已导出 ${state.data.regions[key].title} 高清 PNG`);
      } finally {
        btn.disabled = false;
      }
    });
  });

  document.getElementById('export-all-btn').addEventListener('click', async (ev) => {
    if (!state.data) return;
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      for (const key of REGION_ORDER) {
        await exportChartPng(state.data, key, state.options);
      }
      announce('已导出全部三张高清 PNG 图表');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('download-csv-btn').addEventListener('click', () => {
    if (!state.data) return;
    const { meta, regions } = state.data;
    const lines = ['date,season,nino3_anom,nino12_anom,nino34_anom'];
    for (const season of meta.seasons) {
      const len = regions.nino3.series[season]?.length ?? 0;
      for (let i = 0; i < len; i++) {
        const v3 = regions.nino3.series[season][i];
        const v12 = regions.nino12.series[season][i];
        const v34 = regions.nino34.series[season][i];
        if (v3 === null && v12 === null && v34 === null) continue;
        const iso = dayIndexToIsoDate(season, i);
        lines.push(`${iso},${season},${v3 ?? ''},${v12 ?? ''},${v34 ?? ''}`);
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `enso-daily-anomaly-${meta.latestDate}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce('已导出逐日距平 CSV 数据');
  });
}

async function init() {
  liveAnnouncer = document.getElementById('live-announcer');

  if (!Object.hasOwn(HTMLElement.prototype, 'focusGroup')) {
    import('@microsoft/focusgroup-polyfill')
      .then(({ polyfill }) => polyfill())
      .catch(() => {});
  }

  for (const key of REGION_ORDER) {
    canvases[key] = document.getElementById(`canvas-${key}`);
    tooltips[key] = document.getElementById(`tooltip-${key}`);
    tabs[key] = document.getElementById(`tab-${key}`);
    panels[key] = document.getElementById(`panel-${key}`);
    attachChartInteractions(key);
  }
  wireTabs();
  wireControls();

  const resizeObserver = new ResizeObserver(() => {
    renderAllCharts();
  });
  for (const key of REGION_ORDER) {
    resizeObserver.observe(canvases[key]);
  }

  try {
    const resp = await fetch('./data/enso-daily.json', { cache: 'no-cache' });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json();
    state.data = data;

    populateControls(data);
    updateMetadataAndSummary(data);

    document.getElementById('export-all-btn').disabled = false;
    document.getElementById('download-csv-btn').disabled = false;
    document.querySelectorAll('[data-export]').forEach((b) => {
      b.disabled = false;
    });

    if (document.fonts?.ready) {
      document.fonts.ready.then(() => renderAllCharts());
    }
    renderAllCharts();
  } catch (err) {
    const banner = document.getElementById('load-error');
    banner.textContent = `无法读取图表数据（${err.message}）。请确认已运行数据更新脚本生成 public/data/enso-daily.json。`;
    banner.hidden = false;
    document.getElementById('freshness-meta').textContent = '数据载入失败';
  }
}

init();
