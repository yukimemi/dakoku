/// <reference lib="dom" />
// =============================================================================
// File        : main.ts
// Author      : yukimemi
// Last Change : 2026/09/05
// =============================================================================
//
// ジョブカンの入室 / 退室打刻を minipc から実行する。
//
// ★ 資格情報をこのリポジトリに置かない。ID/パスワードを保存する代わりに
//   **永続プロファイル**（Chromium の user-data-dir）に一度だけ手で
//   ログインし、以後はそのセッションを使い回す。ジョブカンIDが SSO / 2FA でも
//   これなら通る（自動ログインを組むと 2FA で必ず詰む）。
//
//     deno task install   # Chromium を取得（初回のみ）
//     deno task login     # ブラウザが開く。手でログインして放置。自動で閉じる
//     deno task status    # ログイン状態と打刻ページの操作候補を JSON で出す
//     deno task in        # 入室打刻
//     deno task out       # 退室打刻
//
// ★ 二重打刻を DOM の解釈で防がない。ジョブカンの打刻画面の構造に依存した
//   「打刻済み判定」は UI 変更で黙って壊れ、壊れ方が「打刻済みと誤認して
//   打刻しない」方向に転ぶと**忘れるより悪い**。代わりにローカルの
//   状態ファイル（日付 × phase）で 1 日 1 回に抑える。判定材料が自分の
//   ファイルなので、壊れるときは必ず「打刻しようとして失敗」＝気付ける方向。
//
// ★ 失敗は必ず可視化する。ボタンが見つからない / セッション切れは
//   スクリーンショットを残して非 0 で終了し、呼び出し側（kanade job）が
//   ntfy で通知する。黙って何もしないのが最悪の失敗様態。

import { type BrowserContext, chromium, type Page } from "playwright";

const SIGN_IN = "https://id.jobcan.jp/users/sign_in";
const EMPLOYEE = "https://ssl.jobcan.jp/employee";

/** 押したいボタンの候補ラベル。会社ごとに打刻区分の名称が違う（入室/退室 の
 *  ところと 出勤/退勤 のところがある）ので、両方を順に試す。 */
const LABELS: Record<Phase, string[]> = {
  in: ["入室", "出勤"],
  out: ["退室", "退勤"],
};

type Phase = "in" | "out";

function stateDir(): string {
  const base = Deno.env.get("LOCALAPPDATA");
  if (!base) throw new Error("LOCALAPPDATA is not set (Windows only)");
  const dir = `${base}\\kanade-dakoku`;
  Deno.mkdirSync(dir, { recursive: true });
  return dir;
}

function profileDir(): string {
  return `${stateDir()}\\chrome-profile`;
}

function markerPath(phase: Phase, now: Date): string {
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${
    String(now.getDate()).padStart(2, "0")
  }`;
  return `${stateDir()}\\punched-${phase}-${d}.flg`;
}

async function shot(page: Page, tag: string): Promise<string> {
  const dir = `${stateDir()}\\shots`;
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}\\${tag}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.png`;
  await page.screenshot({ path, fullPage: true });
  return path;
}

async function open(headless: boolean): Promise<BrowserContext> {
  // ★ Playwright の同梱 Chromium は使わない。`playwright install chromium` が
  //   このマシンで **毎回 257,788,727 バイトちょうどで展開が止まる**（4 回
  //   再現。zip のダウンロード自体は数秒で終わり、そこから先が進まない）。
  //   原因の追跡より、既にインストール済みのブラウザを使う方が確実で、
  //   500MB の依存が消える。channel は既存インストールを直接起動する。
  //
  //   既定は chrome。Edge にしたい / Chrome が無い環境では
  //   DAKOKU_CHANNEL=msedge で切り替える。
  //
  // ★ 永続コンテキスト = 専用の user-data-dir。Cookie も localStorage も
  //   ここに残るので、login 後の status / in / out は headless で通る。
  //   普段使いのプロファイルとは別ディレクトリなので、普段のブラウザの
  //   ログイン状態やセッションには一切触らない。
  const channel = Deno.env.get("DAKOKU_CHANNEL") ?? "chrome";
  return await chromium.launchPersistentContext(profileDir(), {
    headless,
    channel,
    viewport: { width: 1280, height: 900 },
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  });
}

/** 打刻ページへ行き、ログイン済みであることを確認する。 */
async function gotoEmployee(page: Page): Promise<void> {
  await page.goto(EMPLOYEE, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
  const url = page.url();
  if (/id\.jobcan\.jp|sign_in|login/i.test(url)) {
    const path = await shot(page, "session-expired");
    throw new Error(
      `SESSION_EXPIRED: redirected to ${url} — run \`deno task login\` (shot: ${path})`,
    );
  }
}

/** ページ上の押せる要素のアクセシブル名を集める。DOM 構造に依存した
 *  セレクタを持たないための唯一の観測手段で、status の出力そのもの。 */
async function clickableNames(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const sel = 'button, input[type="submit"], input[type="button"], a[href], [role="button"]';
    const seen = new Set<string>();
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const he = el as HTMLElement;
      const rect = he.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const name = (
        (el as HTMLInputElement).value ||
        he.innerText ||
        he.getAttribute("aria-label") ||
        ""
      ).replace(/\s+/g, " ").trim();
      if (name) seen.add(name);
    }
    return Array.from(seen);
  });
}

async function cmdStatus(): Promise<void> {
  const ctx = await open(true);
  try {
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await gotoEmployee(page);
    const names = await clickableNames(page);
    console.log(JSON.stringify({ ok: true, url: page.url(), clickable: names }, null, 2));
  } finally {
    await ctx.close();
  }
}

async function cmdLogin(): Promise<void> {
  const ctx = await open(false);
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto(SIGN_IN, { waitUntil: "domcontentloaded" });
  console.log("browser opened — sign in manually (2FA included). waiting up to 10 min...");
  // ログイン完了の判定は「打刻ページに到達できること」。id.jobcan.jp の
  // 画面遷移は SSO 構成で変わるので、遷移そのものを当てにしない。
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3_000);
    if (!/id\.jobcan\.jp/i.test(page.url())) {
      await page.goto(EMPLOYEE, { waitUntil: "domcontentloaded" }).catch(() => {});
      if (!/id\.jobcan\.jp|sign_in|login/i.test(page.url())) {
        console.log(`login ok: ${page.url()}`);
        await ctx.close();
        return;
      }
    }
  }
  await ctx.close();
  throw new Error("LOGIN_TIMEOUT: did not reach the employee page within 10 min");
}

async function cmdPunch(phase: Phase, force: boolean): Promise<void> {
  const now = new Date();
  const marker = markerPath(phase, now);
  if (!force) {
    try {
      Deno.statSync(marker);
      console.log(JSON.stringify({ ok: true, phase, skipped: "already-punched-today" }));
      return;
    } catch { /* not punched yet */ }
  }

  const ctx = await open(true);
  try {
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await gotoEmployee(page);

    const before = await clickableNames(page);
    let clicked: string | null = null;
    for (const label of LABELS[phase]) {
      // getByRole ではなく可視テキスト一致。ジョブカンの打刻ボタンは
      // <input value="入室"> のことも <button> のこともあるため。
      const target = page.locator(
        `button:has-text("${label}"), input[value*="${label}"], [role="button"]:has-text("${label}")`,
      ).first();
      if (await target.count() === 0) continue;
      if (!(await target.isVisible().catch(() => false))) continue;
      await target.click({ timeout: 15_000 });
      clicked = label;
      break;
    }

    if (!clicked) {
      const path = await shot(page, `no-button-${phase}`);
      throw new Error(
        `NO_BUTTON: none of ${JSON.stringify(LABELS[phase])} found. ` +
          `clickable=${JSON.stringify(before)} (shot: ${path})`,
      );
    }

    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
    const after = await clickableNames(page);
    const evidence = await shot(page, `punched-${phase}`);

    // マーカーは**クリックが成功してから**書く。書けなかった日は次のキックで
    // もう一度打刻を試みる（force なしでも通る）。
    Deno.writeTextFileSync(marker, now.toISOString());
    console.log(JSON.stringify({
      ok: true,
      phase,
      clicked,
      changed: JSON.stringify(before) !== JSON.stringify(after),
      shot: evidence,
    }));
  } finally {
    await ctx.close();
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = Deno.args;
  const force = rest.includes("--force");
  switch (cmd) {
    case "login":
      await cmdLogin();
      break;
    case "status":
      await cmdStatus();
      break;
    case "in":
      await cmdPunch("in", force);
      break;
    case "out":
      await cmdPunch("out", force);
      break;
    default:
      console.error("usage: main.ts <login|status|in|out> [--force]");
      Deno.exit(2);
  }
}

if (import.meta.main) {
  await main();
}
