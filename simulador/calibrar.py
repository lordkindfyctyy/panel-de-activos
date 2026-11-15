"""¿Cuánto acierta el simulador? (corre en GitHub Actions cada hora; mismo modelo que sim.js del panel)

1. Prueba con el pasado: corre el simulador en momentos de los últimos 90 días (cada 12 h, 10 monedas grandes) usando SOLO los
   datos que existían en ese momento, y mira qué pasó después. Se recalcula una vez por día.
2. En vivo: cada hora guarda la predicción para los 3 activos con mejores señales (misma fórmula que el panel) y, cuando pasan
   12 y 24 h, anota si tocó el objetivo, si subió y si el precio quedó dentro del rango probable.

Resultado: salida/predicciones.json (va a la rama "datos-sim" del repo y el panel lo lee desde raw.githubusercontent.com).

    pip install numpy
    python simulador/calibrar.py salida/predicciones.json
"""
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np

API = "https://data-api.binance.vision/api/v3"
ANTERIOR = "https://raw.githubusercontent.com/lordkindfyctyy/panel-de-activos/datos-sim/predicciones.json"
NOTICIAS = "https://raw.githubusercontent.com/lordkindfyctyy/panel-de-activos/datos/noticias.json"
N_CAMINOS, HORAS, PARECIDOS, VENTANA_VELAS = 1000, 24, 40, 2000
PRUEBA_MONEDAS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "TRXUSDT", "LINKUSDT", "AVAXUSDT"]
PRUEBA_DIAS, PRUEBA_CADA = 90, 12
ESTABLES = {"USDC", "FDUSD", "TUSD", "DAI", "USDP", "BUSD", "EUR", "TRY", "BRL", "ARS", "GBP", "AEUR", "EURI", "USD1", "XUSD", "BFUSD",
            "USDE", "PAXG", "RLUSD"}
NO_CRIPTO = {"XAUT", "PAXG", "NVDAB", "MSTRB", "CRCLB", "TSLAB", "AAPLB", "COINB", "HOODB", "SPYB", "QQQB", "GOOGLB", "AMZNB", "METAB",
             "MSFTB", "AMDB", "PLTRB"}
rng = np.random.default_rng()


def get(ruta, **params):
    url = "%s/%s?%s" % (API, ruta, urllib.parse.urlencode(params))
    for i in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "panel-simulador"}), timeout=25) as r:
                return json.loads(r.read())
        except Exception:
            if i == 2:
                raise
            time.sleep(1 + i)


def velas(par, intervalo="1h", cantidad=2000, fin=None):
    """Arreglos t, h, l, c, qv, tb de las últimas `cantidad` velas (hasta `fin` en ms, si se da)."""
    filas = []
    while len(filas) < cantidad:
        p = {"symbol": par, "interval": intervalo, "limit": min(1000, cantidad - len(filas))}
        if filas:
            p["endTime"] = filas[0][0] - 1
        elif fin:
            p["endTime"] = fin
        lote = get("klines", **p)
        if not lote:
            break
        filas = lote + filas
        if len(lote) < p["limit"]:
            break
    a = np.array([[x[0], x[2], x[3], x[4], x[7], x[10]] for x in filas], dtype=float)
    return {"t": a[:, 0], "h": a[:, 1], "l": a[:, 2], "c": a[:, 3], "qv": a[:, 4], "tb": a[:, 5]}


# ------------------------------------------------------------------ el modelo (igual que sim.js)
def rasgos(v):
    """Matriz (n, 5) con los rasgos de cada hora (NaN donde no hay historia suficiente)."""
    c, qv, tb = v["c"], v["qv"], v["tb"]
    n = len(c)
    r = np.zeros(n)
    r[1:] = np.log(c[1:] / c[:-1])
    F = np.full((n, 5), np.nan)
    cq, ct = np.concatenate([[0], np.cumsum(qv)]), np.concatenate([[0], np.cumsum(tb)])
    from numpy.lib.stride_tricks import sliding_window_view as ventana
    sd24 = np.full(n, np.nan)
    sd168 = np.full(n, np.nan)
    sd24[23:] = ventana(r, 24).std(axis=1)
    sd168[167:] = ventana(r, 168).std(axis=1)
    i = np.arange(168, n)
    qv4 = cq[i + 1] - cq[i - 3]
    tb4 = ct[i + 1] - ct[i - 3]
    bloques = (cq[i - 3] - cq[i - 167]) / 41
    F[i, 0] = np.log(c[i] / c[i - 4])
    F[i, 1] = np.log(c[i] / c[i - 24])
    F[i, 2] = np.log(np.where(bloques > 0, qv4 / np.where(bloques > 0, bloques, 1), 1))
    F[i, 3] = np.where(qv4 > 0, tb4 / np.where(qv4 > 0, qv4, 1) - 0.5, 0)
    F[i, 4] = np.log(np.maximum(sd24[i], 1e-9) / np.maximum(sd168[i], 1e-9))
    return F, r


def mediana_js(a):
    s = np.sort(a)
    return float(s[len(s) // 2]) if len(s) else math.nan


def predecir(v, F, r, T, objetivo_manual=None):
    """Predicción hecha en la vela T (usa solo velas <= T). Devuelve objetivo y probabilidades del modelo y de la historia."""
    c, h, l = v["c"], v["h"], v["l"]
    ini = max(0, T - VENTANA_VELAS + 1)
    p0 = c[T]
    # casos parecidos: candidatos con 24 h de futuro conocido antes de T
    cand = np.arange(max(168, ini + 168), T - 24)
    Fc = F[cand]
    escalas = Fc.std(axis=0)
    escalas[escalas == 0] = 1
    d = np.sqrt((((Fc - F[T]) / escalas) ** 2).sum(axis=1))
    elegidos = []
    for k in np.argsort(d):
        i = cand[k]
        if all(abs(i - e) >= 8 for e in elegidos):
            elegidos.append(i)
        if len(elegidos) >= PARECIDOS:
            break
    el = np.array(elegidos)
    ret24 = c[el + 24] / c[el] - 1
    mx = lambda hh: np.array([h[i + 1:i + 1 + hh].max() for i in el]) / c[el] - 1
    mn = lambda hh: np.array([l[i + 1:i + 1 + hh].min() for i in el]) / c[el] - 1
    max12, max24, min12, min24 = mx(12), mx(24), mn(12), mn(24)
    sube24 = float((ret24 > 0).mean())
    alcista = sube24 >= 0.5
    A, B = np.arange(len(el)) % 2 == 0, np.arange(len(el)) % 2 == 1
    objetivo = objetivo_manual or p0 * (1 + mediana_js((max24 if alcista else min24)[A]))
    rel = objetivo / p0 - 1
    arriba = objetivo >= p0
    prueba = slice(None) if objetivo_manual else B
    llego = lambda m12, m24, hh: float(((m12 if hh == 12 else m24)[prueba] >= rel).mean()) if arriba else \
        float(((m12 if hh == 12 else m24)[prueba] <= rel).mean())
    hist12 = llego(max12, max24, 12) if arriba else llego(min12, min24, 12)
    hist24 = llego(max12, max24, 24) if arriba else llego(min12, min24, 24)
    # Monte Carlo: tramos reales de 6 h, sin tendencia, escalados a la agitación actual
    rr = r[ini + 1:T + 1]
    up = np.log(h[ini + 1:T + 1] / c[ini:T])
    dn = np.log(l[ini + 1:T + 1] / c[ini:T])
    media = rr.mean()
    rr, up, dn = rr - media, up - media, dn - media
    escala = float(np.clip(math.sqrt((rr[-24:].std() ** 2 + rr[-72:].std() ** 2) / 2) / rr.std(), 0.5, 3))
    inicios = rng.integers(0, len(rr) - 6, size=(N_CAMINOS, HORAS // 6))
    idx = (inicios[:, :, None] + np.arange(6)).reshape(N_CAMINOS, HORAS)
    lp = np.cumsum(rr[idx] * escala, axis=1)
    cierres = p0 * np.exp(lp)
    prev = p0 * np.exp(np.concatenate([np.zeros((N_CAMINOS, 1)), lp[:, :-1]], axis=1))
    altos, bajos = prev * np.exp(up[idx] * escala), prev * np.exp(dn[idx] * escala)
    if arriba:
        mc12, mc24 = float((altos[:, :12].max(1) >= objetivo).mean()), float((altos.max(1) >= objetivo).mean())
    else:
        mc12, mc24 = float((bajos[:, :12].min(1) <= objetivo).mean()), float((bajos.min(1) <= objetivo).mean())
    p5, p95 = np.percentile(cierres[:, -1], [5, 95])
    return {"p0": float(p0), "objetivo": float(objetivo), "rel": float(rel), "mc12": mc12, "mc24": mc24, "hist12": hist12, "hist24": hist24,
            "sube24": sube24, "mc_sube24": float((cierres[:, -1] > p0).mean()), "rango24": [float(p5), float(p95)], "escala": escala}


def resultado(pred, h, l, c_fin):
    """Qué pasó: tocó el objetivo en 12/24 h, subió en 24 h, cerró dentro del rango del 90 %."""
    arriba = pred["objetivo"] >= pred["p0"]
    toco = lambda hh: bool(h[:hh].max() >= pred["objetivo"]) if arriba else bool(l[:hh].min() <= pred["objetivo"])
    return {"toco12": toco(len(h) // 2), "toco24": toco(len(h)), "subio24": bool(c_fin > pred["p0"]),
            "en_rango": bool(pred["rango24"][0] <= c_fin <= pred["rango24"][1]), "cierre24": float(c_fin)}


# ------------------------------------------------------------------ estadísticas de acierto
def resumir(filas):
    """Calibración (lo que dijo vs. lo que pasó), puntaje de Brier y aciertos de dirección y de rango."""
    filas = [f for f in filas if f.get("res")]
    if not filas:
        return None
    out = {"n": len(filas)}
    for clave, real in (("mc24", "toco24"), ("hist24", "toco24"), ("mc12", "toco12"), ("hist12", "toco12")):
        p = np.array([f[clave] for f in filas])
        y = np.array([f["res"][real] for f in filas], dtype=float)
        base = y.mean()
        brier, brier_base = float(((p - y) ** 2).mean()), float(((base - y) ** 2).mean())
        cubetas = []
        for a in np.arange(0, 1, 0.1):
            m = (p >= a) & (p < a + 0.1 if a < 0.9 else p <= 1)
            if m.sum() >= 5:
                cubetas.append({"desde": round(float(a), 1), "n": int(m.sum()), "dijo": round(float(p[m].mean()), 3), "paso": round(float(y[m].mean()), 3)})
        out[clave] = {"dijo": round(float(p.mean()), 3), "paso": round(float(base), 3), "brier": round(brier, 4),
                      "brier_base": round(brier_base, 4), "mejora": round(1 - brier / brier_base, 3) if brier_base else 0, "cubetas": cubetas}
    sube = np.array([f["sube24"] for f in filas])
    subio = np.array([f["res"]["subio24"] for f in filas])
    decididos = np.abs(sube - 0.5) >= 0.1  # cuando los casos parecidos se inclinan claramente
    out["direccion"] = {"acierto": round(float(((sube >= 0.5) == subio).mean()), 3),
                        "acierto_claros": round(float(((sube[decididos] >= 0.5) == subio[decididos]).mean()), 3) if decididos.any() else None,
                        "n_claros": int(decididos.sum()), "subio": round(float(subio.mean()), 3)}
    out["rango"] = round(float(np.mean([f["res"]["en_rango"] for f in filas])), 3)
    return out


def prueba_con_pasado():
    filas = []
    for par in PRUEBA_MONEDAS:
        try:
            v = velas(par, "1h", VENTANA_VELAS + PRUEBA_DIAS * 24 + 30)
        except Exception as e:
            print("sin datos", par, e)
            continue
        F, r = rasgos(v)
        n = len(v["c"])
        for T in range(n - 25, n - 25 - PRUEBA_DIAS * 24, -PRUEBA_CADA):
            if T < VENTANA_VELAS:
                break
            p = predecir(v, F, r, T)
            p.update({"par": par, "t": datetime.fromtimestamp(v["t"][T] / 1000 + 3600, timezone.utc).isoformat(timespec="minutes")})
            p["res"] = resultado(p, v["h"][T + 1:T + 25], v["l"][T + 1:T + 25], v["c"][T + 24])
            filas.append(p)
    return filas


# ------------------------------------------------------------------ los 3 con mejores señales (misma fórmula que el panel)
def universo(n=30):
    out = []
    for t in get("ticker/24hr", type="MINI"):
        s = t["symbol"]
        if not s.endswith("USDT"):
            continue
        base = s[:-4]
        if base in ESTABLES or base in NO_CRIPTO or base.endswith(("UP", "DOWN", "BULL", "BEAR")):
            continue
        precio, alto, bajo, vol = float(t["lastPrice"]), float(t["highPrice"]), float(t["lowPrice"]), float(t["quoteVolume"])
        if 0.97 < precio < 1.03 and (alto - bajo) / precio < 0.01:
            continue
        if vol >= 5e6 and precio > 0:
            out.append((s, vol))
    out.sort(key=lambda x: -x[1])
    return out[:n]


def puntaje_presion(k):
    c = np.array([float(x[4]) for x in k])
    vol = np.array([float(x[7]) for x in k])
    compra = np.array([float(x[10]) for x in k])
    reciente = vol[-3:].sum()
    antes = vol[-39:-3]
    bloques = antes[:36].reshape(12, 3).sum(1) if len(antes) >= 36 else antes
    volz = (reciente - bloques.mean()) / bloques.std() if bloques.std() > 0 else 0
    total = vol[-3:].sum()
    pc = compra[-3:].sum() / total * 100 if total > 0 else 50
    mom15 = (c[-1] / c[-4] - 1) * 100
    mom1h = (c[-1] / c[-13] - 1) * 100
    acel = ((c[-1] / c[-4] - 1) - (c[-4] / c[-7] - 1)) * 100
    tanh = lambda x, e: math.tanh(x / e)
    dirn = 1 if pc >= 50 else -1
    p = 0.30 * dirn * max(0, tanh(volz, 3)) + 0.30 * tanh((pc - 50) / 100, 0.1) + 0.20 * tanh(mom15, 2) + 0.10 * tanh(acel, 1)
    return round(100 * p, 1), mom1h


def tres_mejores():
    try:
        notas = json.loads(urllib.request.urlopen(NOTICIAS, timeout=20).read()).get("noticias", [])
    except Exception:
        notas = []
    corte = datetime.now(timezone.utc) - timedelta(hours=6)
    peso = {"alto": 3, "medio": 2, "bajo": 1}
    cand = []
    for par, vol in universo():
        if vol < 1e7:
            continue
        try:
            pres, mom1h = puntaje_presion(get("klines", symbol=par, interval="5m", limit=60))
        except Exception:
            continue
        base = par[:-4]
        neto = sum(n["tono"] * peso.get(n["nivel"], 1) for n in notas if base in (n.get("monedas") or []) and datetime.fromisoformat(n["t"]) >= corte)
        cand.append((pres + 8 * max(-3, min(3, neto)) + 10 * math.tanh(mom1h / 1.5), par))
    return [p for _, p in sorted(cand, reverse=True)[:3]]


def main():
    salida = sys.argv[1] if len(sys.argv) > 1 else "predicciones.json"
    ahora = datetime.now(timezone.utc)
    try:
        previo = json.loads(urllib.request.urlopen(ANTERIOR, timeout=20).read())
    except Exception:
        previo = {}
    datos = {"actualizado": ahora.isoformat(timespec="minutes"), "modelo": "sim.js (1000 caminos, 40 casos parecidos)"}

    # 1) prueba con el pasado, una vez por día
    pasada = previo.get("prueba")
    if not pasada or ahora - datetime.fromisoformat(pasada["calculado"]) > timedelta(hours=20):
        filas = prueba_con_pasado()
        pasada = {"calculado": ahora.isoformat(timespec="minutes"), "dias": PRUEBA_DIAS, "cada_horas": PRUEBA_CADA,
                  "monedas": [m[:-4] for m in PRUEBA_MONEDAS], "resumen": resumir(filas),
                  "ejemplos": [{k: f[k] for k in ("par", "t", "p0", "objetivo", "mc24", "hist24", "res")} for f in filas[:12]]}
    datos["prueba"] = pasada

    # 2) en vivo: completar resultados de las predicciones viejas y agregar las de esta hora
    vivo = previo.get("vivo", [])
    for p in vivo:
        if p.get("res") or ahora - datetime.fromisoformat(p["t"]) < timedelta(hours=24, minutes=20):
            continue
        try:
            k = get("klines", symbol=p["par"], interval="15m", startTime=int(datetime.fromisoformat(p["t"]).timestamp() * 1000), limit=96)
            if len(k) == 96:
                h = np.array([float(x[2]) for x in k]); l = np.array([float(x[3]) for x in k])
                p["res"] = resultado(p, h, l, float(k[-1][4]))
        except Exception as e:
            print("no pude revisar", p["par"], e)
    hechas = {(p["par"], p["t"][:13]) for p in vivo}
    try:
        for par in tres_mejores():
            if (par, ahora.isoformat()[:13]) in hechas:
                continue
            v = velas(par, "1h", VENTANA_VELAS)
            F, r = rasgos(v)
            p = predecir(v, F, r, len(v["c"]) - 1)
            p.update({"par": par, "t": ahora.isoformat(timespec="minutes")})
            vivo.append(p)
    except Exception as e:
        print("no pude predecir en vivo:", e)
    datos["vivo"] = vivo[-900:]
    datos["vivo_resumen"] = resumir(vivo)
    os.makedirs(os.path.dirname(os.path.abspath(salida)), exist_ok=True)
    with open(salida, "w", encoding="utf-8") as f:
        json.dump(datos, f, separators=(",", ":"))
    r = pasada["resumen"] or {}
    print("Prueba con el pasado: %s predicciones · en vivo: %d (%d con resultado)" % (
        r.get("n"), len(vivo), sum(1 for p in vivo if p.get("res"))))


if __name__ == "__main__":
    main()
