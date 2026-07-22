// Sincroniza as respostas do formulário de NPS (Google Forms) -> evento Imersão.
// Recebe POST com um array de respostas (do Apps Script da planilha), valida o token,
// atualiza quem já existe (casa por e-mail, telefone, instagram ou nome) e cadastra quem falta.
//
// Variáveis de ambiente (painel da Vercel):
//   SUPABASE_URL              -> https://kwuuvtwriptrohwudegc.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY -> chave service_role (secreta, só no servidor)
//   NPS_TOKEN (ou CALLIL_TOKEN) -> token que valida a origem

module.exports = async (req, res) => {
  if (req.method === 'GET') return res.status(200).send('nps-sync ativo');
  if (req.method !== 'POST') return res.status(405).json({ error: 'metodo nao permitido' });

  const TOKEN = process.env.NPS_TOKEN || process.env.CALLIL_TOKEN;
  const url = new URL(req.url, 'http://localhost');
  if (!TOKEN || url.searchParams.get('token') !== TOKEN) {
    return res.status(401).json({ error: 'nao autorizado' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const rows = Array.isArray(body) ? body : (body && Array.isArray(body.rows) ? body.rows : []);
  const fase = (url.searchParams.get('fase') === 'pos') ? 'pos' : 'pre';
  const F = {
    nota:  fase === 'pos' ? 'nps_pos' : 'nps_pre',
    obs:   fase === 'pos' ? 'nps_pos_obs' : 'nps_pre_obs',
    dados: fase === 'pos' ? 'nps_pos_dados' : 'nps_pre_dados',
  };

  const SB = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

  try {
    // 1) evento Imersão
    const er = await fetch(SB + '/rest/v1/eventos?select=id&nome=ilike.*imers*&limit=1', { headers });
    const ea = await er.json();
    if (!Array.isArray(ea) || !ea.length) return res.status(200).json({ ok: false, erro: 'evento imersao nao encontrado' });
    const evId = ea[0].id;

    // 2) clientes existentes do evento
    const cr = await fetch(SB + '/rest/v1/clientes?select=id,nome,email,telefone,instagram&evento_id=eq.' + evId, { headers });
    const existentes = await cr.json();
    const byEmail = {}, byTel = {}, byIg = {}, byNome = {};
    (existentes || []).forEach(c => {
      const e = String(c.email || '').trim().toLowerCase();
      if (e) byEmail[e] = c.id;
      const t = telnorm(c.telefone); if (t) byTel[t] = c.id;
      const g = iguser(c.instagram); if (g) byIg[g] = c.id;
      const n = norm(c.nome); if (n) byNome[n] = c.id;
    });

    let atualizados = 0;
    const novos = [];
    for (const row of rows) {
      const nome = String(row.nome || '').trim();
      if (!nome || norm(nome) === 'teste') continue;
      const email = String(row.email || '').trim();
      const tel = String(row.telefone || '').trim();
      const ig = String(row.instagram || '').trim();
      const id = byEmail[email.toLowerCase()] || byTel[telnorm(tel)] || byIg[iguser(ig)] || byNome[norm(nome)];

      const patch = {};
      patch[F.nota] = (row.nota === '' || row.nota === null || row.nota === undefined) ? null : parseInt(row.nota);
      patch[F.obs] = String(row.obs || '');
      patch[F.dados] = row.dados || {};
      patch.atualizado_em = new Date().toISOString();

      if (id) {
        const alvo = (existentes || []).find(c => c.id === id) || {};
        if (!String(alvo.email || '').trim() && email) patch.email = email;
        if (!String(alvo.instagram || '').trim() && ig) patch.instagram = ig;
        const r = await fetch(SB + '/rest/v1/clientes?id=eq.' + id, { method: 'PATCH', headers, body: JSON.stringify(patch) });
        if (r.ok) atualizados++;
      } else {
        novos.push(Object.assign({
          nome, email, telefone: tel, instagram: ig,
          lista: 'novos', status: 'confirmou', tentativas: 0, evento_id: evId,
        }, patch));
        // evita duplicar dentro do mesmo lote
        if (email) byEmail[email.toLowerCase()] = 'novo';
        if (telnorm(tel)) byTel[telnorm(tel)] = 'novo';
        byNome[norm(nome)] = 'novo';
      }
    }

    if (novos.length) {
      const r = await fetch(SB + '/rest/v1/clientes', {
        method: 'POST', headers: Object.assign({}, headers, { Prefer: 'return=minimal' }), body: JSON.stringify(novos),
      });
      if (!r.ok) { const t = await r.text(); return res.status(200).json({ ok: false, erro: t, atualizados }); }
    }
    return res.status(200).json({ ok: true, fase, recebidos: rows.length, atualizados, criados: novos.length });
  } catch (err) {
    return res.status(200).json({ ok: false, erro: String(err) });
  }
};

function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}
function telnorm(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.length > 11 && d.slice(0, 2) === '55') d = d.slice(2);
  return d;
}
function iguser(s) {
  return String(s || '').toLowerCase().replace('@', '').replace(/[^a-z0-9._]/g, '');
}
