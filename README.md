# 厄尔尼诺关键区逐日海温距平监测（Niño 3 / Niño 1+2 / Niño 3.4）

基于 **NOAA OISST v2.1**（0.25° 全球逐日最优插值海温）自动绘制并每日更新的三张厄尔尼诺海区逐日海温距平对比图。

## 三张图表与计算口径

1. **Niño 3 逐日海温距平**：`5°S–5°N、150°W–90°W`
2. **Niño 1+2 逐日海温距平**：`10°S–0°、90°W–80°W`
3. **Niño 3.4 逐日海温距平**：`5°S–5°N、170°W–120°W`

- **数据源**：NOAA NCEI OISST v2.1 每日 NetCDF-4 原档（`https://www.ncei.noaa.gov/data/sea-surface-temperature-optimum-interpolation/v2.1/access/avhrr/`）+ NOAA AWS Open Data S3 历史镜像，时间自 **1981 年 9 月 1 日**起完整无缺口。
- **气候态基线**：**1991–2020 年对应日历日（`MM-DD`）30 年均值**；空间平均采用余弦纬度（$\cos(\text{lat})$）面积加权，与标准海洋气象口径一致。
- **周期划分**：按厄尔尼诺跨年周期（**6 月 1 日 → 次年 5 月 31 日**）叠加对比当前季、`1982–83`、`1997–98`、`2015–16` 及所有历史年份（跳过 2 月 29 日以对齐跨年日期）。

## 数据真实更新频率

- NOAA OISST v2.1 为**每日更新一次（逐日分辨率）**，通常在每天 **UTC 14:30（北京时间约 22:30）** 发布前 1–2 天的初步数据（`preliminary`），并在约 14 天后订正为最终质控版（`final`）。
- 本项目的 GitHub Actions 工作流（`.github/workflows/update-data.yml`）在每天北京时间 **23:30** 与次日 **06:00** 各运行一次，回溯重拉最近 25 天数据，兼顾第一时间更新与自动订正。

## 本地运行与更新

```bash
# 1. 安装前端依赖
npm install

# 2. 启动本地开发服务器
npm run dev

# 3. 增量拉取最新 NOAA 数据（几秒完成）
npm run update-data

# 如需从 1981 年起全量重拉（仅首次或校验时使用）
npm run backfill-data

# 4. 构建静态站点到 dist/
npm run build
npm run preview
```

Python 依赖见 `scripts/requirements.txt`（`h5py`、`numpy`、`requests`），推荐搭配 `uv` 运行（`npm run update-data` 会自动通过 `uv run` 安装所需依赖），或使用 `pip install -r scripts/requirements.txt`。

## 免费部署与全自动更新（推荐 GitHub Pages）

1. 将本仓库推送到 GitHub（确保默认分支为 `main`，且包含 `data/oisst_daily_sst.csv` 与 `public/data/enso-daily.json`）。
2. 打开仓库 **Settings → Pages**：
   - 将 **Source** 设置为 **GitHub Actions**。
3. 打开仓库 **Settings → Actions → General**：
   - 在 **Workflow permissions** 中勾选 **Read and write permissions**，保存。
4. 完成！之后：
   - `.github/workflows/update-data.yml` 每天定时抓取 NOAA 最新数据并自动提交到 `main`。
   - `.github/workflows/deploy.yml` 会在更新完成后自动构建并发布到 GitHub Pages（也可以在 Actions 页面手动点击 **Run workflow** 立即触发）。

### 也可以使用 Cloudflare Pages / Vercel

如果你更偏好 Cloudflare Pages 或 Vercel：
- 连接同一个 GitHub 仓库（仍由 `.github/workflows/update-data.yml` 自动更新仓库内数据并触发平台重新构建）。
- **Build command**：`npm run build`
- **Build output directory**：`dist`
