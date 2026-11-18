# Revisor de seguridad, PASO 0 (18/11/2026): medir velocidad y calibrar filtros gratuitos en CPU sobre contenido real.
# Diseño: tenedor-cf-ig/docs/contenido-panel-y-revisor-diseno-v2.md (punto 3) + auditoría r2 de Roberto (R1 y R4).
#   - Muestra: N videos visibles con copia propia (videos_copia → media.tenedor.com.ar/videos-ig/…) y N fotos visibles
#     con copia propia (publicaciones tipo foto → media.tenedor.com.ar/fotos-ig/…). Sólo LECTURA de D1 (nada se escribe).
#   - Videos: 1 cuadro cada 2 s, hasta 10, lado corto 448 px. Foto: 1 cuadro (lado corto 448 px si es más grande).
#   - Filtros: (a) NudeNet (320n y, si se puede bajar, 640m); (b) CLIP zero-shot multi-etiqueta (open_clip) con
#     categorías sexual / violencia / armas / drogas / odio contra etiquetas negativas gastronómicas.
#   - Calibración SIN material explícito: la muestra es toda gastronómica → todo lo que marque es falso positivo.
#     Los aciertos (positivos verdaderos) se validan con los conjuntos de evaluación públicos de cada modelo.
# R4 (repo público): el log sólo lleva contadores, tiempos e ids opacos (hash corto del id interno). Ni URLs, ni
# textos, ni descripciones. No se suben artefactos.
import argparse, hashlib, json, os, random, shutil, subprocess, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

ap = argparse.ArgumentParser()
ap.add_argument("--videos", type=int, default=300)
ap.add_argument("--fotos", type=int, default=300)
ap.add_argument("--clip", default="ViT-B-32:laion2b_s34b_b79k,ViT-B-16:laion2b_s34b_b88k")
args = ap.parse_args()

ENV = os.environ
TMP = "/tmp/p0"
shutil.rmtree(TMP, ignore_errors=True)
os.makedirs(TMP)
T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:7.1f}s]", *a, flush=True)


def opaco(i):
    return hashlib.sha256(str(i).encode()).hexdigest()[:10]


def d1(sql, params=()):
    url = f"https://api.cloudflare.com/client/v4/accounts/{ENV['CLOUDFLARE_ACCOUNT_ID']}/d1/database/{ENV['D1_APP_ID']}/query"
    body = json.dumps({"sql": sql, "params": list(params)}).encode()
    for intento in range(4):
        try:
            req = urllib.request.Request(url, body, {"authorization": f"Bearer {ENV['CLOUDFLARE_API_TOKEN']}", "content-type": "application/json"})
            j = json.load(urllib.request.urlopen(req, timeout=90))
            if j.get("success"):
                return j["result"][0]["results"]
        except Exception:
            pass
        time.sleep(3 * (intento + 1))
    raise SystemExit("D1 no responde")


# ---------- 1. Muestra (lectura liviana) ----------
# Sólo SELECT. Se pide un poco más para cubrir las descargas que fallen.
vids = d1(
    """SELECT c.publicacion_id AS id, c.url FROM videos_copia c JOIN publicaciones p ON p.id = c.publicacion_id
       JOIN restaurantes r ON r.id = p.restaurante_id
       WHERE p.oculta = 0 AND p.tipo = 'video' AND r.estado <> 'cerrado' ORDER BY random() LIMIT ?""",
    (int(args.videos * 1.25),),
)
fots = d1(
    """SELECT p.id, p.media_url AS url FROM publicaciones p JOIN restaurantes r ON r.id = p.restaurante_id
       WHERE p.oculta = 0 AND p.tipo = 'foto' AND r.estado <> 'cerrado'
         AND p.media_url LIKE 'https://media.tenedor.com.ar/fotos-ig/%' ORDER BY random() LIMIT ?""",
    (int(args.fotos * 1.25),),
)
# La copia vieja figura con datos.tenedor.com.ar (Hostinger, ya no responde); la misma ruta vive en R2 (media.).
for v in vids:
    v["url"] = str(v["url"]).replace("https://datos.tenedor.com.ar/", "https://media.tenedor.com.ar/")
log(f"muestra pedida: videos {len(vids)} · fotos {len(fots)}")

# ---------- 2. Cuadros ----------
ESCALA = "scale='if(gt(iw,ih),-2,min(448,iw))':'if(gt(iw,ih),min(448,ih),-2)'"
ESCALA_448 = "scale='if(gt(iw,ih),-2,448)':'if(gt(iw,ih),448,-2)'"


def cuadros_video(k, v):
    pre = f"{TMP}/v{k:04d}_"
    t = time.time()
    try:
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-t", "20", "-i", v["url"], "-vf", f"fps=0.5,{ESCALA_448}", "-frames:v", "10", "-q:v", "3", pre + "%02d.jpg"],
            timeout=120, capture_output=True,
        )
    except Exception:
        pass
    fs = sorted(f"{TMP}/{f}" for f in os.listdir(TMP) if f.startswith(f"v{k:04d}_"))
    return {"tipo": "video", "id": v["id"], "cuadros": fs, "seg": time.time() - t}


def cuadro_foto(k, f):
    out = f"{TMP}/f{k:04d}_01.jpg"
    t = time.time()
    try:
        crudo = f"{TMP}/f{k:04d}_crudo"
        req = urllib.request.Request(f["url"], headers={"user-agent": "tenedor-revisor/0"})
        with urllib.request.urlopen(req, timeout=60) as r, open(crudo, "wb") as w:
            w.write(r.read())
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", crudo, "-vf", ESCALA, "-frames:v", "1", "-q:v", "3", out], timeout=60, capture_output=True)
        os.remove(crudo)
    except Exception:
        pass
    return {"tipo": "foto", "id": f["id"], "cuadros": [out] if os.path.exists(out) else [], "seg": time.time() - t}


t = time.time()
with ThreadPoolExecutor(8) as ex:
    rv = list(ex.map(lambda kv: cuadros_video(*kv), enumerate(vids)))
t_videos = time.time() - t
t = time.time()
with ThreadPoolExecutor(8) as ex:
    rf = list(ex.map(lambda kv: cuadro_foto(*kv), enumerate(fots)))
t_fotos = time.time() - t
items = [x for x in rv if x["cuadros"]][: args.videos] + [x for x in rf if x["cuadros"]][: args.fotos]
nv = sum(1 for x in items if x["tipo"] == "video")
nf = len(items) - nv
cuadros = [c for x in items for c in x["cuadros"]]
ext = {
    "videos_ok": nv, "videos_fallidos": sum(1 for x in rv if not x["cuadros"]),
    "fotos_ok": nf, "fotos_fallidas": sum(1 for x in rf if not x["cuadros"]),
    "cuadros_total": len(cuadros), "cuadros_por_video": round(sum(len(x["cuadros"]) for x in items if x["tipo"] == "video") / max(nv, 1), 2),
    "extraccion_videos_s_8hilos": round(t_videos, 1), "extraccion_fotos_s_8hilos": round(t_fotos, 1),
    "seg_por_video_1hilo": round(sum(x["seg"] for x in rv) / max(len(rv), 1), 2),
    "seg_por_foto_1hilo": round(sum(x["seg"] for x in rf) / max(len(rf), 1), 2),
}
dist = {}
for x in items:
    if x["tipo"] == "video":
        dist[len(x["cuadros"])] = dist.get(len(x["cuadros"]), 0) + 1
ext["dist_cuadros_por_video"] = dict(sorted(dist.items()))
log("EXTRACCION " + json.dumps(ext))
idx = {c: i for i, x in enumerate(items) for c in x["cuadros"]}

UMBRALES = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]


def calibrar(nombre, puntajes, minimo=1):
    """puntajes: {categoria: [puntaje por cuadro, en el orden de `cuadros`]}. Un ítem se marca si CUALQUIER cuadro supera."""
    out = {}
    for cat, ps in puntajes.items():
        por_cuadro = [[] for _ in items]
        for c, p in zip(cuadros, ps):
            por_cuadro[idx[c]].append(p)
        # puntaje del ítem = el «minimo»-ésimo cuadro más alto (1 = el máximo); una foto usa siempre su único cuadro
        por_item = [sorted(l, reverse=True)[min(minimo, len(l)) - 1] if l else 0.0 for l in por_cuadro]
        fila = {}
        for u in UMBRALES:
            mv = sum(1 for i, x in enumerate(items) if x["tipo"] == "video" and por_item[i] >= u)
            mf = sum(1 for i, x in enumerate(items) if x["tipo"] == "foto" and por_item[i] >= u)
            fila[str(u)] = {"videos": mv, "fotos": mf, "pct": round(100 * (mv + mf) / max(len(items), 1), 2)}
        orden = sorted(por_item)
        fila["p50"] = round(orden[len(orden) // 2], 3)
        fila["p99"] = round(orden[min(len(orden) - 1, int(len(orden) * 0.99))], 3)
        fila["max"] = round(orden[-1], 3)
        # ids opacos de los 3 ítems con puntaje más alto (para mirarlos a mano fuera del log)
        fila["top"] = [opaco(items[i]["id"]) for i in sorted(range(len(items)), key=lambda i: -por_item[i])[:3]]
        out[cat] = fila
    log(f"CALIBRACION {nombre} " + json.dumps(out))
    return out


resultado = {"extraccion": ext, "filtros": {}}

# ---------- 3a. NudeNet ----------
EXPUESTO = {"FEMALE_GENITALIA_EXPOSED", "MALE_GENITALIA_EXPOSED", "FEMALE_BREAST_EXPOSED", "ANUS_EXPOSED", "BUTTOCKS_EXPOSED"}
CUBIERTO = {"FEMALE_GENITALIA_COVERED", "FEMALE_BREAST_COVERED", "BUTTOCKS_COVERED", "ANUS_COVERED"}
try:
    from nudenet import NudeDetector

    # 18/11, corrida 1: el 640m de la página de versiones no se pudo leer (InvalidProtobuf); queda el 320n que trae el paquete.
    variantes = [("nudenet-320n", {})]
    for nombre, kw in variantes:
        try:
            det = NudeDetector(**kw)
        except TypeError:
            det = NudeDetector()
        det.detect(cuadros[0])  # calentar
        expu, cubi = [], []
        t = time.time()
        for c in cuadros:
            r = det.detect(c)
            expu.append(max([d["score"] for d in r if d["class"] in EXPUESTO] or [0.0]))
            cubi.append(max([d["score"] for d in r if d["class"] in CUBIERTO] or [0.0]))
        seg = time.time() - t
        vel = {"cuadros": len(cuadros), "seg": round(seg, 1), "cuadros_por_min": round(60 * len(cuadros) / seg, 1)}
        log(f"VELOCIDAD {nombre} " + json.dumps(vel))
        resultado["filtros"][nombre] = {"velocidad": vel, "calibracion": calibrar(nombre, {"desnudez_expuesta": expu, "ropa_interior_o_cubierto": cubi})}
except Exception as e:
    log("NudeNet falló:", type(e).__name__, str(e)[:120])

# ---------- 3b. CLIP zero-shot multi-etiqueta ----------
CATEGORIAS = {
    "sexual_desnudez": ["a photo of a naked person", "explicit nudity", "a pornographic image", "a person showing their genitals", "a topless woman with bare breasts", "people having sex"],
    "violencia_sangre_herida": ["a bloody wound on a person's body", "an injured person bleeding", "a violent fight between people", "a dead human body", "graphic gore with human blood", "a person being beaten"],
    "armas": ["a person holding a gun", "a handgun", "a rifle or assault weapon", "a gun pointed at the camera", "a person threatening someone with a knife", "ammunition and firearms"],
    "drogas": ["lines of cocaine on a table", "a person smoking a marijuana joint", "a syringe injecting drugs", "illegal drug pills and powder", "marijuana buds and cannabis plants", "a bag of white powder drugs"],
    "odio": ["a nazi swastika", "a hate symbol", "a ku klux klan hood", "people doing a nazi salute", "a white supremacist flag", "racist graffiti"],
}
NEGATIVOS = [
    # pedidos explícitamente (casos límite gastronómicos)
    "raw meat on a cutting board", "a raw cut of beef", "a grill knife next to an asado", "a cocktail drink", "red tomato sauce",
    "a person on a summer terrace", "a chef chopping with a cleaver",
    # resto del rubro
    "a plate of food", "a glass of red wine", "a restaurant interior", "people eating at a restaurant", "a restaurant storefront",
    "a dessert", "a menu or a text sign", "a barbecue grill with smoke", "a bartender making drinks", "a pizza", "a burger",
    "a person smiling at the camera", "a glass of beer", "ice cream", "sushi", "a cook in a kitchen", "a coffee cup", "pasta",
    "a woman in a summer dress", "a man without a shirt at the beach", "red wine spilled", "a bloody mary cocktail", "chorizo and sausages on a grill",
    "a promotional flyer", "a live music show at a bar", "a dj at a party", "people dancing at a bar",
    # 18/11, corrida 2: lo que más marcaba en la corrida 1 eran cuadros de video con gente, noche y texto.
    "a close-up of a person's face", "hands holding food", "a group of friends at a bar", "a dark nightclub with colored lights",
    "white text on a colored background", "a woman taking a selfie", "a chef plating food", "a couple at a restaurant table",
    "flames on a grill", "a city street", "a blurry photo", "a black screen", "a waiter serving a table", "a kitchen with cooks",
    "a logo", "a person drinking", "a glass of whisky", "a tattooed arm", "a woman in a bikini at a pool",
]
try:
    import torch, open_clip
    from PIL import Image

    torch.set_num_threads(os.cpu_count() or 4)
    for esp in args.clip.split(","):
        arq, pesos = esp.split(":")
        nombre = f"clip-{arq}"
        try:
            modelo, _, prep = open_clip.create_model_and_transforms(arq, pretrained=pesos)
            tok = open_clip.get_tokenizer(arq)
            modelo.eval()
            textos = [p for ps in CATEGORIAS.values() for p in ps] + NEGATIVOS
            with torch.no_grad():
                te = modelo.encode_text(tok(textos))
                te = te / te.norm(dim=-1, keepdim=True)
            escala = modelo.logit_scale.exp().item()
            emb = []
            t = time.time()
            with torch.no_grad():
                for i in range(0, len(cuadros), 16):
                    lote = torch.stack([prep(Image.open(c).convert("RGB")) for c in cuadros[i : i + 16]])
                    e = modelo.encode_image(lote)
                    emb.append(e / e.norm(dim=-1, keepdim=True))
            seg = time.time() - t
            emb = torch.cat(emb)
            logits = escala * emb @ te.T
            nneg = len(NEGATIVOS)
            neg = logits[:, -nneg:]
            npos = logits.shape[1] - nneg
            conj = logits.softmax(dim=1)  # softmax conjunta: categorías y negativos compiten todos juntos
            variantes_p = {"binaria": {}, "conjunta": {}}
            j = 0
            for cat, ps in CATEGORIAS.items():
                pos = logits[:, j : j + len(ps)]
                # binaria (corrida 1): las etiquetas de la categoría contra las gastronómicas, sin las otras categorías
                variantes_p["binaria"][cat] = torch.cat([pos, neg], dim=1).softmax(dim=1)[:, : len(ps)].sum(dim=1).tolist()
                variantes_p["conjunta"][cat] = conj[:, j : j + len(ps)].sum(dim=1).tolist()
                j += len(ps)
            vel = {"cuadros": len(cuadros), "seg": round(seg, 1), "cuadros_por_min": round(60 * len(cuadros) / seg, 1)}
            log(f"VELOCIDAD {nombre} " + json.dumps(vel))
            cal = {}
            for var, punt in variantes_p.items():
                cal[var] = calibrar(f"{nombre}-{var}", punt)
                cual = [max(v) for v in zip(*punt.values())]
                cal[var].update(calibrar(f"{nombre}-{var}-cualquiera", {"cualquier_categoria": cual}))
                # informativo: un video se marca sólo si 2 cuadros o más superan el umbral (una foto, con 1)
                cal[var + "-2cuadros"] = calibrar(f"{nombre}-{var}-2cuadros", {"cualquier_categoria": cual}, minimo=2)
            resultado["filtros"][nombre] = {"velocidad": vel, "calibracion": cal}
            del modelo
        except Exception as e:
            log(f"{nombre} falló:", type(e).__name__, str(e)[:160])
except Exception as e:
    log("CLIP falló:", type(e).__name__, str(e)[:160])

resultado["cpu"] = os.cpu_count()
resultado["minutos_total"] = round((time.time() - T0) / 60, 1)
print("RESULTADO_JSON " + json.dumps(resultado), flush=True)
shutil.rmtree(TMP, ignore_errors=True)
