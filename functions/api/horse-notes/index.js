export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const raceId = Number(url.searchParams.get("race_id"));
  if (!Number.isInteger(raceId) || raceId <= 0) return Response.json({ error: "race_idが必要です" }, { status: 400 });
  const race = await env.DB.prepare("SELECT entries FROM races WHERE id = ?").bind(raceId).first();
  if (!race) return Response.json({ error: "レースが見つかりません" }, { status: 404 });
  let entries=[]; try { entries=JSON.parse(race.entries||"[]"); } catch {}
  const normalize = (v) => String(v ?? "").replace(/[\u3000\s]+/g, " ").trim();
  const names=[...new Set(entries.map(e=>normalize(e?.horse_name)).filter(Boolean))];
  if (!names.length) return Response.json({});
  const placeholders=names.map(()=>"?").join(",");
  const result=await env.DB.prepare(`SELECT horse_name,memo,updated_at FROM horse_notes WHERE horse_name IN (${placeholders})`).bind(...names).all();
  const out={}; for(const row of result.results||[]) out[row.horse_name]={memo:row.memo||"",updated_at:row.updated_at||null};
  return Response.json(out);
}

export async function onRequestPost(context) {
  const { request, env }=context; let data; try{data=await request.json();}catch{return Response.json({error:"リクエストが不正です"},{status:400});}
  const horseName=String(data?.horse_name||"").replace(/[\u3000\s]+/g, " ").trim(); const memo=String(data?.memo||"").trim();
  if(!horseName) return Response.json({error:"horse_nameが必要です"},{status:400});
  if(horseName.length>200) return Response.json({error:"馬名が長すぎます"},{status:400});
  if(memo.length>5000) return Response.json({error:"メモは5000文字以内です"},{status:400});
  const now=new Date().toISOString();
  await env.DB.prepare(`INSERT INTO horse_notes (horse_name,memo,created_at,updated_at) VALUES (?,?,?,?) ON CONFLICT(horse_name) DO UPDATE SET memo=excluded.memo,updated_at=excluded.updated_at`).bind(horseName,memo,now,now).run();
  return Response.json({ok:true,horse_name:horseName,memo,updated_at:now});
}
