"""Mandar mensajes a Telegram con el bot del usuario (solo biblioteca estándar).

El token y el chat salen de las variables de entorno TELEGRAM_TOKEN y TELEGRAM_CHAT_ID (en GitHub son "secrets").
Si faltan, no se manda nada y no falla. Nunca se imprimen ni el token ni el chat (los registros de Actions se ven).
"""
import json
import os
import urllib.parse
import urllib.request


def configurado():
    return bool(os.environ.get("TELEGRAM_TOKEN") and os.environ.get("TELEGRAM_CHAT_ID"))


def esc(texto):
    return str(texto).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def enviar(html):
    """Manda un mensaje con formato HTML. Devuelve True si salió."""
    if not configurado():
        return False
    datos = urllib.parse.urlencode({"chat_id": os.environ["TELEGRAM_CHAT_ID"], "text": html, "parse_mode": "HTML",
                                    "disable_web_page_preview": "true"}).encode()
    url = "https://api.telegram.org/bot%s/sendMessage" % os.environ["TELEGRAM_TOKEN"]
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=datos), timeout=20) as r:
            return json.loads(r.read()).get("ok", False)
    except Exception as e:
        print("Telegram no aceptó el mensaje:", type(e).__name__)  # sin detalles: la URL lleva el token
        return False
