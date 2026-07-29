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
    let imported=0, skipped=0, duplicateCandidates=[];
    for(const row of dataRows){
      const raw={};headers.forEach((h,i)=>raw[clean(h)]=clean(row[i]));
      const raceDate=cols.raceDate>=0?normalizeDate(row[cols.raceDate]):''; const track=cols.venue>=0?normalizeTrack(row[cols.venue]):''; const raceNumber=cols.raceNumber>=0?toInt(row[cols.raceNumber]):0;
      const receipt=cols.receipt>=0?clean(row[cols.receipt]):''; const sequence=cols.sequence>=0?clean(row[cols.sequence]):''; const sourceKey=receipt&&sequence?`${receipt}:${sequence}`:JSON.stringify(raw);
      // 「合計」行などの集計行(日付・受付番号がともに空)は購入データではないためスキップする。
      if(!raceDate&&!receipt) continue;
       const type=betType(cols.betType>=0?row[cols.betType]:''); const comboText=cols.combination>=0?clean(row[cols.combination]):''; 
       const hitText=cols.hit>=0?clean(row[cols.hit]):'';
       let hitComboText='';
       if(/^的中/.test(hitText)){hitComboText=hitText.replace(/^的中/,'');}
       const totalAmount=cols.purchaseAmount>=0?parseAmount(row[cols.purchaseAmount]):0; const refund=cols.refundAmount>=0?toInt(row[cols.refundAmount]):(cols.refundUnit>=0?toInt(row[cols.refundUnit]):0); const hit=hitText;
      const existing=await db.prepare('SELECT id FROM imported_tickets WHERE source=? AND ((?<>\'\' AND receipt_number=? AND sequence_number=?) OR (?=\'\' AND raw_csv=?)) LIMIT 1').bind('club_jra_net',receipt,receipt,sequence,receipt,JSON.stringify(raw)).first();
      if(existing){skipped++;continue;}
      // Preserve raw row as the authoritative imported source record.
      const legacy=await db.prepare(`INSERT INTO imported_tickets(source,race_date,receipt_number,sequence_number,venue,race_number,bet_type,combination,purchase_amount,hit_refund,refund_unit,refund_amount,return_amount,raw_csv) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind('club_jra_net',raceDate,receipt,sequence,track,String(raceNumber||''),type,comboText,totalAmount,hit,cols.refundUnit>=0?toInt(row[cols.refundUnit]):0,refund,cols.returnAmount>=0?toInt(row[cols.returnAmount]):0,JSON.stringify(raw)).run();
      // Resolve or create the race. Entries remain empty if the CSV cannot provide them.
      let race=await db.prepare('SELECT * FROM races WHERE race_date=? AND track=? AND race_number=?').bind(raceDate,track,raceNumber).first();
      if(!race&&raceDate&&track&&raceNumber){const ins=await db.prepare('INSERT INTO races(race_date,track,race_number,race_name,entries) VALUES(?,?,?,?,?)').bind(raceDate,track,raceNumber,cols.raceName>=0?clean(row[cols.raceName]):null,'[]').run();race=await db.prepare('SELECT * FROM races WHERE id=?').bind(ins.meta.last_row_id).first();}
      const combos=splitCombinations(comboText,type); const hitCombos=splitCombinations(hitComboText,type);
      const hitKeys=new Set(hitCombos.map(a=>a.join(type==='sanrentan'?'→':'-')));
      const group=await db.prepare(`INSERT INTO imported_ticket_groups(source,source_row_id,race_id,group_key,race_date,track,race_number,race_name,bet_type,method,total_amount,total_payout,status,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind('club_jra_net',legacy.meta.last_row_id,race?.id||null,sourceKey,raceDate,track,raceNumber||null,race?.race_name||null,type,'import',totalAmount,refund||null,(refund>0||/的中|返還/.test(hit))?'settled':'unsettled',JSON.stringify(raw)).run();
      const groupId=group.meta.last_row_id; const items=combos.length?combos:[[]]; const perAmount=items.length&&totalAmount?Math.floor(totalAmount/items.length):0;
      const statements=[];
      for(const nums of items){const key=nums.join(type==='sanrentan'?'→':'-');const isHit=hitKeys.has(key)||(hit && /的中/.test(hit) && items.length===1);const inferred=inferFinish(type,nums);
        // Club JRA-Net購入履歴CSVは既に決着済みの購入履歴であり、「未確定(結果待ち)」は存在しない。
        // 的中/返還列に値がある(空でない)行は、的中buyoutならrefund、非的中なら0円確定として扱う。
        // (旧実装は非的中をnull=未確定のままにしてしまい、CSV取込分が永久に未確定表示になるバグがあった)
        const payout=hitText===''?null:(isHit?(refund||0):0);
        const statement=db.prepare(`INSERT INTO imported_ticket_items(group_id,race_id,bet_type,selections,amount,payout,is_hit,result_inferred,source_key) VALUES(?,?,?,?,?,?,?,?,?)`).bind(groupId,race?.id||null,type,JSON.stringify(selectionsFromNums(nums)),perAmount,payout,isHit?1:0,inferred?1:0,`${sourceKey}:${key}`);
        statements.push(statement);}
      if(statements.length) await db.batch(statements);
      // Add inferred 3連単 finish order only when it is unambiguous from the hit combination.
      if(race&&type==='sanrentan'&&hitCombos.length===1&&hitCombos[0].length===3){await db.prepare('UPDATE races SET finish_order=COALESCE(finish_order,?) WHERE id=?').bind(JSON.stringify(hitCombos[0]),race.id).run();}
      const dup=await db.prepare(`SELECT id,source,total_amount,race_date,track,race_number,bet_type FROM imported_ticket_groups WHERE race_date=? AND track=? AND race_number=? AND bet_type=? AND total_amount=? AND id<>? ORDER BY id DESC LIMIT 10`).bind(raceDate,track,raceNumber,type,totalAmount,groupId).all();
      if((dup.results||[]).length) duplicateCandidates.push({group_id:groupId,candidates:dup.results});
      imported++;
    }
    return Response.json({ok:true,imported,skipped,duplicate_candidates:duplicateCandidates,items:(await db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM imported_ticket_items i WHERE i.group_id=g.id) AS item_count FROM imported_ticket_groups g ORDER BY g.race_date DESC,g.id DESC`).all()).results||[]});
  }catch(error){console.error(error);return Response.json({ok:false,error:error?.message||String(error)},{status:500});}
}

export async function onRequestGet(context){
  try{
    const db=context.env.DB; const out=[];
    const groups=(await db.prepare(`SELECT * FROM imported_ticket_groups ORDER BY race_date DESC,id DESC`).all()).results||[];
    const represented=new Set();
    for(const g of groups){
      const items=(await db.prepare(`SELECT * FROM imported_ticket_items WHERE group_id=? ORDER BY id`).bind(g.id).all()).results||[];
      for(const item of items){ represented.add(Number(g.source_row_id)); out.push({id:`import-${item.id}`,imported:true,import_group_id:g.id,group_id:`import-${g.id}`,race_id:g.race_id,race_date:g.race_date,track:g.track,race_number:g.race_number,race_name:g.race_name,bet_type:g.bet_type,method:g.method,selections:JSON.parse(item.selections||'[]'),amount:item.amount,payout:item.payout,is_hit:Boolean(item.is_hit),result_inferred:Boolean(item.result_inferred),source:g.source,total_group_amount:g.total_amount}); }
    }
    // Backward compatibility: show legacy rows imported before v10 even if they have not been normalized yet.
    const legacy=(await db.prepare(`SELECT * FROM imported_tickets ORDER BY race_date DESC,id DESC`).all()).results||[];
    for(const r of legacy){ if(represented.has(Number(r.id))) continue; const type=betType(r.bet_type); const nums=splitCombinations(r.combination,type); const refund=Number(r.refund_amount||r.refund_unit||0); for(const numsOne of (nums.length?nums:[[]])) out.push({id:`legacy-import-${r.id}-${numsOne.join('-')}`,imported:true,legacy_import:true,group_id:`legacy-import-${r.id}`,race_id:null,race_date:r.race_date,track:r.venue,race_number:Number(r.race_number)||null,race_name:null,bet_type:type,method:'import',selections:selectionsFromNums(numsOne),amount:nums.length?Math.floor(Number(r.purchase_amount||0)/nums.length):Number(r.purchase_amount||0),payout:refund||null,is_hit:/的中/.test(r.hit_refund||'')||refund>0,source:r.source,total_group_amount:Number(r.purchase_amount||0)}); }
    return Response.json({ok:true,items:out});
  }catch(error){return Response.json({ok:false,error:error?.message||String(error)},{status:500});}
}
