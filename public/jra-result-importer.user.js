// ==UserScript==
// @name         馬券帳 - JRAレース結果インポート
// @namespace    keiba-yosou-app
// @version      1.0.0
// @description  JRAレース結果ページを開いたら、ボタン1つで馬券帳へ結果を送信する(印刷してPDF保存してアプリへアップロードする手間を省く)。docs/design/results-import.md「ユーザースクリプトによるHTML取込み」参照。
// @match        https://www.jra.go.jp/JRADB/accessS.html*
// @match        https://sp.jra.jp/JRADB/accessS.html*
// @require      https://keiba-yosou-app.pages.dev/jra-result-html.js
// @connect      keiba-yosou-app.pages.dev
// @grant        GM_xmlhttpRequest
// @grant        GM.setValue
// @grant        GM.getValue
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

  const APP_BASE_URL = "https://keiba-yosou-app.pages.dev";
  const TOKEN_KEY = "keiba_app_api_token";

  async function getToken() {
    return (await GM.getValue(TOKEN_KEY, "")) || "";
  }

  async function setToken() {
    const current = await getToken();
    const next = prompt("馬券帳の管理画面「APIトークン」で発行したトークンを入力してください。", current);
    if (next !== null) await GM.setValue(TOKEN_KEY, next.trim());
  }

  function injectButtons() {
    if (document.getElementById("keiba-app-import-btn")) return;
    // レース結果一覧ページ以外(開催選択・レース選択画面等)では何もしない。
    if (!document.querySelectorAll(".race_result_unit").length) return;

    const wrap = document.createElement("div");
    wrap.id = "keiba-app-import-wrap";
    Object.assign(wrap.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: 2147483647,
      display: "flex",
      gap: "8px",
    });

    const sendBtn = document.createElement("button");
    sendBtn.id = "keiba-app-import-btn";
    sendBtn.type = "button";
    sendBtn.textContent = "馬券帳へ送信";
    Object.assign(sendBtn.style, {
      padding: "12px 20px",
      fontSize: "16px",
      fontWeight: "bold",
      background: "#1a7f37",
      color: "#fff",
      border: "none",
      borderRadius: "8px",
      boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
      cursor: "pointer",
    });
    sendBtn.addEventListener("click", onClickImport);

    const settingsBtn = document.createElement("button");
    settingsBtn.type = "button";
    settingsBtn.textContent = "⚙";
    settingsBtn.title = "APIトークンを設定";
    Object.assign(settingsBtn.style, {
      padding: "12px 14px",
      fontSize: "16px",
      background: "#333",
      color: "#fff",
      border: "none",
      borderRadius: "8px",
      boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
      cursor: "pointer",
    });
    settingsBtn.addEventListener("click", setToken);

    wrap.appendChild(settingsBtn);
    wrap.appendChild(sendBtn);
    document.body.appendChild(wrap);
  }

  async function onClickImport() {
    const token = await getToken();
    if (!token) {
      alert("先に「⚙」ボタンからAPIトークンを設定してください。");
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

    const btn = document.getElementById("keiba-app-import-btn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "送信中…";
    }

    GM_xmlhttpRequest({
      method: "POST",
      url: `${APP_BASE_URL}/api/races/results-import`,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      data: JSON.stringify({ races: records, mode: "overwrite" }),
      onload(res) {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "馬券帳へ送信";
        }
        if (res.status >= 200 && res.status < 300) {
          alert(`送信しました(${records.length}レース分)。`);
        } else {
          alert(`送信に失敗しました(HTTP ${res.status})。\n${res.responseText}`);
        }
      },
      onerror() {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "馬券帳へ送信";
        }
        alert("送信に失敗しました(通信エラー)。");
      },
    });
  }

  injectButtons();
  // JRAサイトは同一URLのままページ内容だけ差し替える場合があるため、DOM変化も監視する。
  new MutationObserver(injectButtons).observe(document.body, { childList: true, subtree: true });
})();
