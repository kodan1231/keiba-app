// JRA公式PDF(出走馬一覧・レース結果一覧)のクライアント側解析で共通して使うヘルパー関数。
// 2026-09-01新設: jra-entries-pdf.js と jra-result-pdf.js で類似のUnicode正規化・
// 行内テキスト連結ロジックがそれぞれ独立実装されており、修正が片方にしか反映されず
// パーサーの挙動が食い違う不具合(docs/BACKLOG.md「調査中の不具合」に記載していた
// 「パーサーの非対称性」)が発生していた。具体的には、jra-entries-pdf.js側だけに
// 「タブ(列区切り)情報の保持」「ギャップしきい値の上限キャップ」という改善が入り、
// jra-result-pdf.js側には反映されないままになっていた。本ファイルへ正規化・連結
// ロジックを集約し、両パーサーが同じ実装を参照するようにすることで、この非対称性を
// 解消する(=jra-result-pdf.js側もentries側と同じ改善を受けるようになる)。
//
// races.html では utils.js の次、jra-entries-pdf.js・jra-result-pdf.js より前に
// 本ファイルを読み込む必要がある(ESモジュールを使わないグローバルスクリプト構成のため)。

// 全角英数記号(Unicode Fullwidth Forms, U+FF01–FF5E)のみを対応する半角ASCII文字へ
// 変換する。String.prototype.normalize("NFKC")を全文へ一括適用すると、全角/半角の統一
// だけでなく、CJK互換漢字(人名用の異体字を多く含むCJK Compatibility Ideographs
// Supplement等)まで標準字形へ変換してしまう副作用があり、「戸崎」騎手のように人名で
// 使われる異体字の字体が変わってしまう不具合があった。日付・時刻・金額等のパースに
// 必要な全角→半角変換の効果は維持しつつ、漢字(人名用の異体字を含む)には一切影響しない
// 変換に限定する。
function jraPdfToHalfwidthAscii(s) {
  return String(s ?? "").replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

// 康熙部首(Kangxi Radicals, U+2F00–2FD5)・CJK部首補助(CJK Radicals Supplement,
// U+2E80–2EF3)を、対応する標準のCJK統合漢字へ正規化する。
//
// NFKC正規化を全文へ適用しない方針の副作用として、JRA PDFのテキスト抽出結果に含まれる
// 「日」「月」「発」「走」「馬」等の通常の漢字が、見た目は同じでも上記2つのUnicode
// ブロックの部首記号として抽出されるケースがあり、日付・発走時刻等の正規表現が
// 軒並み不一致になる回帰不具合が過去に発生した。この2ブロックは部首記号専用であり、
// 「戸崎」問題の原因だったCJK互換漢字ブロック(U+F900–FAFF・CJK互換漢字補助
// U+2F800–2FA1F、人名異体字を含む)とは重複しないため、対象を該当ブロックの文字
// 1文字ごとのNFKC正規化に限定することで、人名異体字問題を再発させずに検出不具合を
// 解消できる。対象範囲は実際に確認できた特定の文字に限定せず、両ブロック全体を対象に
// する(将来別の部首文字が出現しても自動対応できるようにするため)。
function jraPdfNormalizeRadicals(s) {
  return String(s ?? "").replace(/[\u2E80-\u2EF3\u2F00-\u2FD5]/g, (ch) => ch.normalize("NFKC"));
}

// 全角記号・各種スペース・コロン・括弧・ハイフンのゆれを吸収する共通の単位正規化。
// jra-result-pdf.js側にのみ存在した全角丸括弧(︵︶)の変換も含めている(出走馬一覧PDF側で
// 該当文字が出現しなければ単に無害なため、安全に統合できる)。
// (旧jra-result-pdf.js実装では `\u2000-\u200B` を文字クラス外の交代(alternation)として
// 書いてしまっており、実質的にU+2000〜U+200Bの範囲がほぼマッチしない不具合があった。
// 本共通化にあわせて `[\u00a0\u2000-\u200B\u202F]` という正しい文字クラスに修正している)。
function jraPdfNormalizeUnit(s) {
  return jraPdfNormalizeRadicals(jraPdfToHalfwidthAscii(s))
    .replace(/\u3000/g, " ") // 全角スペース
    .replace(/[\u00a0\u2000-\u200B\u202F]/g, " ")
    .replace(/[︓﹕]/g, ":")
    .replace(/[︵]/g, "(").replace(/[︶]/g, ")")
    .replace(/[﹣－−―–—]/g, "-");
}

// 行内の空白正規化。タブ(列区切りの情報)と半角スペース(単語区切りの情報)は、
// jraPdfJoinRowItems()が実測ギャップから慎重に判定した信頼度の高い区切り情報のため、
// 一律`\s+`でスペース1つに潰さず、タブとスペースを別々に保ったまま連続分だけを
// 1文字に圧縮する。タブは騎手名/調教師名の境界を判定する重要なsignalのため、これを
// 握りつぶすと境界誤検出の原因になる(以前はjra-entries-pdf.js側にしか入っていなかった
// 修正。本共通化により jra-result-pdf.js 側にも同じ挙動を適用する)。
function jraPdfNormalizeLine(s) {
  return jraPdfNormalizeUnit(s).replace(/ +/g, " ").replace(/\t+/g, "\t").trim();
}

// ---------- 行内テキストの連結(ギャップ実測方式) ----------
// PDF.jsが返す個々のテキスト断片は、見た目の間隔と1対1で対応しない。直前の要素の
// 右端から今回の要素の左端までの実測ギャップを、直前要素の文字幅に対する比率で判定し、
// 「連結(区切りなし)/半角スペース/タブ(列区切り)」の3段階に振り分けて結合する。
//
// しきい値には上限キャップ(*_MAXの方)を設けている。PDF内で同一文字列(騎手名リンク等)が
// 繰り返し使われる場合、PDF生成側が描画データを使い回す(キャッシュする)ことがあり、
// これによりPDF.jsが報告する文字幅(prev.w)が実際の見た目と異なる異常値になることがある。
// 幅に比例するしきい値がこれに引きずられて際限なく大きくなると、本来検出すべき区切りを
// 見逃す可能性があるため、保険として上限を設けている(以前はjra-entries-pdf.js側にしか
// 入っていなかった対策。本共通化により jra-result-pdf.js 側にも同じ対策を適用する)。
const JRA_PDF_GAP_SPACE_RATIO = 0.3;
const JRA_PDF_GAP_TAB_RATIO = 1.2;
const JRA_PDF_GAP_SPACE_MIN = 1.0;
const JRA_PDF_GAP_TAB_MIN = 6.0;
const JRA_PDF_GAP_SPACE_MAX = 3.5; // これを超える幅比例しきい値は採用しない(保険)
const JRA_PDF_GAP_TAB_MAX = 14.0;

function jraPdfJoinRowItems(items) {
  let text = "";
  const gaps = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (i > 0) {
      const prev = items[i - 1];
      const gap = item.x - (prev.x + (prev.w || 0));
      const spaceThreshold = Math.min(Math.max((prev.w || 0) * JRA_PDF_GAP_SPACE_RATIO, JRA_PDF_GAP_SPACE_MIN), JRA_PDF_GAP_SPACE_MAX);
      const tabThreshold = Math.min(Math.max((prev.w || 0) * JRA_PDF_GAP_TAB_RATIO, JRA_PDF_GAP_TAB_MIN), JRA_PDF_GAP_TAB_MAX);
      let sep = "";
      if (gap > tabThreshold) sep = "\t";
      else if (gap > spaceThreshold) sep = " ";
      text += sep;
      gaps.push({
        gap: Math.round(gap * 100) / 100,
        sep: sep === "\t" ? "TAB" : (sep === " " ? "SPACE" : "連結"),
        prevWidth: Math.round((prev.w || 0) * 100) / 100,
        prevStr: prev.str,
        curStr: item.str,
      });
    }
    text += item.str;
  }
  return { text, gaps };
}

// レース条件詳細(斤量区分・条件フラグ・回り)の抽出。
// 例: "2歳 未勝利（混合）［指定］ 馬齢 コース：1,600メートル（芝・左）"
//   → weight_type="馬齢", class_flags="未勝利（混合）［指定］", course_direction="左"
// 出走馬一覧PDF・結果PDFいずれの解析ロジックからも同一の実装だったため、そのまま統合。
function jraPdfParseConditions(text) {
  const s = jraPdfNormalizeUnit(text).replace(/\s+/g, " ");
  let weight_type = null;
  const wt = s.match(/(馬齢|定量|別定|ハンデ)/);
  if (wt) weight_type = wt[1];

  let course_direction = null;
  const dir = s.match(/[（(]\s*(芝|ダート|障害)\s*[・･]\s*(左|右)\s*[)）]/);
  if (dir) course_direction = dir[2];

  // class_flags: 年齢条件〜斤量区分の手前までの生テキスト(コース情報を除く)。
  let class_flags = null;
  const cf = s.match(/^\s*(\S.*?)\s*(?:馬齢|定量|別定|ハンデ)\s*コース/);
  if (cf) class_flags = cf[1].trim() || null;

  return { weight_type, class_flags, course_direction };
}

// 天候・馬場状態の抽出。結果PDFにのみ出現する行:
// 例: "天候 晴 ダート 良" → weather="晴", track_condition="良"
// 出走馬一覧PDF側は該当行が無いため呼び出されないが、実装自体は同一だったため統合。
function jraPdfParseWeather(text) {
  const s = jraPdfNormalizeUnit(text).replace(/\s+/g, " ");
  const m = s.match(/天候\s*([^\s]+)\s*(芝|ダート|障害)\s*([^\s]+)/);
  if (!m) return { weather: null, track_condition: null };
  return { weather: m[1] || null, track_condition: m[3] || null };
}
