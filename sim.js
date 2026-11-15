// Solapa "Simulador": noticias en vivo con la reacción del precio, los 3 activos con mejores señales y un simulacro
// Monte Carlo (1000 caminos) de las próximas 12/24 h, más los momentos del pasado más parecidos al actual.
// Probabilidades sacadas del comportamiento pasado: NO son garantías ni una recomendación de inversión.
(() => {
  const S = id => document.getElementById(id);
  const RAW = 'https://raw.githubusercontent.com/lordkindfyctyy/panel-de-activos/datos/noticias.json';
  const N_CAMINOS = 1000, HORAS = 24, PARECIDOS = 40;
  const escS = t => String(t ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const n2 = (v, d = 2) => (+v).toLocaleString('es-AR', {minimumFractionDigits: d, maximumFractionDigits: d});
  const pc = (v, d = 1) => (v >= 0 ? '+' : '') + n2(v, d) + '%';
  const prob = v => Math.round(v * 100) + '%';
  const precioS = p => p >= 100 ? n2(p, 2) : p >= 1 ? n2(p, 4) : p.toPrecision(4).replace('.', ',');
  const sd = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
  const mediana = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  const hace = iso => { const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 60 ? m + ' min' : m < 1440 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' d'; };
  let noticias = [], ultimoTop = 0, simActual = null;

  // ------------------------------------------------------------ datos
  async function velasHora(sym) {
    const k1 = await get('klines', {symbol: sym, interval: '1h', limit: 1000});
    const k0 = await get('klines', {symbol: sym, interval: '1h', limit: 1000, endTime: k1[0][0] - 1});
    return [...k0, ...k1].map(x => ({t: x[0], h: +x[2], l: +x[3], c: +x[4], qv: +x[7], tb: +x[10]}));
  }
  async function cargarNoticias() {
    try {
      const r = await fetch(RAW + '?t=' + Math.floor(Date.now() / 60000), {cache: 'no-store'});
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      noticias = d.noticias || [];
      S('nEstado').textContent = 'Noticias actualizadas hace ' + hace(d.actualizado) + ' · ' + (d.fuentes || []).length + ' medios';
    } catch (e) {
      S('nEstado').textContent = 'Todavía no hay noticias publicadas (' + e.message + ').';
    }
    dibujarNoticias();
  }
  function tonoNoticias(activo, horas = 6) {
    const corte = Date.now() - horas * 3600e3, peso = {alto: 3, medio: 2, bajo: 1};
    const l = noticias.filter(n => new Date(n.t) >= corte && (n.monedas || []).includes(activo));
    return {cuantas: l.length, neto: l.reduce((a, n) => a + n.tono * peso[n.nivel], 0)};
  }

  // ------------------------------------------------------------ simulación Monte Carlo
  function simular(v, objetivo) {
    const n = v.length, r = [], up = [], dn = [];
    for (let i = 1; i < n; i++) { r.push(Math.log(v[i].c / v[i - 1].c)); up.push(Math.log(v[i].h / v[i - 1].c)); dn.push(Math.log(v[i].l / v[i - 1].c)); }
    const media = r.reduce((a, b) => a + b, 0) / r.length;          // sin tendencia: no se asume que siga la del pasado
    for (let i = 0; i < r.length; i++) { r[i] -= media; up[i] -= media; dn[i] -= media; }
    const sHist = sd(r), s24 = sd(r.slice(-24)), s72 = sd(r.slice(-72));
    const escala = Math.min(3, Math.max(0.5, Math.sqrt((s24 ** 2 + s72 ** 2) / 2) / sHist));   // "el entorno de ahora"
    const p0 = v[n - 1].c, sube = objetivo >= p0, cierres = new Float64Array(N_CAMINOS * HORAS);
    let toca12 = 0, toca24 = 0, arriba24 = 0, arriba12 = 0;
    const muestras = [];
    for (let s = 0; s < N_CAMINOS; s++) {
      let p = p0, maxi = p0, mini = p0, j = 0, off = 6;
      const camino = [];
      for (let k = 0; k < HORAS; k++) {
        if (off >= 6 || j + off >= r.length) { j = Math.floor(Math.random() * (r.length - 6)); off = 0; }   // bloques de 6 h
        const idx = j + off++;
        maxi = Math.max(maxi, p * Math.exp(up[idx] * escala)); mini = Math.min(mini, p * Math.exp(dn[idx] * escala));
        p *= Math.exp(r[idx] * escala);
        cierres[s * HORAS + k] = p; camino.push(p);
        if (k === 11) { if (sube ? maxi >= objetivo : mini <= objetivo) toca12++; if (p > p0) arriba12++; }
      }
      if (sube ? maxi >= objetivo : mini <= objetivo) toca24++;
      if (p > p0) arriba24++;
      if (s < 30) muestras.push(camino);
    }
    const bandas = {p5: [], p25: [], p50: [], p75: [], p95: []};
    for (let k = 0; k < HORAS; k++) {
      const col = new Float64Array(N_CAMINOS);
      for (let s = 0; s < N_CAMINOS; s++) col[s] = cierres[s * HORAS + k];
      col.sort();
      for (const [nom, q] of [['p5', .05], ['p25', .25], ['p50', .5], ['p75', .75], ['p95', .95]]) bandas[nom].push(col[Math.floor(q * (N_CAMINOS - 1))]);
    }
    return {escala, toca12: toca12 / N_CAMINOS, toca24: toca24 / N_CAMINOS, sube12: arriba12 / N_CAMINOS, sube24: arriba24 / N_CAMINOS,
            bandas, muestras, rango12: [bandas.p5[11], bandas.p95[11]], rango24: [bandas.p5[23], bandas.p95[23]]};
  }

  // ------------------------------------------------------------ momentos parecidos del pasado
  function parecidos(v) {
    const n = v.length, c = v.map(x => x.c), r = c.map((x, i) => i ? Math.log(x / c[i - 1]) : 0);
    const rasgos = i => {
      const qv4 = v.slice(i - 3, i + 1).reduce((a, x) => a + x.qv, 0), tb4 = v.slice(i - 3, i + 1).reduce((a, x) => a + x.tb, 0);
      let bloques = 0, nb = 0;
      for (let j = i - 167; j + 3 <= i - 4; j += 4) { bloques += v.slice(j, j + 4).reduce((a, x) => a + x.qv, 0); nb++; }
      return [Math.log(c[i] / c[i - 4]), Math.log(c[i] / c[i - 24]), Math.log(qv4 / (bloques / nb || 1) || 1),
              qv4 ? tb4 / qv4 - 0.5 : 0, Math.log((sd(r.slice(i - 23, i + 1)) || 1e-9) / (sd(r.slice(i - 167, i + 1)) || 1e-9))];
    };
    const cand = [];
    for (let i = 168; i <= n - 25; i++) cand.push({i, f: rasgos(i)});
    const ahora = rasgos(n - 1), escalas = ahora.map((_, k) => sd(cand.map(x => x.f[k])) || 1);
    for (const x of cand) x.d = Math.sqrt(x.f.reduce((a, f, k) => a + ((f - ahora[k]) / escalas[k]) ** 2, 0));
    cand.sort((a, b) => a.d - b.d);
    const elegidos = [];
    for (const x of cand) {
      if (elegidos.every(e => Math.abs(e.i - x.i) >= 8)) elegidos.push(x);
      if (elegidos.length >= PARECIDOS) break;
    }
    return elegidos.map(({i}) => {
      const fut = v.slice(i + 1, i + 25);
      const mx = h => Math.max(...fut.slice(0, h).map(x => x.h)) / c[i] - 1, mn = h => Math.min(...fut.slice(0, h).map(x => x.l)) / c[i] - 1;
      return {t: v[i].t, ret12: c[i + 12] / c[i] - 1, ret24: c[i + 24] / c[i] - 1, max12: mx(12), max24: mx(24), min12: mn(12), min24: mn(24)};
    });
  }

  async function analizar(sym, objetivoManual) {
    const v = await velasHora(sym), p0 = v[v.length - 1].c, pas = parecidos(v);
    const sube24 = pas.filter(x => x.ret24 > 0).length / pas.length;
    const alcista = sube24 >= 0.5;
    // el objetivo automático sale de la mitad de los casos y se comprueba con la otra mitad (si no, siempre daría ~50 %)
    const mitadA = pas.filter((_, i) => i % 2 === 0), mitadB = pas.filter((_, i) => i % 2 === 1);
    const objetivo = objetivoManual || p0 * (1 + mediana(mitadA.map(x => alcista ? x.max24 : x.min24)));
    const rel = objetivo / p0 - 1, arriba = objetivo >= p0, prueba = objetivoManual ? pas : mitadB;
    const llego = h => prueba.filter(x => arriba ? x['max' + h] >= rel : x['min' + h] <= rel).length / prueba.length;
    const mc = simular(v, objetivo);
    return {sym, activo: sym.replace(/USDT$/, ''), v, p0, objetivo, rel, manual: !!objetivoManual, mc,
            hist: {sube24, mov24: mediana(pas.map(x => x.ret24)), llego12: llego(12), llego24: llego(24), casos: pas.length}};
  }

  // ------------------------------------------------------------ los 3 mejores
  async function armarTop3(forzar = false) {
    if (typeof datos === 'undefined' || !datos.length) { setTimeout(() => armarTop3(forzar), 3000); return; }
    if (!forzar && Date.now() - ultimoTop < 5 * 60e3) return;
    ultimoTop = Date.now();
    const cand = datos.filter(f => !isNaN(f.puntaje) && f.vol24 >= 1e7).map(f => {
      const nt = tonoNoticias(f.activo);
      const score = f.puntaje + 8 * Math.max(-3, Math.min(3, nt.neto)) + 10 * Math.tanh((f.mom1h || 0) / 1.5);
      return {...f, nt, score};
    }).sort((a, b) => b.score - a.score).slice(0, 3);
    S('top3').innerHTML = '<p class="nota">Calculando 1000 simulaciones para cada uno…</p>';
    const res = await Promise.all(cand.map(f => analizar(f.simbolo).then(a => ({f, a})).catch(() => null)));
    S('top3').innerHTML = res.filter(Boolean).map(({f, a}, i) => `
      <div class="top" data-sym="${escS(a.sym)}" title="Tocá para ver la simulación">
        <div class="fila"><span class="sim">${['🥇', '🥈', '🥉'][i]} ${escS(a.activo)}</span><span class="${f.var >= 0 ? 'up' : 'down'}">${pc(f.var, 2)} 24 h</span></div>
        <div class="precio">${precioS(a.p0)} <small>USDT</small></div>
        <div class="chico">Presión ${f.puntaje >= 0 ? '+' : ''}${Math.round(f.puntaje)} · 1 h ${pc(f.mom1h || 0, 2)} · noticias 6 h: ${f.nt.cuantas}${f.nt.cuantas ? (f.nt.neto > 0 ? ' 🟢' : f.nt.neto < 0 ? ' 🔴' : ' ⚪') : ''}</div>
        <div class="objetivo">Objetivo 24 h: <b>${precioS(a.objetivo)}</b> <span class="${a.rel >= 0 ? 'up' : 'down'}">(${pc(a.rel * 100)})</span></div>
        <div class="probs">
          <div><span>Lo toca en 12 h</span><b>${prob(a.mc.toca12)}</b><small>pasado ${prob(a.hist.llego12)}</small></div>
          <div><span>Lo toca en 24 h</span><b>${prob(a.mc.toca24)}</b><small>pasado ${prob(a.hist.llego24)}</small></div>
          <div><span>Sube en 24 h</span><b>${prob(a.hist.sube24)}</b><small>en casos parecidos</small></div>
        </div></div>`).join('') || '<p class="nota">No pude calcular ahora, reintento en un rato.</p>';
    S('top3').querySelectorAll('.top').forEach(el => el.addEventListener('click', () => { S('sActivo').value = el.dataset.sym; S('sObjetivo').value = ''; correrSimulacion(); S('sGrafico').scrollIntoView({behavior: 'smooth', block: 'center'}); }));
    if (!simActual && res[0]) { S('sActivo').value = res[0].a.sym; dibujarSimulacion(res[0].a); }
  }

  // ------------------------------------------------------------ simulador detallado
  function llenarActivos() {
    if (typeof pares === 'undefined' || !pares.length) return;
    const s = S('sActivo'), actual = s.value;
    s.innerHTML = pares.map(p => `<option value="${p}">${p.replace('USDT', ' / USDT')}</option>`).join('');
    if (pares.includes(actual)) s.value = actual;
  }
  async function correrSimulacion() {
    const sym = S('sActivo').value; if (!sym) return;
    const manual = parseFloat(String(S('sObjetivo').value).replace(/\./g, '').replace(',', '.'));
    S('sModelo').innerHTML = '<p class="nota">Simulando 1000 caminos…</p>'; S('sHistoria').innerHTML = '';
    try { dibujarSimulacion(await analizar(sym, manual > 0 ? manual : null)); }
    catch (e) { S('sModelo').innerHTML = '<p class="down">No pude simular: ' + escS(e.message) + '</p>'; }
  }
  function dibujarSimulacion(a) {
    simActual = a;
    const hist = a.v.slice(-48), ult = hist[hist.length - 1].t, futT = Array.from({length: HORAS}, (_, k) => new Date(ult + (k + 1) * 3600e3));
    const xH = hist.map(x => new Date(x.t)), xF = [new Date(ult), ...futT], conP = arr => [a.p0, ...arr];
    if (window.Plotly) {
      const trazas = [
        ...a.mc.muestras.map(m => ({x: xF, y: conP(m), mode: 'lines', line: {color: 'rgba(148,163,184,.18)', width: 1}, hoverinfo: 'skip', showlegend: false})),
        {x: xF, y: conP(a.mc.bandas.p5), mode: 'lines', line: {width: 0}, hoverinfo: 'skip', showlegend: false},
        {x: xF, y: conP(a.mc.bandas.p95), mode: 'lines', line: {width: 0}, fill: 'tonexty', fillcolor: 'rgba(96,165,250,.13)', name: '90 % de los caminos'},
        {x: xF, y: conP(a.mc.bandas.p25), mode: 'lines', line: {width: 0}, hoverinfo: 'skip', showlegend: false},
        {x: xF, y: conP(a.mc.bandas.p75), mode: 'lines', line: {width: 0}, fill: 'tonexty', fillcolor: 'rgba(96,165,250,.28)', name: '50 % de los caminos'},
        {x: xF, y: conP(a.mc.bandas.p50), mode: 'lines', line: {color: '#60a5fa', width: 2, dash: 'dot'}, name: 'Camino del medio'},
        {x: xH, y: hist.map(x => x.c), mode: 'lines', line: {color: '#e5e7eb', width: 2}, name: 'Precio últimas 48 h'},
        {x: [xH[0], xF[xF.length - 1]], y: [a.objetivo, a.objetivo], mode: 'lines', line: {color: a.rel >= 0 ? '#4ade80' : '#f87171', width: 1.5, dash: 'dash'}, name: 'Objetivo ' + precioS(a.objetivo)},
      ];
      Plotly.react('sGrafico', trazas, {margin: {t: 10, l: 60, r: 10, b: 30}, paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
        font: {color: '#e5e7eb'}, xaxis: {gridcolor: '#262c38'}, yaxis: {gridcolor: '#262c38'}, legend: {orientation: 'h', y: -0.12},
        shapes: [{type: 'line', x0: new Date(ult), x1: new Date(ult), yref: 'paper', y0: 0, y1: 1, line: {color: '#6b7280', width: 1, dash: 'dot'}}],
        hovermode: 'x'}, {displayModeBar: false, responsive: true});
    }
    const dir = a.rel >= 0 ? 'suba' : 'baje';
    S('sModelo').innerHTML = `<h3>🎲 1000 simulaciones</h3><table><tbody>
      <tr><td>Objetivo ${a.manual ? '(el tuyo)' : '(del modelo)'}</td><td><b>${precioS(a.objetivo)}</b> <span class="${a.rel >= 0 ? 'up' : 'down'}">${pc(a.rel * 100)}</span></td></tr>
      <tr><td>Lo toca en las próximas 12 h</td><td><b>${prob(a.mc.toca12)}</b></td></tr>
      <tr><td>Lo toca en las próximas 24 h</td><td><b>${prob(a.mc.toca24)}</b></td></tr>
      <tr><td>Termina más arriba en 12 h / 24 h</td><td>${prob(a.mc.sube12)} / ${prob(a.mc.sube24)}</td></tr>
      <tr><td>Rango probable en 12 h (90 %)</td><td>${precioS(a.mc.rango12[0])} – ${precioS(a.mc.rango12[1])}</td></tr>
      <tr><td>Rango probable en 24 h (90 %)</td><td>${precioS(a.mc.rango24[0])} – ${precioS(a.mc.rango24[1])}</td></tr>
      <tr><td>Agitación del mercado ahora</td><td>${n2(a.mc.escala, 1)}× lo normal</td></tr></tbody></table>`;
    S('sHistoria').innerHTML = `<h3>📚 ${a.hist.casos} momentos parecidos del pasado</h3><table><tbody>
      <tr><td>Subió en las 24 h siguientes</td><td><b>${prob(a.hist.sube24)}</b> de las veces</td></tr>
      <tr><td>Movimiento típico en 24 h</td><td class="${a.hist.mov24 >= 0 ? 'up' : 'down'}">${pc(a.hist.mov24 * 100)}</td></tr>
      <tr><td>Llegó al objetivo en 12 h</td><td><b>${prob(a.hist.llego12)}</b></td></tr>
      <tr><td>Llegó al objetivo en 24 h</td><td><b>${prob(a.hist.llego24)}</b></td></tr></tbody></table>`;
    const nt = tonoNoticias(a.activo);
    S('sExplica').innerHTML = `<b>Cómo se calcula:</b> se toman las velas de 1 hora de ${escS(a.activo)} de los últimos ~80 días y se arman 1000 caminos posibles
      de 24 h juntando al azar tramos reales de 6 horas, ajustados a lo agitado que está el mercado ahora (${n2(a.mc.escala, 1)}×). No se le
      agrega tendencia: el modelo no "cree" que vaya a subir ni a bajar. Aparte se buscan los ${a.hist.casos} momentos del pasado con la situación más
      parecida a la de ahora (subida de las últimas 4 y 24 h, volumen, % de compras agresivas y agitación) y se mira qué pasó después.
      ${a.manual ? '' : `El objetivo es lo que típicamente llegó a ${dir === 'suba' ? 'subir' : 'bajar'} el precio en la mitad de esos casos, y el "llegó al objetivo" se mide con la otra mitad.`}
      Noticias de ${escS(a.activo)} en las últimas 6 h: ${nt.cuantas}${nt.cuantas ? ' (tono ' + (nt.neto > 0 ? 'positivo' : nt.neto < 0 ? 'negativo' : 'neutro') + ')' : ''}.
      <br><b>Ojo:</b> son probabilidades sacadas del pasado; el mercado puede hacer algo que nunca hizo. No es una recomendación de inversión.`;
  }

  // ------------------------------------------------------------ noticias
  function dibujarNoticias() {
    const sel = S('nMoneda'), filtro = sel.value;
    const monedas = [...new Set(noticias.flatMap(n => n.monedas || []))].sort();
    sel.innerHTML = '<option value="">Todas</option>' + monedas.map(m => `<option${m === filtro ? ' selected' : ''}>${escS(m)}</option>`).join('');
    const medidas = noticias.filter(n => n.reaccion && n.reaccion.normal15);
    const grupo = niv => medidas.filter(n => niv.includes(n.nivel));
    const movTip = l => l.length ? mediana(l.map(n => Math.abs(n.reaccion.p15))) : NaN;
    const fuertes = l => l.length ? l.filter(n => n.reaccion.veces >= 2).length / l.length : NaN;
    const conTono = medidas.filter(n => n.tono), acierta = conTono.length ? conTono.filter(n => Math.sign(n.reaccion.p60) === n.tono).length / conTono.length : NaN;
    const importantes = grupo(['alto', 'medio']), comunes = grupo(['bajo']);
    const ratio = movTip(importantes) / movTip(comunes);
    S('nResumen').innerHTML = medidas.length < 5 ? '<p class="nota">Juntando datos: la reacción se mide 1 hora después de cada noticia.</p>' : `
      <div class="kpi"><span>Noticias medidas (7 días)</span><b>${medidas.length}</b></div>
      <div class="kpi"><span>Movimiento típico 15 min después</span><b>${n2(movTip(importantes))}%</b><small>importantes · comunes ${n2(movTip(comunes))}%</small></div>
      <div class="kpi"><span>Movieron el precio 2× lo normal o más</span><b>${isNaN(fuertes(importantes)) ? '—' : prob(fuertes(importantes))}</b><small>importantes · comunes ${isNaN(fuertes(comunes)) ? '—' : prob(fuertes(comunes))}</small></div>
      <div class="kpi"><span>El tono (🟢/🔴) acertó la dirección en 1 h</span><b>${isNaN(acierta) ? '—' : prob(acierta)}</b><small>50 % = como tirar una moneda</small></div>
      <p class="nota" style="grid-column:1/-1">${isNaN(ratio) ? '' : ratio >= 1.3 ? `📌 Las noticias importantes movieron el precio <b>${n2(ratio, 1)} veces más</b> que las comunes en los 15 minutos siguientes.`
        : '📌 Por ahora las noticias importantes no movieron el precio mucho más que las comunes: el mercado se está moviendo más por otras cosas.'}</p>`;
    const lista = noticias.filter(n => !filtro || (n.monedas || []).includes(filtro)).slice(0, 60);
    S('nLista').innerHTML = lista.map(n => {
      const r = n.reaccion, link = /^https?:\/\//.test(n.link || '') ? n.link : '#';
      const reac = r ? `<span class="${r.p15 >= 0 ? 'up' : 'down'}">${escS(r.par.replace('USDT', ''))} ${pc(r.p15, 2)} en 15 min</span>` +
        (r.veces != null ? ` · <b${r.veces >= 2 ? ' class="fuerte"' : ''}>${n2(r.veces, 1)}× lo normal</b>` : '') + ` · 1 h ${pc(r.p60, 2)}`
        : (Date.now() - new Date(n.t) < 3600e3 ? '<span class="nota">midiendo la reacción…</span>' : '');
      return `<div class="noticia"><div class="ncab"><span class="nivel ${n.nivel}">${n.nivel}</span>${n.tono > 0 ? '🟢' : n.tono < 0 ? '🔴' : '⚪'}
        <span class="nota">hace ${hace(n.t)} · ${escS(n.fuente)}</span>${(n.monedas || []).map(m => `<span class="chipR">${escS(m)}</span>`).join('')}</div>
        <a href="${escS(link)}" target="_blank" rel="noopener noreferrer">${escS(n.titulo)}</a>
        <div class="nreac">${reac}${(n.categorias || []).length ? ' <span class="nota">· ' + escS(n.categorias.join(', ')) + '</span>' : ''}</div></div>`;
    }).join('') || '<p class="nota">Sin noticias para mostrar.</p>';
  }

  S('sSimular').addEventListener('click', correrSimulacion);
  S('nMoneda').addEventListener('change', dibujarNoticias);
  window.abrirSimulador = () => {
    llenarActivos(); cargarNoticias().then(() => armarTop3());
    if (simActual) setTimeout(() => window.Plotly && Plotly.Plots.resize('sGrafico'), 50);
  };
  setInterval(() => { if (S('s-simulador').classList.contains('activa')) { cargarNoticias(); armarTop3(); llenarActivos(); } }, 60e3);
  if (S('s-simulador').classList.contains('activa')) window.abrirSimulador();
})();
