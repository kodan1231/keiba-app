function decodeCsv(buffer) {
  const bytes = new Uint8Array(buffer);
  try { return new TextDecoder("shift_jis").decode(bytes); } catch { return new TextDecoder("utf-8").decode(bytes); }
}
function parseCsv(text) {
  const rows=[]; let row=[], field="", quoted=false;
  for(let i=0;i<text.length;i++){ const c=text[i], n=text[i+1];
    if(quoted){ if(c==='"'&&n==='"'){field+='"';i++;} else if(c==='"') quoted=false; else field+=c; continue; }
    if(c==='"') quoted=true; else if(c===','){row.push(field);field='';}
    else if(c==='\r'&&n==='\n'){row.push(field);rows.push(row);row=[];field='';i++;}
    else if(c==='\n'||c==='\r'){row.push(field);rows.push(row);row=[];field='';}
    else field+=c;
  }
  if(field.length||row.length){row.push(field);rows.push(row);} return rows.filter(r=>r.some(v=>String(v).trim()!==''));
}
const clean=v=>String(v??"").replace(/^\uFEFF/,'').trim();
const normalizeHeader=v=>clean(v).replace(/\s+/g,'').replace(/[（）()]/g,'');
const findColumn=(headers,candidates)=>{const hs=headers.map(normalizeHeader);for(const c of candidates){const i=hs.indexOf(normalizeHeader(c));if(i>=0)return i;}return -1;};
const toInt=v=>{const n=Number(String(v??'').replace(/[,\s円]/g,''));return Number.isFinite(n)?Math.trunc(n):0;};
// BOX/ながし等の購入金額列は「単価／合計」の複合表記になることがある(例: "200／3600")。
// この場合は合計(末尾の値)を購入金額として採用する。
const parseAmount=v=>{const s=clean(v); if(!s) return 0; if(s.includes('／')||s.includes('/')){const parts=s.split(/[／\/]/).map(toInt); return parts[parts.length-1]||0;} return toInt(s);};
const normalizeTrack=v=>clean(v).replace(/競馬場$/,'');
// races.race_date は YYYY-MM-DD 形式で保存する前提のため、CSVの日付表記を正規化する。
// Club JRA-Net等のCSVでは区切りなしの YYYYMMDD 形式で出力されることがあり、
// そのまま保存すると画面側の new Date() で Invalid Date になる。
function normalizeDate(v){
  const s=clean(v);
  if(!s) return s;
  let m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if(m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  m=s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if(m) return `${m[1]}-${m[2]}-${m[3]}`;
  m=s.match(/^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})$/);
  if(m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  m=s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  if(m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  return s; // 未知の形式はそのまま(手動修正できるよう画面側で確認可能)
}
const BET_MAP={"単勝":"tan","複勝":"fuku","枠連":"wakuren","馬連":"umaren","馬単":"umatan","ワイド":"wide","三連複":"sanrenpuku","3連複":"sanrenpuku","三連単":"sanrentan","3連単":"sanrentan"};
function betType(v){const s=clean(v);return BET_MAP[s]||Object.entries(BET_MAP).find(([k])=>s.includes(k))?.[1]||s||'unknown';}
function ordered(type){return type==='umatan'||type==='sanrentan';}
// 馬番区切り文字はCSVの出力元によって表記ゆれがある(半角ハイフン「-」、
// 全角ハイフン「－」、水平線「―」、ハイフン各種「‐‑–—」など)ため、まとめて許容する。
function parseNumbers(s){return clean(s).replace(/[()（）]/g,'').split(/\s*(?:→|->|＞|>|,|、|;|；|[\-－―‐‑–—]|\s)\s*/).map(x=>Number(x)).filter(Number.isInteger).filter(n=>n>0);}
function comboSize(type){return type==='tan'||type==='fuku'?1:type==='wakuren'||type==='umaren'||type==='wide'||type==='umatan'?2:3;}
function kCombinations(arr,k){
  const out=[]; const combo=[];
  const recurse=(start)=>{ if(combo.length===k){out.push(combo.slice());return;} for(let i=start;i<arr.length;i++){combo.push(arr[i]);recurse(i+1);combo.pop();} };
  recurse(0); return out;
}
function permutations(arr){
  if(arr.length<=1) return [arr.slice()];
  const out=[];
  for(let i=0;i<arr.length;i++){ const rest=arr.slice(0,i).concat(arr.slice(i+1)); for(const p of permutations(rest)) out.push([arr[i],...p]); }
  return out;
}
function dedupeCombos(list){
  const seen=new Set(); const out=[];
  for(const c of list){ const key=c.join(','); if(seen.has(key)) continue; seen.add(key); out.push(c); }
  return out;
}
// CSVの「馬／組番」列を実際の買い目(馬番配列)へ展開する。対応パターン:
//   - 単一/複数の明示的な組み合わせ (例: "01―03" / "01―02;03―04")
//   - 全角スラッシュ区切りのフォーメーション(群数が式別の点数と一致): 各群から1頭ずつ選ぶ直積
//   - 全角スラッシュ区切りの軸ながし(群数2・軸+相手群): 相手群から不足分を選んで軸と組み合わせ
//     (「マルチ」等、着順を問わない式別では全順列を生成する)
//   - スラッシュなしのセミコロン区切りのみ(BOX): 全馬番からのC(n,式別の点数)
function splitCombinations(text,type){
  const raw=clean(text); if(!raw)return [];
  const size=comboSize(type);
  const isOrdered=ordered(type);
  if(size<2) return raw?[[Number(clean(raw).replace(/\D/g,''))]].filter(c=>Number.isInteger(c[0])&&c[0]>0):[];

  if(raw.includes('／')||raw.includes('/')){
    const groups=raw.split(/[／\/]/).map(part=>parseNumbers(part)).filter(g=>g.length>0);
    if(groups.length===size){
      // フォーメーション: 各群から1頭ずつ、同一組み合わせ内で重複しないように選ぶ
      const out=[];
      const recurse=(i,current)=>{
        if(i===groups.length){ out.push(current.slice()); return; }
        for(const n of groups[i]){ if(current.includes(n)) continue; current.push(n); recurse(i+1,current); current.pop(); }
      };
      recurse(0,[]);
      const normalized=isOrdered?out:out.map(c=>c.slice().sort((a,b)=>a-b));
      if(normalized.length) return dedupeCombos(normalized);
    } else if(groups.length===2){
      // 軸(1頭以上)+相手群のながし。相手群から不足分を選んで軸と組み合わせる。
      const [axisGroup,partnerGroup]=groups;
      const need=size-axisGroup.length;
      if(need>0&&need<=partnerGroup.length){
        const picks=kCombinations(partnerGroup,need);
        let combos=picks.map(p=>[...axisGroup,...p]);
        combos=isOrdered?combos.flatMap(c=>permutations(c)):combos.map(c=>c.slice().sort((a,b)=>a-b));
        if(combos.length) return dedupeCombos(combos);
      }
    }
  }

  // セミコロン区切り: 個々の組み合わせが明示されている場合と、
  // スラッシュなしのBOX(全馬番の羅列)の場合がある。
  const partsSemi=raw.split(/[;；\n]+/).map(clean).filter(Boolean);
  const explicitCombos=[]; const flatNums=[];
  for(const part of partsSemi){
    const nums=parseNumbers(part); if(!nums.length) continue;
    if(nums.length===size){ explicitCombos.push(nums); continue; }
    if(nums.length>size){ for(let i=0;i+size<=nums.length;i+=size) explicitCombos.push(nums.slice(i,i+size)); continue; }
    flatNums.push(...nums);
  }
  if(explicitCombos.length) return explicitCombos;
  if(flatNums.length>=size){
    const uniq=[...new Set(flatNums)];
    let combos=kCombinations(uniq,size);
    combos=isOrdered?combos.flatMap(c=>permutations(c)):combos.map(c=>c.slice().sort((a,b)=>a-b));
    return dedupeCombos(combos);
  }
  return [];
}
function selectionsFromNums(nums){return nums.map(horse_number=>({horse_number}));}
function inferFinish(type, nums){return type==='sanrentan'&&nums.length===3?nums:null;}

// 「的中／返還」列は、1行に複数の的中組み合わせがある場合(BOX・ながし等で複数点的中)、
// "的中02―05／的中02―09／的中05―09" のように「的中」を各組み合わせの前に繰り返して
// ／(全角スラッシュ)で連結する。これを的中組み合わせ1件ごとに分解する。
// (以前は先頭の「的中」だけを取り除いていたため、2件目以降の組み合わせに「的中」の
//  文字が残ったまま数値解析され、一部の的中組み合わせが正しく認識されないバグがあった)
function splitHitSegments(hitText){
  if(!/^的中/.test(hitText)) return [];
  return hitText.split(/[／\/]/).map(s=>clean(s).replace(/^的中/,'')).map(clean).filter(Boolean);
}
// 「払戻単価」列も的中組み合わせと同じ並び順で／連結される(例: "800／680／650")。
// 100円あたりの払戻額(レート)なので、各組み合わせの購入金額に応じて実際の払戻額を計算する。
function splitRefundUnits(refundUnitText){
  const s=clean(refundUnitText); if(!s) return [];
  return s.split(/[／\/]/).map(toInt);
}
// 的中組み合わせごとの払戻額(rate=100円あたりの払戻)を Map<comboKey, rate> として組み立てる。
// 組み合わせ数と払戻単価の数が一致しない場合(想定外の表記ゆれ)は、安全側に倒して
// 空Mapを返し、呼び出し側で従来通りの一括判定にフォールバックする。
function buildHitRateMap(hitText, refundUnitText, type){
  const segments=splitHitSegments(hitText);
  if(!segments.length) return { map: new Map(), hitCombos: [] };
  const rates=splitRefundUnits(refundUnitText);
  const keyOf=(nums)=>nums.join(type==='sanrentan'?'→':'-');
  const hitCombos=[];
  const map=new Map();
  const sizeOk = rates.length === segments.length;
  segments.forEach((seg,i)=>{
    const nums=parseNumbers(seg);
    const size=comboSize(type);
    if(nums.length!==size) return; // 解析できない断片は無視する
    const combo = ordered(type) ? nums : nums.slice().sort((a,b)=>a-b);
    hitCombos.push(combo);
    if(sizeOk) map.set(keyOf(combo), rates[i]);
  });
  return { map, hitCombos };
}

// races.finish_order (JSON配列, 例: [3,1,7]) の現在値と、今回の行から分かった
// 着順情報(1件のみ的中かつ順序が一意に定まる場合のみ)をマージする。
// sanrentan(3着まで確定)を最も信頼できる情報源として扱い、他の情報で上書きしない。
// tan(1着のみ)・umatan(1・2着)は、まだ何も分かっていない着順スロットのみを埋める。
function mergeFinishOrder(existingJson, type, hitCombos){
  if(hitCombos.length!==1) return null;
  const combo=hitCombos[0];
  let partial=null, authoritative=false;
  if(type==='sanrentan'&&combo.length===3){ partial=combo; authoritative=true; }
  else if(type==='umatan'&&combo.length===2){ partial=combo; }
  else if(type==='tan'&&combo.length===1){ partial=combo; }
  if(!partial) return null;

  let existing=null;
  try{ const parsed=existingJson?JSON.parse(existingJson):null; if(Array.isArray(parsed)) existing=parsed; }catch{}
  const merged=existing?existing.slice():[];
  let changed=false;
  for(let i=0;i<partial.length;i++){
    if(authoritative || merged[i]===undefined || merged[i]===null){
      if(merged[i]!==partial[i]){ merged[i]=partial[i]; changed=true; }
    }
  }
  return changed?merged:null;
}

// races.payouts (JSON, 例: {"wide":[{"combo":[2,9],"rate":680}, ...]}) へ、
// 今回の行で分かった的中組み合わせごとの払戻レート(100円あたり)をマージする。
// 同じ式別・同じ組み合わせが既にあれば新しい値で上書きし、無ければ追加する。
function mergePayouts(existingJson, type, hitCombos, hitRateMap){
  if(!hitCombos.length||!hitRateMap.size) return null;
  let payouts={};
  try{ const parsed=existingJson?JSON.parse(existingJson):{}; if(parsed&&typeof parsed==='object') payouts=parsed; }catch{}
  const list=Array.isArray(payouts[type])?payouts[type].slice():[];
  const byKey=new Map(list.map(c=>[JSON.stringify(c.combo),c]));
  let changed=false;
  for(const combo of hitCombos){
    const key=combo.join(type==='sanrentan'?'→':'-');
    if(!hitRateMap.has(key)) continue;
    const rate=hitRateMap.get(key);
    const comboKey=JSON.stringify(combo);
    const current=byKey.get(comboKey);
    if(!current||current.rate!==rate){ byKey.set(comboKey,{combo,rate}); changed=true; }
  }
  if(!changed) return null;
  payouts[type]=Array.from(byKey.values());
  return payouts;
}

export async function onRequestPost(context){
  try{
    const form=await context.request.formData(); const file=form.get('file');
    if(!file||typeof file.arrayBuffer!=='function') return Response.json({ok:false,error:'CSVファイルが指定されていません。'},{status:400});
    const rows=parseCsv(decodeCsv(await file.arrayBuffer())); if(rows.length<2)return Response.json({ok:false,error:'CSVにデータ行がありません。'},{status:400});
    const headers=rows[0], dataRows=rows.slice(1);
    const cols={
      raceDate:findColumn(headers,['日付','購入日','開催日']), receipt:findColumn(headers,['受付番号']), sequence:findColumn(headers,['通番']), venue:findColumn(headers,['場名','競馬場']), raceNumber:findColumn(headers,['レース','レース番号']), raceName:findColumn(headers,['レース名']), betType:findColumn(headers,['式別','式別名称']), combination:findColumn(headers,['馬／組番','馬/組番','馬組番','組番','買い目']), purchaseAmount:findColumn(headers,['購入金額','購入額']), hit:findColumn(headers,['的中／返還','的中/返還','的中']), refundUnit:findColumn(headers,['払戻単価']), refundAmount:findColumn(headers,['払戻金額','払戻']), returnAmount:findColumn(headers,['返還金額','返還']), hitCombination:findColumn(headers,['的中買い目','的中組合せ','的中組み合わせ'])
    };
    const db=context.env.DB; if(!db)return Response.json({ok:false,error:'D1 binding が見つかりません。'},{status:500});
    const userId=context.data.userId;
    let imported=0, skipped=0, conflicted=0;
    // 2026-08-04: imported_ticket_groups の一意制約(uq_imported_group_source_key)は
    // user_id を含まない設計(docs/DESIGN.md「CSV取込の仕様」参照)。本アプリは同じ
    // JRA-Netアカウントを複数ユーザーが共有する想定をしていないため、通常は起こらないが、
    // 万が一 group_key が別ユーザーの既存データと衝突した場合はUNIQUE制約違反となる。
    // 従来はこれが未ハンドリングのままリクエスト全体を500エラーで中断させていたため、
    // 該当行だけをスキップしてconflictedとして数え、他の行の取込は継続するようにする。
    const conflicts=[];

    // 以前はCSVの行ごとに「既存チェック」「重複候補検出」を個別クエリしており、
    // レース参照(SELECT/INSERT)も行ごとに発行していたため、行数の多いCSVを取り込むと
    // Cloudflare Workersのサブリクエスト数上限(1リクエストあたりのD1呼び出し数)に
    // 抵触して「Too many API requests by single Worker invocation」エラーになっていた
    // (2026-07-31)。既存チェックはリクエスト開始時に1回だけ取得してメモリ上で照合し、
    // 同一レースへの参照は初回のみDBに問い合わせてキャッシュし、重複候補検出は
    // 全行の取込完了後に1回だけ行うように変更する。
    // 2026-08-01: 複数ユーザー対応により、既存チェック・重複候補検出はいずれも
    // ログインユーザー自身のデータのみを対象にする(他ユーザーのCSVとは重複判定しない)。
    const existingRows=(await db.prepare(`SELECT race_date, receipt_number, sequence_number, raw_csv FROM imported_tickets WHERE source=? AND user_id=?`).bind('club_jra_net',userId).all()).results||[];
    const existingKeyed=new Set(); const existingRaw=new Set();
    for(const r of existingRows){ if(r.receipt_number) existingKeyed.add(`${r.race_date}:${r.receipt_number}:${r.sequence_number}`); else existingRaw.add(r.raw_csv); }
    const raceCache=new Map(); // key: `${race_date}|${track}|${race_number}` -> race row | null
    const newGroups=[]; // このリクエストで新規作成したグループ({groupId, race_date, track, race_number, bet_type, total_amount})

    for(const row of dataRows){
      const raw={};headers.forEach((h,i)=>raw[clean(h)]=clean(row[i]));
      const raceDate=cols.raceDate>=0?normalizeDate(row[cols.raceDate]):''; const track=cols.venue>=0?normalizeTrack(row[cols.venue]):''; const raceNumber=cols.raceNumber>=0?toInt(row[cols.raceNumber]):0;
      const receipt=cols.receipt>=0?clean(row[cols.receipt]):''; const sequence=cols.sequence>=0?clean(row[cols.sequence]):'';
      // 受付番号は日付をまたいで再利用されることがあるため(例: 開催日ごとに0001から採番)、
      // 日付を含めないキーだと別日の正当なデータが誤って重複扱いされ、スキップされてしまう。
      const sourceKey=receipt&&sequence?`${raceDate}:${receipt}:${sequence}`:JSON.stringify(raw);
      // 「合計」行などの集計行(日付・受付番号がともに空)は購入データではないためスキップする。
      if(!raceDate&&!receipt) continue;
       const type=betType(cols.betType>=0?row[cols.betType]:''); const comboText=cols.combination>=0?clean(row[cols.combination]):''; 
       const hitText=cols.hit>=0?clean(row[cols.hit]):'';
       const refundUnitText=cols.refundUnit>=0?clean(row[cols.refundUnit]):'';
       const totalAmount=cols.purchaseAmount>=0?parseAmount(row[cols.purchaseAmount]):0; const refund=cols.refundAmount>=0?toInt(row[cols.refundAmount]):(cols.refundUnit>=0?toInt(row[cols.refundUnit]):0); const hit=hitText;
       // 的中組み合わせごとの払戻レート(100円あたり)。複数的中でも組み合わせごとに正しく対応付ける。
       const { map: hitRateMap, hitCombos } = buildHitRateMap(hitText, refundUnitText, type);
      const isDup = receipt&&sequence ? existingKeyed.has(sourceKey) : existingRaw.has(sourceKey);
      if(isDup){skipped++;continue;}
      // Preserve raw row as the authoritative imported source record.
      const legacy=await db.prepare(`INSERT INTO imported_tickets(user_id,source,race_date,receipt_number,sequence_number,venue,race_number,bet_type,combination,purchase_amount,hit_refund,refund_unit,refund_amount,return_amount,raw_csv) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(userId,'club_jra_net',raceDate,receipt,sequence,track,String(raceNumber||''),type,comboText,totalAmount,hit,cols.refundUnit>=0?toInt(row[cols.refundUnit]):0,refund,cols.returnAmount>=0?toInt(row[cols.returnAmount]):0,JSON.stringify(raw)).run();
      // 同一CSV内に同じ行が複数回含まれるケースにも対応できるよう、取込直後にメモリ上の
      // 既存チェック用セットへも反映しておく。
      if(receipt&&sequence) existingKeyed.add(sourceKey); else existingRaw.add(sourceKey);
      // レースを参照する。2026-08-01より、レースの新規登録は管理者のみが行える方針になった
      // ため、CSV取込側での自動作成(該当レースが無ければINSERTする処理)は廃止した。
      // 該当レースが未登録の場合は race_id を null のまま取り込み、日付・競馬場・
      // レース番号・レース名はグループ側にそのまま保持する(管理者向けの「未登録レース一覧」
      // 画面から、後日そのレースが登録されれば紐付く)。
      const raceKey=`${raceDate}|${track}|${raceNumber}`;
      let race=raceCache.has(raceKey)?raceCache.get(raceKey):undefined;
      if(race===undefined){
        race=(raceDate&&track&&raceNumber)?await db.prepare('SELECT * FROM races WHERE race_date=? AND track=? AND race_number=?').bind(raceDate,track,raceNumber).first():null;
        raceCache.set(raceKey,race||null);
      }
      const raceNameForGroup=cols.raceName>=0?clean(row[cols.raceName]):null;
      const combos=splitCombinations(comboText,type);
      const hitKeys=new Set(hitCombos.map(a=>a.join(type==='sanrentan'?'→':'-')));
      let group;
      try{
        group=await db.prepare(`INSERT INTO imported_ticket_groups(user_id,source,source_row_id,race_id,group_key,race_date,track,race_number,race_name,bet_type,method,total_amount,total_payout,status,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(userId,'club_jra_net',legacy.meta.last_row_id,race?.id||null,sourceKey,raceDate,track,raceNumber||null,race?.race_name||raceNameForGroup,type,'import',totalAmount,refund||null,(refund>0||/的中|返還/.test(hit))?'settled':'unsettled',JSON.stringify(raw)).run();
      }catch(insertError){
        const msg=insertError?.message||String(insertError);
        if(/UNIQUE constraint failed/i.test(msg)){
          // group_keyが別ユーザーの既存データと衝突。CSV原本(imported_tickets)は既に
          // 保存済みだが、正規化後のグループ・買い目は作成できないため、この行はスキップして
          // 他の行の取込を継続する。原因不明のエラーとして見えないよう、分かりやすい理由を添える。
          conflicted++;
          conflicts.push({race_date:raceDate,track,race_number:raceNumber||null,bet_type:type,combination:comboText,reason:'別のユーザーが登録済みのデータと衝突したため、この行は取り込めませんでした。'});
          continue;
        }
        throw insertError;
      }
      const groupId=group.meta.last_row_id; const items=combos.length?combos:[[]]; const perAmount=items.length&&totalAmount?Math.floor(totalAmount/items.length):0;
      const statements=[];
      for(const nums of items){const key=nums.join(type==='sanrentan'?'→':'-');const isHit=hitKeys.has(key)||(hit && /的中/.test(hit) && items.length===1);const inferred=inferFinish(type,nums);
        // Club JRA-Net購入履歴CSVは既に決着済みの購入履歴であり、「未確定(結果待ち)」は存在しない。
        // 的中/返還列に値がある(空でない)行は、的中買い目はrefundを、非的中買い目は0円をpayoutとする。
        // 的中買い目の払戻額は、組み合わせごとの払戻レート(100円あたり)×その買い目の購入金額で計算する。
        // (以前は1行に複数の的中組み合わせがある場合、組み合わせを区別せず行全体のrefundを1件だけに
        //  誤って計上していたため、複数点的中時に金額が合わなくなるバグがあった)
        // レートが個別に取得できない場合は、的中1件のみなら従来通りrefund全額、複数件なら均等割りにフォールバックする。
        let payout=null;
        if(hitText!==''){
          if(isHit){
            if(hitRateMap.has(key)) payout=Math.round((perAmount/100)*hitRateMap.get(key));
            else if(hitCombos.length<=1) payout=refund||0;
            else payout=Math.round((refund||0)/hitCombos.length);
          } else {
            payout=0;
          }
        }
        const statement=db.prepare(`INSERT INTO imported_ticket_items(group_id,race_id,bet_type,selections,amount,payout,is_hit,result_inferred,source_key) VALUES(?,?,?,?,?,?,?,?,?)`).bind(groupId,race?.id||null,type,JSON.stringify(selectionsFromNums(nums)),perAmount,payout,isHit?1:0,inferred?1:0,`${sourceKey}:${key}`);
        statements.push(statement);}
      if(statements.length) await db.batch(statements);
      // CSV取込結果のうち、着順が一意に定まる情報(単勝1着/馬単1・2着/三連単3着まで)は
      // races.finish_order へ、的中組み合わせごとの払戻レートは races.payouts へ反映する。
      if(race){
        const newFinishOrder=mergeFinishOrder(race.finish_order,type,hitCombos);
        const newPayouts=mergePayouts(race.payouts,type,hitCombos,hitRateMap);
        if(newFinishOrder||newPayouts){
          await db.prepare('UPDATE races SET finish_order=?, payouts=? WHERE id=?')
            .bind(
              newFinishOrder?JSON.stringify(newFinishOrder):race.finish_order,
              newPayouts?JSON.stringify(newPayouts):race.payouts,
              race.id
            ).run();
          // 同一レースの後続行を処理する際に最新状態を参照できるよう、キャッシュ上の race も更新しておく。
          if(newFinishOrder) race.finish_order=JSON.stringify(newFinishOrder);
          if(newPayouts) race.payouts=JSON.stringify(newPayouts);
          raceCache.set(raceKey,race);
        }
      }
      newGroups.push({groupId,race_date:raceDate,track,race_number:raceNumber,bet_type:type,total_amount:totalAmount});
      imported++;
    }
    // 重複候補の検出は、以前は新規グループ挿入のたびに個別クエリしていたが、
    // 全行の取込完了後に1回のクエリでまとめて行う。ユーザー自身のグループのみを対象にする。
    let duplicateCandidates=[];
    if(newGroups.length){
      const allGroups=(await db.prepare(`SELECT id,source,total_amount,race_date,track,race_number,bet_type FROM imported_ticket_groups WHERE user_id=?`).bind(userId).all()).results||[];
      const byKey=new Map();
      for(const g of allGroups){ const k=`${g.race_date}|${g.track}|${g.race_number}|${g.bet_type}|${g.total_amount}`; const list=byKey.get(k)||[]; list.push(g); byKey.set(k,list); }
      for(const ng of newGroups){
        const k=`${ng.race_date}|${ng.track}|${ng.race_number}|${ng.bet_type}|${ng.total_amount}`;
        const candidates=(byKey.get(k)||[]).filter(g=>g.id!==ng.groupId).sort((a,b)=>b.id-a.id).slice(0,10);
        if(candidates.length) duplicateCandidates.push({group_id:ng.groupId,candidates});
      }
    }
    return Response.json({ok:true,imported,skipped,conflicted,conflicts,duplicate_candidates:duplicateCandidates,items:(await db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM imported_ticket_items i WHERE i.group_id=g.id) AS item_count FROM imported_ticket_groups g WHERE g.user_id=? ORDER BY g.race_date DESC,g.id DESC`).bind(userId).all()).results||[]});
  }catch(error){console.error(error);return Response.json({ok:false,error:error?.message||String(error)},{status:500});}
}

export async function onRequestGet(context){
  try{
    const db=context.env.DB; const out=[];
    const userId=context.data.userId;
    const groups=(await db.prepare(`SELECT * FROM imported_ticket_groups WHERE user_id=? ORDER BY race_date DESC,id DESC`).bind(userId).all()).results||[];
    // 以前はグループ毎にimported_ticket_itemsを個別クエリしていたため、取込件数が増えると
    // Cloudflare Workersのサブリクエスト数上限(1リクエストあたりのD1呼び出し数)に抵触し、
    // 一覧取得自体が500エラーになっていた(2026-07-31)。全アイテムを1回のクエリで
    // まとめて取得し、メモリ上でグループごとに振り分ける方式に変更する。
    // (imported_ticket_itemsにはuser_idを持たせていないため、まず自分のgroup_idの集合を
    //  作り、それに含まれるitemsだけを対象にする)
    const groupIds=new Set(groups.map(g=>g.id));
    const allItems=(await db.prepare(`SELECT * FROM imported_ticket_items ORDER BY group_id, id`).all()).results||[];
    const itemsByGroup=new Map();
    for(const item of allItems){ if(!groupIds.has(item.group_id)) continue; const list=itemsByGroup.get(item.group_id)||[]; list.push(item); itemsByGroup.set(item.group_id,list); }
    const represented=new Set();
    for(const g of groups){
      const items=itemsByGroup.get(g.id)||[];
      for(const item of items){ represented.add(Number(g.source_row_id)); out.push({id:`import-${item.id}`,imported:true,import_group_id:g.id,group_id:`import-${g.id}`,race_id:g.race_id,race_date:g.race_date,track:g.track,race_number:g.race_number,race_name:g.race_name,bet_type:g.bet_type,method:g.method,selections:JSON.parse(item.selections||'[]'),amount:item.amount,payout:item.payout,is_hit:Boolean(item.is_hit),result_inferred:Boolean(item.result_inferred),source:g.source,total_group_amount:g.total_amount}); }
    }
    // Backward compatibility: show legacy rows imported before v10 even if they have not been normalized yet.
    const legacy=(await db.prepare(`SELECT * FROM imported_tickets WHERE user_id=? ORDER BY race_date DESC,id DESC`).bind(userId).all()).results||[];
    for(const r of legacy){ if(represented.has(Number(r.id))) continue; const type=betType(r.bet_type); const nums=splitCombinations(r.combination,type); const refund=Number(r.refund_amount||r.refund_unit||0); for(const numsOne of (nums.length?nums:[[]])) out.push({id:`legacy-import-${r.id}-${numsOne.join('-')}`,imported:true,legacy_import:true,group_id:`legacy-import-${r.id}`,race_id:null,race_date:r.race_date,track:r.venue,race_number:Number(r.race_number)||null,race_name:null,bet_type:type,method:'import',selections:selectionsFromNums(numsOne),amount:nums.length?Math.floor(Number(r.purchase_amount||0)/nums.length):Number(r.purchase_amount||0),payout:refund||null,is_hit:/的中/.test(r.hit_refund||'')||refund>0,source:r.source,total_group_amount:Number(r.purchase_amount||0)}); }
    return Response.json({ok:true,items:out});
  }catch(error){return Response.json({ok:false,error:error?.message||String(error)},{status:500});}
}
