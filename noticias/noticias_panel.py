"""Noticias cripto y de economía con la reacción del precio minuto a minuto (corre en GitHub Actions cada 5 minutos).

1. Lee los feeds RSS públicos de varios medios (solo lo que publican para consumir: título, link y hora).
2. Marca a qué monedas se refiere cada noticia, de qué tipo es (regulación, hackeo, tasas...) y su tono (+/−) con
   reglas por palabras clave. Es una ayuda para ordenar, no una predicción.
3. Para las noticias de hace más de una hora, mide con velas de 1 minuto de Binance cuánto se movió el precio de esa
   moneda (o de BTC si no nombra ninguna) 5, 15 y 60 minutos después, y cuántas veces es eso un movimiento normal.

    python noticias/noticias_panel.py salida/noticias.json

Solo usa la biblioteca estándar de Python.
"""
import json
import os
import re
import statistics
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

ANTERIOR = "https://raw.githubusercontent.com/lordkindfyctyy/panel-de-activos/datos/noticias.json"
BINANCE = "https://data-api.binance.vision/api/v3"
FEEDS = {
    "Cointelegraph": "https://cointelegraph.com/rss",
    "CoinDesk": "https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml",
    "Decrypt": "https://decrypt.co/feed",
    "The Block": "https://www.theblock.co/rss.xml",
    "CryptoSlate": "https://cryptoslate.com/feed/",
    "Investing cripto": "https://www.investing.com/rss/news_301.rss",
    "Investing economía": "https://www.investing.com/rss/news_14.rss",
    "Investing indicadores": "https://www.investing.com/rss/news_95.rss",
}
DIAS = 7            # cuántos días de noticias se guardan
MAX_REACCIONES = 45  # cuántas reacciones se miden por corrida (cada una son 2 consultas a Binance)

CATEGORIAS = {
    "Regulación / ETF": (3, [r"\bsec\b", r"\betfs?\b", r"\bregulat\w*", r"\bbans?\b|\bbanned\b", r"\blawsuits?\b", r"\bsues?\b|\bsued\b",
                             r"\bapprov\w*", r"\bcftc\b", r"\bdoj\b", r"stablecoin (bill|act)", r"crypto (bill|act)", r"\bcongress\b"]),
    "Hackeo / quiebra": (3, [r"\bhack\w*", r"\bstolen\b", r"\bexploit\w*", r"\bbankrupt\w*", r"\binsolven\w*", r"\bcollaps\w*",
                             r"\bdepeg\w*", r"halts? withdrawals", r"\bfraud\b", r"rug pull", r"\bdrained\b"]),
    "Tasas / inflación": (2, [r"\bfed\b", r"\bfomc\b", r"rate (cut|hike)s?", r"\bpowell\b", r"\becb\b", r"interest rates?", r"\binflation\b",
                              r"\bcpi\b", r"\bpayrolls?\b", r"\bnonfarm\b", r"\bjobless\b", r"\brecession\b", r"treasury yields?"]),
    "Geopolítica / aranceles": (2, [r"\btariffs?\b", r"\bsanctions?\b", r"\bwar\b", r"\bmissile", r"trade (deal|war)", r"\bshutdown\b",
                                    r"\bdowngrade\w*", r"\bembargo"]),
    "Grandes compradores": (2, [r"strategic reserve", r"bitcoin reserve", r"\bblackrock\b", r"\bmicrostrategy\b|strategy buys",
                                r"\binstitutional\b", r"\badoption\b", r"buys bitcoin", r"\binflows?\b|\boutflows?\b", r"\blisting\b|\bdelist\w*"]),
    "Movimiento brusco": (2, [r"\bliquidat\w*", r"\bcrash\w*", r"\bplunge\w*", r"\btumbl\w*", r"\bsoar\w*", r"\bsurg\w*",
                              r"record high|all-time high", r"sell-?off", r"\brally\b|\brallies\b", r"\bplummet\w*", r"\bskyrocket\w*"]),
}
CATEGORIAS = {n: (p, [re.compile(x, re.I) for x in pats]) for n, (p, pats) in CATEGORIAS.items()}
POSITIVO = re.compile(r"\b(surg\w*|soar\w*|rall(y|ies|ied)|jump\w*|gains?|climb\w*|rebound\w*|record high|all-time high|approv\w*|"
                      r"inflows?|adopt\w*|buys|bought|bullish|rises?|rising|upgrade\w*|partnership|breaks? above|recover\w*|launch\w*)\b", re.I)
NEGATIVO = re.compile(r"\b(hack\w*|exploit\w*|stolen|crash\w*|plunge\w*|tumbl\w*|drops?|dropped|falls?|fell|slump\w*|sell-?off|"
                      r"outflows?|lawsuits?|sues?|sued|bans?|banned|bearish|liquidat\w*|fraud|bankrupt\w*|declin\w*|dump\w*|"
                      r"warn\w*|probe|charged|breaks? below|losses|slid\w*|sinks?)\b", re.I)
MONEDAS = {
    "BTC": r"\bbitcoin\b|\bbtc\b", "ETH": r"\bethereum\b|\bether\b|\beth\b", "SOL": r"\bsolana\b|\bsol\b", "XRP": r"\bxrp\b|\bripple\b",
    "BNB": r"\bbnb\b|\bbinance coin\b", "DOGE": r"\bdoge(coin)?\b", "ADA": r"\bcardano\b|\bada\b", "AVAX": r"\bavalanche\b|\bavax\b",
    "LINK": r"\bchainlink\b", "DOT": r"\bpolkadot\b", "LTC": r"\blitecoin\b", "TRX": r"\btron\b|\btrx\b", "NEAR": r"near protocol",
    "SUI": r"\bsui\b", "TON": r"\btoncoin\b|\bton\b", "SHIB": r"\bshiba inu\b|\bshib\b", "PEPE": r"\bpepe\b", "UNI": r"\buniswap\b",
    "AAVE": r"\baave\b", "HYPE": r"\bhyperliquid\b|\bhype\b", "ENA": r"\bethena\b", "TAO": r"\bbittensor\b", "ZEC": r"\bzcash\b|\bzec\b",
    "WLD": r"\bworldcoin\b", "ONDO": r"\bondo\b", "APT": r"\baptos\b", "ARB": r"\barbitrum\b", "OP": r"\boptimism\b",
    "FIL": r"\bfilecoin\b", "INJ": r"\binjective\b", "SEI": r"\bsei\b", "XLM": r"\bstellar\b|\bxlm\b", "BCH": r"bitcoin cash",
}
MONEDAS = {m: re.compile(p, re.I) for m, p in MONEDAS.items()}
NO_TICKERS = {"SEC", "ETF", "ETFS", "CEO", "USD", "USA", "US", "FED", "IPO", "DEX", "NFT", "CPI", "GDP", "AI", "OK", "EU", "UK",
              "IMF", "ECB", "BOJ", "FOMC", "DOJ", "CFTC", "IRS", "GOP", "TV", "PM", "AM", "THE", "NEW", "ONE", "ALL", "BIG", "TOP"}


def bajar(url, json_=False):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (panel de activos, lector de noticias)"})
    with urllib.request.urlopen(req, timeout=20) as r:
        datos = r.read()
    return json.loads(datos) if json_ else datos


def fecha(texto):
    texto = (texto or "").strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%b %d, %Y %H:%M GMT"):
        try:
            return datetime.strptime(texto, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    try:
        d = parsedate_to_datetime(texto)
        return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def analizar(titulo, fuente):
    cats, puntos = [], 0
    for nombre, (peso, pats) in CATEGORIAS.items():
        if any(p.search(titulo) for p in pats):
            cats.append(nombre)
            puntos += peso
    monedas = [m for m, p in MONEDAS.items() if p.search(titulo)]
    if monedas or "cripto" in fuente.lower() or fuente in ("Cointelegraph", "CoinDesk", "Decrypt", "The Block", "CryptoSlate"):
        puntos += 1
    pos, neg = len(POSITIVO.findall(titulo)), len(NEGATIVO.findall(titulo))
    tono = 1 if pos > neg else (-1 if neg > pos else 0)
    return {"monedas": monedas, "categorias": cats, "puntos": puntos, "tono": tono,
            "nivel": "alto" if puntos >= 5 else ("medio" if puntos >= 3 else "bajo")}


def leer_feeds():
    items, errores = [], []
    for fuente, url in FEEDS.items():
        try:
            raiz = ET.fromstring(bajar(url))
        except Exception as e:
            errores.append("%s: %s" % (fuente, str(e)[:60]))
            continue
        for it in raiz.iter("item"):
            titulo = re.sub(r"\s+", " ", (it.findtext("title") or "")).strip()
            link = (it.findtext("link") or "").strip()
            t = fecha(it.findtext("pubDate"))
            if not titulo or not t:
                continue
            items.append({"id": link or titulo, "t": t.isoformat(timespec="seconds"), "fuente": fuente, "titulo": titulo,
                          "link": link, **analizar(titulo, fuente)})
    return items, errores


def reaccion(par, t):
    """Cuánto se movió `par` después de la hora `t` (velas de 1 minuto) comparado con un movimiento normal de 15 minutos."""
    inicio = int((t - timedelta(minutes=15)).timestamp() * 1000)
    k = bajar("%s/klines?%s" % (BINANCE, urllib.parse.urlencode({"symbol": par, "interval": "1m", "startTime": inicio, "limit": 76})), True)
    if len(k) < 76:
        return None
    c = [float(x[4]) for x in k]
    altos, bajos = [float(x[2]) for x in k[15:]], [float(x[3]) for x in k[15:]]
    base = c[15]
    fin = int(t.timestamp() * 1000)
    k15 = bajar("%s/klines?%s" % (BINANCE, urllib.parse.urlencode({"symbol": par, "interval": "15m", "endTime": fin, "limit": 96})), True)
    cierres = [float(x[4]) for x in k15]
    normal = statistics.median(abs(b / a - 1) for a, b in zip(cierres, cierres[1:])) * 100 if len(cierres) > 10 else None
    pct = lambda a: round((a / base - 1) * 100, 3)
    p15 = pct(c[30])
    return {"par": par, "pre15": round((base / c[0] - 1) * 100, 3), "p5": pct(c[20]), "p15": p15, "p60": pct(c[75]),
            "max60": pct(max(altos)), "min60": pct(min(bajos)), "normal15": round(normal, 3) if normal else None,
            "veces": round(abs(p15) / normal, 1) if normal else None}


def main():
    salida = sys.argv[1] if len(sys.argv) > 1 else "noticias.json"
    ahora = datetime.now(timezone.utc)
    try:
        previas = {n["id"]: n for n in bajar(ANTERIOR, True).get("noticias", [])}
    except Exception:
        previas = {}
    nuevas, errores = leer_feeds()
    for n in nuevas:
        if n["id"] in previas:  # conservar la reacción ya medida
            n["reaccion"] = previas[n["id"]].get("reaccion")
        previas[n["id"]] = n
    corte = ahora - timedelta(days=DIAS)
    todas = [n for n in previas.values() if datetime.fromisoformat(n["t"]) >= corte and datetime.fromisoformat(n["t"]) <= ahora + timedelta(minutes=5)]
    todas.sort(key=lambda n: n["t"], reverse=True)
    try:
        listados = {s["symbol"] for s in bajar(BINANCE + "/ticker/price", True)}
    except Exception:
        listados = set()
    # también monedas escritas como ticker en mayúsculas en el título ("KAVA token"), si cotizan en Binance
    for n in todas:
        for w in re.findall(r"[A-Z][A-Z0-9]{1,9}", n["titulo"]):
            if w not in NO_TICKERS and w + "USDT" in listados and w not in n["monedas"]:
                n["monedas"].append(w)
    medidas = 0
    for n in todas:
        t = datetime.fromisoformat(n["t"])
        if n.get("reaccion") or ahora - t < timedelta(minutes=62) or ahora - t > timedelta(days=3) or medidas >= MAX_REACCIONES:
            continue
        par = next((m + "USDT" for m in n["monedas"] if m + "USDT" in listados), "BTCUSDT")
        try:
            n["reaccion"] = reaccion(par, t)
            medidas += 1
        except Exception as e:
            errores.append("reacción %s: %s" % (par, str(e)[:40]))
    os.makedirs(os.path.dirname(os.path.abspath(salida)), exist_ok=True)
    with open(salida, "w", encoding="utf-8") as f:
        json.dump({"actualizado": ahora.isoformat(timespec="seconds"), "fuentes": list(FEEDS), "errores": errores,
                   "noticias": todas[:900]}, f, ensure_ascii=False, separators=(",", ":"))
    print("%d noticias (%d nuevas reacciones medidas). Errores: %s" % (len(todas), medidas, "; ".join(errores) or "ninguno"))


if __name__ == "__main__":
    main()
