// Sincroniza clientes da planilha do Google -> evento "Alessandro Callil".
// Recebe POST com um array de linhas (do Apps Script da planilha), valida o token,
// e insere só os clientes que ainda não existem nesse evento (incremental, sem apagar).
//
// Variáveis de ambiente (painel da Vercel):
//   SUPABASE_URL              -> https://kwuuvtwriptrohwudegc.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY -> chave service_role (secreta, só no servidor)
//   CALLIL_TOKEN              -> token que valida a origem (mesmo do Apps Script)

module.exports = async (req, res) => {
  if (req.method === 'GET') return res.status(200).send('callil-sync ativo');
  if (req.method !== 'POST') return res.status(405).json({ error: 'metodo nao permitido' });

  const url = new URL(req.url, 'http://localhost');
  if (!process.env.CALLIL_TOKEN || url.searchParams.get('token') !== process.env.CALLIL_TOKEN) {
    return res.status(401).json({ error: 'nao autorizado' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const rows = Array.isArray(body) ? body : (body && Array.isArray(body.rows) ? body.rows : []);

  const SB = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

  try {
    // 1) Descobre o id do evento Callil
    let evId = null;
    const er = await fetch(SB + '/rest/v1/eventos?select=id&nome=ilike.*callil*&limit=1', { headers });
    const ea = await er.json();
    if (Array.isArray(ea) && ea.length) evId = ea[0].id;
    if (!evId) return res.status(200).json({ ok: false, erro: 'evento callil nao encontrado' });

    // 2) Carrega quem já existe nesse evento (pra não duplicar)
    const existEmails = new Set(), existPhones = new Set();
    const r = await fetch(SB + '/rest/v1/clientes?select=email,telefone&evento_id=eq.' + evId, { headers });
    const a = await r.json();
    (a || []).forEach(c => {
      if (c.email) existEmails.add(String(c.email).trim().toLowerCase());
      if (c.telefone) existPhones.add(onlyDigits(c.telefone));
    });

    // 3) Monta só os novos
    const novos = [];
    for (const row of rows) {
      const nome = (row.nome || '').trim();
      if (!nome) continue;
      const email = (row.email || '').trim();
      const tel = (row.telefone || '').trim();
      const e = email.toLowerCase(), p = onlyDigits(tel);
      if (e && existEmails.has(e)) continue;
      if (!e && p && existPhones.has(p)) continue;
      const nota = [(row.obs || '').trim(), (row.valor || '').trim()].filter(Boolean).join(' · ');
      novos.push({
        nome, telefone: tel, email,
        produto: (row.categoria || '').trim(),
        lista: 'confirmacao', status: 'boas_vindas', tentativas: 0,
        observacao: nota, evento_id: evId, atualizado_em: new Date().toISOString(),
      });
      if (e) existEmails.add(e);
      if (p) existPhones.add(p);
    }

    // 4) Insere
    if (novos.length) {
      const ins = await fetch(SB + '/rest/v1/clientes', {
        method: 'POST', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify(novos),
      });
      if (!ins.ok) { const t = await ins.text(); return res.status(200).json({ ok: false, erro: t }); }
    }
    return res.status(200).json({ ok: true, inseridos: novos.length, recebidos: rows.length });
  } catch (err) {
    return res.status(200).json({ ok: false, erro: String(err) });
  }
};

function onlyDigits(s) { return String(s || '').replace(/\D/g, ''); }
