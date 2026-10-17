// ==UserScript==
// @name         馬券帳 - JRAレース結果インポート
// @namespace    keiba-yosou-app
// @version      1.3.0
// @description  JRAのレース結果・出走馬一覧のページを開いたら、ボタン1つで馬券帳へ送信する。docs/design/results-import.md「ユーザースクリプトによるHTML取込み」参照。
// @match        https://www.jra.go.jp/JRADB/accessS.html*
// @match        https://sp.jra.jp/JRADB/accessS.html*
// @match        https://www.jra.go.jp/JRADB/accessD.html*
// @match        https://sp.jra.jp/JRADB/accessD.html*
// @require      https://keiba-admin.pages.dev/jra-result-html.js
// @require      https://keiba-admin.pages.dev/jra-entries-html.js
// @connect      keiba-admin.pages.dev
// @grant        GM_xmlhttpRequest
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM.setClipboard
// ==/UserScript==

// 使い方:
//   1. Tampermonkey(PC)、またはUserscripts/Tampermonkey(iOS Safari)にこのスクリプトを
//      インストールする(このファイルのURLをブラウザで開けばインストールできる)。
//   2. JRA公式サイトでいつも通り「レース結果」→日付→競馬場→「すべてのレースを表示」まで
//      進める(この操作は今まで通り手作業。自動化しない)。
//   3. ページ右下に「馬券帳へ送信」「⚙」の2つのボタンが出てくる。初回は「⚙」を押して、
//      馬券帳の管理画面「APIトークン」で発行したトークンを貼り付ける。
//   4. 「馬券帳へ送信」を押す。確定しているレースだけが自動的に取り込まれる(未確定の
//      レースは何度実行しても自然にスキップされる)。
//   5. 出走馬一覧(出馬表。accessD.html)のページでも同じボタンが出る(1.3.0〜。2026-10-17)。
//      そのページの全レースの出走馬を、出走馬一覧の取込API へ送る(ブックマークレットと同じ。public/jra-entries-html.js)。
//
// このスクリプトはJRA公式サイトへ追加のアクセスを一切発生させない
// (今まさに開いているページの中身を読み取って送信するだけ)。
//
// 対応状況について: iOS Safariの「Userscripts」拡張は @require はスクリプト保存時に
// 一度だけ取得される(実行のたびに最新化はされない)。jra-result-html.js側の解析ロジックを
// 更新した場合は、このスクリプトを一度削除して入れ直す(再保存する)必要がある。また
// GM_registerMenuCommand は同拡張が非対応のため、トークン設定はメニューではなくページ上の
// 「⚙」ボタンから行う方式にしている(Tampermonkeyでも同じボタンを使う。挙動を統一するため)。

(function () {
  "use strict";

  // 2026-10-14: 取り込みは管理者用アプリ(keiba-admin)だけになった(docs/design/app-split.md)
  const APP_BASE_URL = "https://keiba-admin.pages.dev";
  const TOKEN_KEY = "keiba_app_api_token";

  async function getToken() {
    return (await GM.getValue(TOKEN_KEY, "")) || "";
  }

  async function setToken() {
    const current = await getToken();
    const next = prompt("馬券帳の管理画面「APIトークン」で発行したトークンを入力してください。", current);
    if (next !== null) await GM.setValue(TOKEN_KEY, next.trim());
  }

  function makeButton(label, title, bg) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    if (title) btn.title = title;
    Object.assign(btn.style, {
      padding: "10px 14px",
      fontSize: "15px",
      fontWeight: "bold",
      background: bg,
      color: "#fff",
      border: "none",
      borderRadius: "8px",
      boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
      cursor: "pointer",
    });
    return btn;
  }

  // 調査用: ページのHTML構造を確認するためのボタン。スマホ版の見出しブロック
  // (div[id^="kekkaRaceInfo_"])が全レース分見つかればそれを、無ければPC版の
  // .race_result_unitの見出し部分(発走時刻・レース名等がある.date_line/.race_title)を、
  // それも無ければ最初のtableより前のHTML全体を取得する。動作確認が完了したら削除してよい。
  const DEBUG_MAX_LEN = 20000;

  async function onClickDebug() {
    let html;
    const kekkaInfos = Array.from(document.querySelectorAll('div[id^="kekkaRaceInfo_"]'));
    const raceUnits = Array.from(document.querySelectorAll(".race_result_unit"));
    if (kekkaInfos.length) {
      html = kekkaInfos.map((d) => d.outerHTML).join("\n\n");
    } else if (raceUnits.length) {
      html = raceUnits
        .map((u) => {
          const dateLine = u.querySelector(".date_line");
          const raceTitle = u.querySelector(".race_title");
          return `<!-- ${u.id} -->\n${dateLine ? dateLine.outerHTML : ""}\n${raceTitle ? raceTitle.outerHTML : ""}`;
        })
        .join("\n\n");
    } else {
      const bodyHtml = document.body.innerHTML;
      const tableIdx = bodyHtml.indexOf("<table");
      html = tableIdx >= 0 ? bodyHtml.slice(0, tableIdx) : bodyHtml;
    }
    if (html.length > DEBUG_MAX_LEN) {
      html = `…(先頭省略)…\n${html.slice(-DEBUG_MAX_LEN)}`;
    }
    try {
      await GM.setClipboard(html);
      alert("見出しブロックのHTMLをクリップボードにコピーしました。貼り付けて送ってください。");
    } catch (e) {
      prompt("コピーに失敗したため、下のテキストを手動で全選択してコピーしてください。", html);
    }
  }

  function injectButtons() {
    if (document.getElementById("keiba-app-import-wrap")) return;

    const wrap = document.createElement("div");
    wrap.id = "keiba-app-import-wrap";
    Object.assign(wrap.style, {
      position: "fixed",
      left: "8px",
      right: "8px",
      bottom: "max(8px, env(safe-area-inset-bottom))",
      zIndex: 2147483647,
      display: "flex",
      justifyContent: "flex-end",
      flexWrap: "wrap",
      gap: "8px",
      pointerEvents: "none",
    });

    const debugBtn = makeButton("🔍HTML取得", "調査用: ページのtable要素を丸ごとコピーする", "#555");
    debugBtn.style.pointerEvents = "auto";
    debugBtn.addEventListener("click", onClickDebug);
    wrap.appendChild(debugBtn);

    // レース結果一覧ページ(PC版=.race_result_unit、スマホ版=div[id^="kekkaRaceInfo_"]が
    // ある)と出走馬一覧ページ(li[id^="syutsuba_"]。2026-10-17)でのみ、送信・設定ボタンを追加する。
    if (pageKind()) {
      const settingsBtn = makeButton("⚙", "APIトークンを設定", "#333");
      settingsBtn.style.pointerEvents = "auto";
      settingsBtn.addEventListener("click", setToken);
      wrap.appendChild(settingsBtn);

      const sendBtn = makeButton("馬券帳へ送信", null, "#1a7f37");
      sendBtn.id = "keiba-app-import-btn";
      sendBtn.style.pointerEvents = "auto";
      sendBtn.addEventListener("click", onClickImport);
      wrap.appendChild(sendBtn);
    }

    document.body.appendChild(wrap);
  }

  // "result"(レース結果一覧)/ "entries"(出走馬一覧)/ null
  function pageKind() {
    if (document.querySelector(".race_result_unit") || document.querySelector("div[id^='kekkaRaceInfo_']")) return "result";
    if (typeof jraEntriesHtmlIsPage === "function" && jraEntriesHtmlIsPage(document)) return "entries";
    return null;
  }

  function resetButton() {
    const btn = document.getElementById("keiba-app-import-btn");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "馬券帳へ送信";
    }
  }

  function post(path, token, payload, onSuccess) {
    const btn = document.getElementById("keiba-app-import-btn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "送信中…";
    }
    GM_xmlhttpRequest({
      method: "POST",
      url: `${APP_BASE_URL}${path}`,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      data: JSON.stringify(payload),
      onload(res) {
        resetButton();
        if (res.status >= 200 && res.status < 300) {
          let data = null;
          try { data = JSON.parse(res.responseText); } catch { data = null; }
          onSuccess(data);
        } else {
          alert(`送信に失敗しました(HTTP ${res.status})。\n${res.responseText}`);
        }
      },
      onerror() {
        resetButton();
        alert("送信に失敗しました(通信エラー)。");
      },
    });
  }

  // 出走馬一覧(2026-10-17): jraEntriesHtmlParsePage は @require で読み込む public/jra-entries-html.js の関数
  function importEntries(token) {
    const { records, errors } = jraEntriesHtmlParsePage(document);
    if (!records.length) {
      alert(`取り込める出走馬が見つかりませんでした。${errors.length ? `\n\n${errors.join("\n")}` : ""}`);
      return;
    }
    const head = `${records[0].race_date} ${records[0].track}`;
    const summary = records.map((r) => `${r.race_number}R ${r.race_name || ""}(${r.entries.length}頭)`).join("\n");
    const warn = errors.length ? `\n\n読み取れなかったもの:\n${errors.join("\n")}` : "";
    if (!confirm(`${head} の${records.length}レース分の出走馬を馬券帳へ送信します。よろしいですか?\n\n${summary}${warn}`)) return;
    // source: JRA公式(レース名・コース等を公式の値で上書きする。ブックマークレットと同じ。2026-10-16)
    post("/api/races/entries-import", token, { races: records, source: "jra" }, (data) => {
      const results = Array.isArray(data?.results) ? data.results : [];
      const count = (s) => results.filter((x) => x.status === s).length;
      const invalid = results.filter((x) => x.status === "invalid");
      let msg = `送信しました(${records.length}レース分。新規 ${count("created")}・更新 ${count("updated")}・変更なし ${count("unchanged")})。`;
      if (invalid.length) msg += `\n\n取り込めなかったレース:\n${invalid.map((x) => `${x.key || ""} ${x.message || ""}`).join("\n")}`;
      alert(msg);
    });
  }

  async function onClickImport() {
    const token = await getToken();
    if (!token) {
      alert("先に「⚙」ボタンからAPIトークンを設定してください。");
      return;
    }
    if (pageKind() === "entries") {
      importEntries(token);
      return;
    }

    // jraResultHtmlParsePage は @require で読み込む public/jra-result-html.js の関数。
    const { records, diagnostics } = jraResultHtmlParsePage(document);
    if (!records.length) {
      alert(
        `取り込めるレース結果が見つかりませんでした(検出したレース枠: ${diagnostics.unitsFound}件)。まだ結果が確定していない可能性があります。`
      );
      return;
    }

    const summary = records.map((r) => `${r.race_number}R ${r.race_name || ""}`).join("\n");
    if (!confirm(`以下${records.length}レース分の結果を馬券帳へ送信します。よろしいですか?\n\n${summary}`)) return;

    // source: JRA公式(レース名・コース等を上書きする。2026-10-16)
    post("/api/races/results-import", token, { races: records, mode: "overwrite", source: "jra" }, () => {
      alert(`送信しました(${records.length}レース分)。`);
    });
  }

  injectButtons();
  // JRAサイトは同一URLのままページ内容だけ差し替える場合があるため、DOM変化も監視する。
  new MutationObserver(injectButtons).observe(document.body, { childList: true, subtree: true });
})();
